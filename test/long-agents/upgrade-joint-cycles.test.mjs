import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getChatHomePaths } from "../../src/chat-home.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { migrateAgentHomeNormalization } from "../../src/migrations/agent-home-normalization.ts";
import { migrateLegacyProjectLayout } from "../../src/migrations/project-layout-v1.ts";
import { ensureAgentHomeProject, openProject, readProjectRegistry } from "../../src/projects/registry.ts";
import {
  readLongAgentRegistry,
  readLongAgentState,
  updateLongAgentState,
} from "../../src/long-agents/storage.ts";
import { ensureProjectLongAgent, projectLongAgentId } from "../../src/long-agents/project-agent.ts";
import { readChatSession, requireChatSession } from "../../src/session-read-model.ts";
import {
  createConversation,
  readConversation,
  resolveParticipationScope,
  updateConversation,
  bindParticipationSession,
} from "../../src/long-agents/conversations/service.ts";
import { findConversation } from "../../src/long-agents/conversations/storage.ts";
import { readConversationPublicMessages } from "../../src/long-agents/conversations/publication.ts";

const stamp = "2026-09-01T00:00:00.000Z";
const definition = { schemaVersion: 1, id: "friend", name: "Friend", description: "Test", systemPrompt: { mode: "pi-default" }, customInstructions: [], tools: { mode: "pi-default" }, resources: { mode: "inherit" } };

/** A genuinely legacy Home: pre-split registry, legacy daily projects, old state, old `.chat` layout. */
async function legacyFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chat-la6-c-upgrade-")));
  const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const own = await ensureAgentHomeProject("friend", "Friend", home);
  const legacyRegistry = {
    schemaVersion: 1,
    instances: [{ id: "local", name: "Local", gatewayBaseUrl: "http://127.0.0.1:1" }],
    agents: [{
      id: "friend", name: "Friend", description: "Test", enabled: true, instanceId: "local",
      nanoclawAgentGroupId: "group", defaultProjectId: "daily-friend", timeZone: "Asia/Shanghai", definition,
    }],
  };
  const projects = {};
  for (const id of ["daily-friend", "daily", "business"]) {
    const dir = path.join(home, "workspaces", id);
    fs.mkdirSync(dir, { recursive: true });
    projects[id] = await openProject({ path: dir, chatHome: home, id, name: id });
  }
  const session = (project, friend) => {
    const manager = SessionManager.create(project.cwd, project.sessionDir);
    manager.appendMessage({ role: "user", content: "preserve history", timestamp: Date.parse(stamp) });
    if (friend) manager.appendCustomEntry("chat.long_agent_turn", {
      schemaVersion: 1, turnId: "legacy-turn", longAgentId: "friend", bindingId: projectLongAgentId(project.projectId, "friend"),
      source: "chat-web", channelType: null, inboundEventId: null, agentGroupContext: null,
      status: "completed", startedAt: stamp, completedAt: stamp, error: null,
    });
    manager.flush();
    return manager;
  };
  const old = session(projects["daily-friend"], true);
  const business = session(projects.business, true);
  const records = [["daily-friend", old], ["business", business]].map(([id, manager]) => ({
    id: projectLongAgentId(id, "friend"), projectId: id, longAgentId: "friend",
    primarySessionId: manager.getSessionId(), status: "active", createdAt: stamp, updatedAt: stamp,
  }));
  await updateLongAgentState(home, (state) => ({
    state: {
      ...state,
      projectAgents: records,
      bindings: records.map((record, index) => ({
        id: `binding-${String(index)}`, projectLongAgentId: record.id, nanoclawInstanceId: "local",
        nanoclawAgentGroupId: "group", nanoclawSessionId: `nano-${String(index)}`,
        primaryMessagingGroupId: `mg-${String(index)}`,
        source: { channelType: "telegram", instance: "telegram", platformId: `user-${String(index)}`, threadId: null },
        createdAt: stamp, updatedAt: stamp,
      })),
    },
    result: undefined,
  }));
  // A legacy `.chat` project root for the project-layout migration.
  const legacyRoot = path.join(root, "legacy-workspace");
  fs.mkdirSync(path.join(legacyRoot, ".chat", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, ".chat", "project.json"), JSON.stringify({ schemaVersion: 1, id: "legacy", name: "Legacy", description: "" }));
  fs.writeFileSync(path.join(legacyRoot, ".chat", "sessions", "legacy.jsonl"), "{}\n");
  // Write historical bytes last: current writers deliberately normalize their inputs.
  const paths = getChatHomePaths(home);
  fs.writeFileSync(paths.longAgentRegistryPath, JSON.stringify(legacyRegistry));
  const currentState = JSON.parse(fs.readFileSync(paths.longAgentStatePath, "utf8"));
  fs.writeFileSync(paths.longAgentStatePath, JSON.stringify({
    schemaVersion: 3, projectAgents: currentState.projectAgents, bindings: currentState.bindings,
    pendingEvents: [], processedEvents: [],
  }));
  assert.equal(JSON.parse(fs.readFileSync(paths.longAgentRegistryPath, "utf8")).agents[0].definition.id, "friend");
  assert.equal(fs.existsSync(path.join(home, "long-agents/friend/definition.json")), false);
  assert.equal(JSON.parse(fs.readFileSync(paths.longAgentStatePath, "utf8")).schemaVersion, 3);
  return { root, home, own, projects, old, business, legacyRoot, definition };
}

