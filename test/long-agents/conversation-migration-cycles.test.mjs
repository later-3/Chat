import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openProject } from "../../src/projects/registry.ts";
import { readLongAgentRegistry, writeLongAgentRegistry } from "../../src/long-agents/storage.ts";
import { migrateAgentHomeNormalization } from "../../src/migrations/agent-home-normalization.ts";
import { migrateLegacyProjectLayout } from "../../src/migrations/project-layout-v1.ts";
import {
  bindParticipationSession,
  createConversation,
  readConversation,
  setMemberGrants,
} from "../../src/long-agents/conversations/service.ts";
import {
  queueSpeechAttempt,
  readDiscussionState,
  startConversationDiscussion,
} from "../../src/long-agents/conversations/discussions.ts";

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chat-la5-migration-")));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "RULE_MIGRATION\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await openProject({ path: workspace, chatHome: home, id: "a", name: "a" });
  const first = {
    id: "friend", name: "Friend", description: "Stable", enabled: true, timeZone: "Asia/Shanghai", instanceId: "local",
    nanoclawAgentGroupId: "group-friend", defaultProjectId: "friend",
    definition: {
      schemaVersion: 1, id: "friend", name: "Friend", description: "Stable",
      systemPrompt: { mode: "replace", text: "Stable Friend" }, customInstructions: [],
      tools: { mode: "explicit", names: [], exclude: [], addresses: [] },
      resources: { mode: "explicit", skillPaths: [], extensionPaths: [], pluginSources: [] },
    },
  };
  await writeLongAgentRegistry({
    schemaVersion: 1, instances: [{ id: "local", name: "Local", gatewayBaseUrl: "http://127.0.0.1:1" }],
    agents: [first, {
      ...first, id: "friend2", name: "Friend2", nanoclawAgentGroupId: "group-friend2", defaultProjectId: "friend2",
      definition: { ...first.definition, id: "friend2", name: "Friend2" },
    }],
  }, home);
  return { root, home, workspace };
}

test("V11: three migration read/write cycles keep group membership, ownership and authorization unchanged", async (t) => {
  const f = await fixture(t);
  const conversation = await createConversation({
    chatHome: f.home, storageProjectId: "a", title: "迁移小组", requestId: "req-v11",
    memberLongAgentIds: ["friend", "friend2"],
  });
  const bound = await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend" });
  const afterBind = await readConversation(f.home, "a", conversation.id);
  const granted = await setMemberGrants({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend",
    expectedRevision: afterBind.revision, grants: { systemToolAddresses: [], nativeTools: ["read"], extensionTools: [] },
  });
  await startConversationDiscussion({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, discussionId: "mig-root",
    policy: "mention", round: 1, inputCutoffEntryId: null, budget: granted.budget,
  });
  await queueSpeechAttempt({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id,
    attempt: {
      discussionId: "mig-root", attemptId: "mig-speech", policy: "mention", round: 1, speakerLongAgentId: "friend",
      participationEpoch: 1, inputCutoffEntryId: null, replyToEntryId: null, causationId: null,
      authorizationRevision: granted.authorizationRevision, instruction: "say", budget: granted.budget,
    },
  });
  const snapshot = await readConversation(f.home, "a", conversation.id);
  const conversationsFile = path.join(f.home, "projects", "a", "conversations.json");
  const bytesBefore = fs.readFileSync(conversationsFile);
  const discussionsBefore = (await readDiscussionState(f.home, "a", conversation.id)).discussions.map((item) => item.discussionId);

  for (let cycle = 1; cycle <= 3; cycle += 1) {
    // Read/write alternation: run both migrations, then re-read the group record.
    await migrateLegacyProjectLayout({ projectRoot: f.workspace, chatHome: f.home });
    await migrateAgentHomeNormalization(f.home);
    const after = await readConversation(f.home, "a", conversation.id);
    assert.equal(after.id, snapshot.id);
    assert.equal(after.storageProjectId, "a", "the migration never reassigns the storage Project");
    assert.equal(after.authorizationRevision, snapshot.authorizationRevision, `authorization changed in cycle ${String(cycle)}`);
    assert.equal(after.revision, snapshot.revision, `group revision changed in cycle ${String(cycle)}`);
    assert.deepEqual(after.members.map((member) => member.longAgentId), ["friend", "friend2"]);
    assert.deepEqual(
      after.members.find((member) => member.longAgentId === "friend").grants,
      { systemToolAddresses: [], nativeTools: ["read"], extensionTools: [] },
      "the migration must not widen member grants",
    );
    assert.equal(after.members.find((member) => member.longAgentId === "friend").sessionId, bound.sessionId);
    assert.deepEqual(
      (await readDiscussionState(f.home, "a", conversation.id)).discussions.map((item) => item.discussionId),
      discussionsBefore,
      "the migration never starts a discussion on its own",
    );
  }
  assert.deepEqual(fs.readFileSync(conversationsFile), bytesBefore, "a no-op migration leaves the group registry byte-identical");
  assert.ok((await readLongAgentRegistry(f.home)).agents.length >= 2);
});