const groupSnapshot = (conversation) => ({
  storageProjectId: conversation.storageProjectId,
  collaborationProjectId: conversation.collaborationProjectId,
  members: conversation.members.map((member) => ({ id: member.longAgentId, epoch: member.participationEpoch, revokedAt: member.revokedAt, grants: member.grants })),
  authorizationRevision: conversation.authorizationRevision,
  policy: conversation.policy,
});

test("LA6 C: three upgrade read/write cycles keep ownership, references and authorization unchanged", async (t) => {
  const f = await legacyFixture(t);
  const oldBytes = fs.readFileSync(f.old.getSessionFile());
  const legacySessionId = f.old.getSessionId();
  let conversation = null;
  let previousRevision = 0;

  for (let cycle = 1; cycle <= 3; cycle += 1) {
    // Read before migrating: an old-schema group record (no collaborationProjectId) must still resolve.
    if (cycle === 1) {
      conversation = await createConversation({
        chatHome: f.home, storageProjectId: "business", title: "升级小组", requestId: "req-upgrade",
        memberLongAgentIds: ["friend"],
      });
      // Simulate the pre-LA6-A record shape: the field did not exist yet.
      const file = path.join(f.home, "projects", "business", "conversations.json");
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      delete raw.conversations[0].collaborationProjectId;
      fs.writeFileSync(file, JSON.stringify(raw));
      const reRead = await readConversation(f.home, "business", conversation.id);
      assert.equal(reRead.collaborationProjectId, null, "a legacy record parses to the unset collaboration target");
      conversation = reRead;
      assert.equal((await findConversation(f.home, conversation.id)).storageProjectId, "business");
    }
    // Group creation may invoke registry reads; migration evidence is asserted on disk, not inferred.
    const splitSource = path.join(f.home, "runtime/migrations/long-agent-definition-split");
    assert.equal(fs.existsSync(path.join(f.home, "long-agents/friend/definition.json")), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(splitSource, "done.json"), "utf8")).migratedAgents, ["friend"]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(splitSource, "long-agents.json.bak"), "utf8")).agents[0].definition.id, "friend");
    const preMigration = groupSnapshot(await readConversation(f.home, "business", conversation.id));

    // Alternation: run both real migrations, then re-read.
    await migrateLegacyProjectLayout({ projectRoot: f.legacyRoot, chatHome: f.home });
    await migrateAgentHomeNormalization(f.home);
    assert.equal(JSON.parse(fs.readFileSync(getChatHomePaths(f.home).longAgentStatePath, "utf8")).schemaVersion, 5);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, "runtime/migrations/long-agent-work-v5/source.json"), "utf8")).schemaVersion, 3);
    const postMigration = groupSnapshot(await readConversation(f.home, "business", conversation.id));
    assert.deepEqual(postMigration, preMigration, `migration cycle ${String(cycle)} must not change group ownership or authorization`);

    // Ownership and old history survive; the native file is never rewritten.
    const registry = await readLongAgentRegistry(f.home);
    assert.equal(registry.agents[0].defaultProjectId, "friend");
    assert.deepEqual(registry.agents[0].definition.tools, f.definition.tools, "migration must not widen Agent tools");
    const view = await requireChatSession(legacySessionId, "daily-friend", f.home);
    assert.equal(view.owner.longAgentId, "friend");
    assert.equal(view.readOnly, true);
    assert.deepEqual(fs.readFileSync(view.path), oldBytes);
    assert.equal((await readProjectRegistry(f.home)).projects.some((project) => project.projectId === "daily-friend"), true, "the legacy project stays registered");

    // A real new write on top of the migrated data: CAS rename (not an authorization change).
    const renamed = await updateConversation({
      chatHome: f.home, storageProjectId: "business", conversationId: conversation.id,
      expectedRevision: conversation.revision, title: `升级小组 v${String(cycle)}`,
    });
    assert.equal(renamed.authorizationRevision, conversation.authorizationRevision, "a title change is not an authorization change");
    assert.ok(renamed.revision > previousRevision);
    previousRevision = renamed.revision;
    conversation = renamed;
  }

  // The group still enforces default-deny after three upgrade cycles.
  const bound = await bindParticipationSession({ chatHome: f.home, storageProjectId: "business", conversationId: conversation.id, longAgentId: "friend" });
  const resolved = await resolveParticipationScope({ chatHome: f.home, storageProjectId: "business", conversationId: conversation.id, longAgentId: "friend", sessionId: bound.sessionId });
  assert.deepEqual(resolved.scope.allowedTools, { systemToolAddresses: [], nativeTools: [], extensionTools: [] });
  assert.equal((await readConversationPublicMessages({ chatHome: f.home, storageProjectId: "business", conversationId: conversation.id, viewerLongAgentId: null })).length, 0);
});

test("LA6 C: a conflicting upgrade preserves originals, stays incomplete, and can be retried", async (t) => {
  const f = await legacyFixture(t);
  const oldBytes = fs.readFileSync(f.old.getSessionFile());
  // A real conflict: the normalized target already exists with different content.
  fs.writeFileSync(path.join(f.projects["daily-friend"].cwd, "notes.md"), "old note");
  fs.writeFileSync(path.join(f.own.cwd, "notes.md"), "current note");
  await assert.rejects(migrateAgentHomeNormalization(f.home), /冲突/);
  assert.equal(fs.readFileSync(path.join(f.projects["daily-friend"].cwd, "notes.md"), "utf8"), "old note");
  assert.equal(fs.readFileSync(path.join(f.own.cwd, "notes.md"), "utf8"), "current note");
  assert.equal(fs.existsSync(path.join(f.home, "runtime/migrations/agent-home-normalization/done-v2.json")), false, "a failed upgrade writes no completion marker");
  assert.deepEqual(fs.readFileSync(f.old.getSessionFile()), oldBytes);
  // Repair and retry: the upgrade completes without losing either file.
  fs.renameSync(path.join(f.own.cwd, "notes.md"), path.join(f.own.cwd, "notes-reviewed.md"));
  await migrateAgentHomeNormalization(f.home);
  assert.equal(fs.readFileSync(path.join(f.own.cwd, "notes.md"), "utf8"), "old note");
  assert.equal(fs.readFileSync(path.join(f.own.cwd, "notes-reviewed.md"), "utf8"), "current note");
  const view = await readChatSession(f.old.getSessionId(), undefined, {}, "daily-friend", f.home);
  assert.equal(view.session.owner.longAgentId, "friend");
  assert.equal(view.session.readOnly, true);
  // The same migration run is now idempotent.
  assert.equal(await migrateAgentHomeNormalization(f.home), null);
});

test("LA6 C: a legacy state upgrade keeps channel bindings and keeps old history read-only next to a new day", async (t) => {
  const f = await legacyFixture(t);
  const before = await readLongAgentState(f.home);
  await migrateAgentHomeNormalization(f.home);
  const after = await readLongAgentState(f.home);
  assert.deepEqual(after.bindings.map((binding) => binding.nanoclawSessionId), before.bindings.map((binding) => binding.nanoclawSessionId));
  assert.deepEqual(after.bindings.map((binding) => binding.source), before.bindings.map((binding) => binding.source));
  assert.equal(after.projectAgents.length, before.projectAgents.length);
  assert.equal(after.dailySessions.length, 0, "the upgrade does not open an idle day");
  // The legacy history stays readable read-only, and a fresh day never reuses it.
  const legacyView = await readChatSession(f.old.getSessionId(), undefined, {}, "daily-friend", f.home);
  assert.equal(legacyView.session.owner.longAgentId, "friend");
  assert.equal(legacyView.session.readOnly, true);
  assert.equal(legacyView.context.messages[0].content, "preserve history");
  const agent = (await readLongAgentRegistry(f.home)).agents[0];
  const day = await ensureProjectLongAgent({ chatHome: f.home, projectId: "friend", agent });
  assert.notEqual(day.day.sessionId, f.old.getSessionId(), "a new day is not the legacy history");
  await migrateAgentHomeNormalization(f.home);
  assert.equal((await readChatSession(f.old.getSessionId(), undefined, {}, "daily-friend", f.home)).session.readOnly, true);
});

test("LA6 C: an unsupported downgrade fails closed instead of reinterpreting newer data", async (t) => {
  const f = await legacyFixture(t);
  const stateFile = path.join(f.home, "runtime", "long-agent-state.json");
  const original = fs.readFileSync(stateFile);
  fs.writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(original.toString()), schemaVersion: 6 }));
  await assert.rejects(readLongAgentState(f.home), /schemaVersion (5|${String(5)})/);
  assert.deepEqual(fs.readFileSync(stateFile), Buffer.from(JSON.stringify({ ...JSON.parse(original.toString()), schemaVersion: 6 })), "a rejected downgrade leaves the newer state untouched");
  fs.writeFileSync(stateFile, original);

  const marker = path.join(f.home, "runtime/migrations/agent-home-normalization/done-v2.json");
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ schemaVersion: 3, completedAt: stamp, migratedAgents: [], sessions: [], previousVersion: null }));
  const { readLegacyFriendSessions } = await import("../../src/migrations/agent-home-normalization.ts");
  await assert.rejects(readLegacyFriendSessions(f.home), /Friend迁移记录无效/);
  assert.deepEqual(fs.readFileSync(marker), Buffer.from(JSON.stringify({ schemaVersion: 3, completedAt: stamp, migratedAgents: [], sessions: [], previousVersion: null })));
});

test("LA6 C: re-running an already-normalized Home without the marker never partially remaps history", async (t) => {
  const f = await legacyFixture(t);
  await migrateAgentHomeNormalization(f.home);
  const normalized = await readLongAgentState(f.home);
  const beforeView = await requireChatSession(f.old.getSessionId(), "daily-friend", f.home);
  const oldBytes = fs.readFileSync(beforeView.path);
  // Removing the completion marker is not a supported downgrade; a re-run must not remap normalized
  // data differently, and native history/bindings must stay byte-identical.
  fs.rmSync(path.join(f.home, "runtime/migrations/agent-home-normalization/done-v2.json"), { force: true });
  await migrateAgentHomeNormalization(f.home).catch(() => undefined);
  const view = await requireChatSession(f.old.getSessionId(), "daily-friend", f.home);
  assert.equal(view.owner.longAgentId, "friend");
  assert.equal(view.readOnly, true);
  assert.deepEqual(fs.readFileSync(view.path), oldBytes);
  const after = await readLongAgentState(f.home);
  assert.deepEqual(after.bindings.map((binding) => binding.nanoclawSessionId), normalized.bindings.map((binding) => binding.nanoclawSessionId));
  assert.deepEqual(after.bindings.map((binding) => binding.source), normalized.bindings.map((binding) => binding.source));
});
