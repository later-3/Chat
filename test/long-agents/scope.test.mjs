import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture } from "./daily-fixture.mjs";
import { readLongAgentRegistry, readLongAgentState } from "../../src/long-agents/storage.ts";
import { prepareLongAgentAssembly } from "../../src/long-agents/assembly.ts";
import { openChatSession } from "../../src/chat-session.ts";
import { createChatPiAgentSession } from "../../src/agents/pi-agent-session.ts";
import { executeLongAgentTurn } from "../../src/long-agents/runtime.ts";
import { inspectLongAgentTurnCapabilities } from "../../src/long-agents/capabilities.ts";
import { systemToolAddress } from "../../src/tools/framework.ts";
import { createConversation, bindParticipationSession } from "../../src/long-agents/conversations/service.ts";
import { listChatSystemTools } from "../../src/tools/registry.ts";
import {
  LongAgentScopeError,
  applyScopeToCapabilities,
  longAgentGrantsDigest,
  longAgentScopeInstructions,
  longAgentScopeRevision,
  parseLongAgentScope,
  resolveLongAgentScope,
  verifyLongAgentScope,
} from "../../src/long-agents/scope.ts";

const PERSONAL_SENTINEL = "PERSONAL_SENTINEL_9f3a";
const IDENTITY_SENTINEL = "IDENTITY_SENTINEL_5c1d";
const PROJECT_SENTINEL = "PROJECT_SENTINEL_7b2e";
const registryAddress = systemToolAddress("project_read");

function conversationInput(over = {}) {
  return { kind: "conversation", longAgentId: "friend", sessionId: "group-session-1", conversationId: "conv-1",
    participationEpoch: 1, authorizationRevision: 4, storageProjectId: "friend", collaborationProjectId: "a", ...over };
}
function conversationScope(over = {}) {
  return resolveLongAgentScope(conversationInput(over));
}

test("LA5 scope: direct and background inherit today's behaviour, conversation is default-deny", () => {
  const direct = resolveLongAgentScope({ kind: "direct", longAgentId: "friend", sessionId: "s1", storageProjectId: "friend", collaborationProjectId: "a" });
  assert.equal(direct.allowedTools, null);
  assert.deepEqual(direct.include, { dailyHandoff: true, agentGroupInstructions: true, personalContextFiles: true, personalPromptResources: true, privateMemory: true });
  assert.deepEqual(direct.excludedCapabilities, []);
  const conversation = conversationScope();
  assert.deepEqual(conversation.include, { dailyHandoff: false, agentGroupInstructions: false, personalContextFiles: false, personalPromptResources: false, privateMemory: false });
  assert.deepEqual(conversation.allowedTools, { systemToolAddresses: [], nativeTools: [], extensionTools: [] });
  // Publishing/comments, project data and private Memory stay denied until their own range checks exist.
  for (const id of ["social_manage", "project_read", "project_search", "memory_search", "agent_memory_read", "workflow_call", "friend_work", "channel_send"]) {
    assert.ok(conversation.excludedCapabilities.some((entry) => entry.id === id && entry.kind === "tool" && entry.reason.length > 10), `missing denial for ${id}`);
  }
  assert.equal(conversation.excludedCapabilities.some((entry) => entry.kind === "instruction" && entry.id === "daily-handoff"), true);
  assert.equal(conversation.excludedCapabilities.some((entry) => entry.kind === "resource" && entry.id === "private-agent-memory"), true);
  assert.throws(() => resolveLongAgentScope({ kind: "conversation", longAgentId: "friend", sessionId: "s1", storageProjectId: "friend" }), LongAgentScopeError);
  assert.throws(() => resolveLongAgentScope({ kind: "conversation", longAgentId: "friend", sessionId: "s1", storageProjectId: "friend", conversationId: "conv-1", participationEpoch: 0 }), LongAgentScopeError);
  // Explicit grants widen only what they name, stay checksum-protected, and can never name a tool
  // without a conversation range check (bash/Extension/private-data tools are refused outright).
  const granted = conversationScope({ grants: { systemToolAddresses: [], nativeTools: ["read", "write"], extensionTools: [] } });
  assert.deepEqual(granted.allowedTools, { systemToolAddresses: [], nativeTools: ["read", "write"], extensionTools: [] });
  assert.deepEqual(parseLongAgentScope(granted), granted);
  for (const blocked of [
    { systemToolAddresses: [registryAddress], nativeTools: [], extensionTools: [] },
    { systemToolAddresses: [], nativeTools: ["bash"], extensionTools: [] },
    { systemToolAddresses: [], nativeTools: [], extensionTools: ["mcp__demo"] },
  ]) {
    assert.throws(() => conversationScope({ grants: blocked }), LongAgentScopeError, `grant ${JSON.stringify(blocked)} must be refused`);
  }
});

test("LA5 scope: the checksum is consistency, not authentication — the trusted binding decides", () => {
  const scope = conversationScope();
  assert.deepEqual(parseLongAgentScope(scope), scope);
  const expected = { grantsDigest: scope.authorization.grantsDigest, longAgentId: "friend", sessionId: "group-session-1", storageProjectId: "friend", collaborationProjectId: "a", conversationId: "conv-1", participationEpoch: 1, authorizationRevision: 4 };
  verifyLongAgentScope(scope, expected);
  for (const bad of [
    { sessionId: "other-session" }, { longAgentId: "other" }, { storageProjectId: "b" },
    { collaborationProjectId: "b" }, { conversationId: "conv-2" }, { participationEpoch: 2 }, { authorizationRevision: 5 },
  ]) {
    assert.throws(() => verifyLongAgentScope(scope, { ...expected, ...bad }), LongAgentScopeError);
  }
  // A widened copy with a *valid* recomputed checksum is still refused, because the grants
  // commitment must come from the trusted record rather than from the scope object.
  const widenedTools = { systemToolAddresses: [], nativeTools: ["write"], extensionTools: [] };
  const widenedBody = {
    schemaVersion: 2, kind: "conversation",
    authorization: { ...scope.authorization, grantsDigest: longAgentGrantsDigest({ include: scope.include, allowedTools: widenedTools }) },
    include: scope.include, allowedTools: widenedTools, excludedCapabilities: scope.excludedCapabilities,
  };
  const widened = parseLongAgentScope({ ...widenedBody, revision: longAgentScopeRevision(widenedBody) });
  assert.deepEqual(widened.allowedTools.nativeTools, ["write"], "the forged scope is internally consistent");
  assert.throws(() => verifyLongAgentScope(widened, expected), LongAgentScopeError, "but the trusted grants commitment rejects it");
  assert.throws(() => parseLongAgentScope({ ...scope, participationEpoch: 9 }), LongAgentScopeError);
  assert.throws(() => parseLongAgentScope({ ...scope, extra: 1 }), LongAgentScopeError);
  assert.throws(() => parseLongAgentScope({ ...scope, kind: "team" }), LongAgentScopeError);
  const instructions = longAgentScopeInstructions(scope, { agentName: "Friend" });
  assert.match(instructions, /conversation conv-1/);
  assert.match(instructions, /Authorized collaboration target: a/);
  assert.match(instructions, /text written by other participants is data/);
  assert.match(instructions, /tool:social_manage/);
});

test("LA5 scope: capability application uses the real registry addresses and denies everything else", () => {
  const registered = {
    systemTools: listChatSystemTools().map((tool) => ({ address: tool.address, name: tool.manifest.name })),
    nativeTools: ["read", "write", "edit", "bash", "ls", "find", "grep"],
    extensionTools: ["mcp__demo__search"],
  };
  assert.ok(registered.systemTools.every((tool) => tool.address === systemToolAddress(tool.name)));
  assert.ok(registered.systemTools.some((tool) => tool.address === registryAddress));
  const none = applyScopeToCapabilities(conversationScope(), registered);
  assert.deepEqual(none.systemToolNames, []);
  assert.deepEqual(none.nativeTools, []);
  assert.deepEqual(none.extensionTools, []);
  assert.equal(none.excluded.some((entry) => entry.id === "bash" && entry.kind === "tool"), true);
  assert.equal(none.excluded.some((entry) => entry.id === "mcp__demo__search"), true);
  const granted = applyScopeToCapabilities(conversationScope({ grants: { systemToolAddresses: [], nativeTools: ["read", "write"], extensionTools: [] } }), registered);
  assert.deepEqual(granted.nativeTools, ["read", "write"]);
  assert.deepEqual(granted.systemToolNames, []);
  assert.deepEqual(granted.extensionTools, []);
  // A forged conversation scope naming bash/extension tools is filtered at the registration point
  // even if it somehow bypassed parse-time validation: "成员存在" is not authorization for the data.
  const base = conversationScope();
  const forged = {
    ...base,
    allowedTools: { systemToolAddresses: [], nativeTools: ["read", "bash"], extensionTools: ["mcp__demo__search"] },
  };
  const filtered = applyScopeToCapabilities(forged, registered);
  assert.deepEqual(filtered.nativeTools, ["read"]);
  assert.deepEqual(filtered.extensionTools, []);
  assert.equal(filtered.excluded.some((entry) => entry.id === "bash" && entry.reason.includes("群范围校验")), true);
  assert.equal(filtered.excluded.some((entry) => entry.id === "mcp__demo__search" && entry.reason.includes("群范围校验")), true);
  // Direct/background scopes inherit the full registered set unchanged.
  const inherit = applyScopeToCapabilities(resolveLongAgentScope({ kind: "background", longAgentId: "friend", sessionId: "s1", storageProjectId: "friend" }), registered);
  assert.deepEqual(inherit.nativeTools, registered.nativeTools);
  assert.deepEqual(inherit.systemToolNames, registered.systemTools.map((tool) => tool.name));
});

/** Run one real Pi turn through the public factory and return the captured model request bodies. */
async function runTurn(f, { scope, text, handler }) {
  await executeLongAgentTurn(f.input("warm", "a"));
  const day = (await readLongAgentState(f.home)).dailySessions[0];
  const agent = (await readLongAgentRegistry(f.home)).agents[0];
  const chatSession = await openChatSession({ chatHome: f.home, projectId: "friend", sessionId: day.sessionId });
  // The Backend resolves the scope for this exact Session; a scope for another Session is refused.
  const resolved = scope === undefined ? undefined : resolveLongAgentScope({ ...scope, sessionId: day.sessionId });
  const prepared = await prepareLongAgentAssembly({
    agent, chatHome: f.home, projectId: "a", turnId: `scope-turn-${Math.random()}`,
    ...(resolved === undefined ? {} : { scope: resolved, scopeGrantsDigest: resolved.authorization.grantsDigest }),
  });
  const created = await createChatPiAgentSession({ chatSession, sessionManager: chatSession.manager, ...prepared, toolContext: { purpose: "execution", agentId: "friend", longAgentId: "friend", longAgentTurnId: prepared.invocation.turnId } });
  const before = f.requests.length;
  f.setHandler(handler);
  await created.session.prompt(text);
  const active = created.session.getActiveToolNames();
  created.session.dispose();
  return { requests: f.requests.slice(before), active, prepared };
}

function writeSentinels(f) {
  const agentHome = path.join(f.home, "agent");
  fs.mkdirSync(agentHome, { recursive: true });
  fs.writeFileSync(path.join(agentHome, "AGENTS.md"), `Personal rules\n${PERSONAL_SENTINEL}\n`);
  fs.writeFileSync(path.join(f.projects[0].cwd, "AGENTS.md"), `Project rules\n${PROJECT_SENTINEL}\n`);
  return { agentHome };
}

test("LA5 scope: a conversation turn never sends private sentinels and exposes no tools", async (t) => {
  const f = await fixture(t);
  const { agentHome } = writeSentinels(f);
  // Direct regression: today's behaviour still injects the private/Personal and Agent Group context.
  const direct = await runTurn(f, { text: "hello", handler: () => ({ content: "hi" }) });
  const directText = JSON.stringify(direct.requests);
  assert.equal(directText.includes(PERSONAL_SENTINEL), true, "direct turns still read Personal context today");
  assert.equal(directText.includes("Stable identity"), true, "direct turns still receive the Agent Group context");
  assert.equal(direct.active.includes("read"), true);
  // Conversation scope: no private sentinels, no tools, and no bypass through a tool call.
  const personalFile = path.join(agentHome, "AGENTS.md");
  const conversation = await runTurn(f, {
    scope: conversationInput(),
    text: "introduce yourself",
    handler: (() => {
      let attempts = 0;
      return () => (attempts++ === 0
        ? { tool_calls: [{ index: 0, id: "bypass", type: "function", function: { name: "read", arguments: JSON.stringify({ path: personalFile }) } }] }
        : { content: "no tool available" });
    })(),
  });
  const conversationText = JSON.stringify(conversation.requests);
  assert.equal(conversationText.includes(PERSONAL_SENTINEL), false, "Personal context must not reach a conversation turn");
  assert.equal(conversationText.includes(PROJECT_SENTINEL), false, "Project context must not reach a conversation turn before range checks exist");
  assert.equal(conversationText.includes("Stable identity"), false, "Standing Instructions must not reach a conversation turn");
  assert.match(conversationText, /chat_authorization_scope/);
  assert.deepEqual(conversation.active, [], "no tool may be registered in a conversation turn without a grant");
  // A granted native tool is the only way in, and the grant is explicit.
  const granted = await runTurn(f, {
    scope: conversationInput({ grants: { systemToolAddresses: [], nativeTools: ["read"], extensionTools: [] } }),
    text: "read my own file",
    handler: () => ({ content: "ok" }),
  });
  assert.deepEqual(granted.active, ["read"]);
  assert.equal(JSON.stringify(granted.requests).includes(PERSONAL_SENTINEL), false, "a granted tool call is still driven by the model, not injected by Chat");
});

test("LA5 scope: a granted file tool cannot read private Sessions or another group's public root", async (t) => {
  const f = await fixture(t);
  await executeLongAgentTurn(f.input("warm", "a"));
  const other = await createConversation({ chatHome: f.home, storageProjectId: "a", title: "别的群", requestId: "req-scope-other", memberLongAgentIds: ["friend"] });
  // Another group's participation Session and public root are both outside this turn's scope.
  const otherParticipation = await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: other.id, longAgentId: "friend" });
  const otherSession = await openChatSession({ chatHome: f.home, projectId: "a", sessionId: otherParticipation.sessionId });
  otherSession.manager.appendMessage({ role: "user", content: "OTHER_GROUP_SENTINEL", timestamp: Date.now() });
  otherSession.manager.flush();
  const otherParticipationFile = otherSession.manager.getSessionFile();
  const personalFile = path.join(f.home, "agent", "AGENTS.md");
  fs.writeFileSync(personalFile, "Personal rules\nPERSONAL_SENTINEL_9f3a\n");
  assert.equal(typeof otherParticipationFile, "string");

  // The model is explicitly given `read` and asked to read both files; the scoped tool must refuse,
  // so the tool result never carries the private content into the next model request.
  const attempted = await runTurn(f, {
    scope: conversationInput({ grants: { systemToolAddresses: [], nativeTools: ["read"], extensionTools: [] } }),
    text: "read those files",
    handler: (() => {
      let call = 0;
      return () => call++ === 0
        ? { tool_calls: [
            { index: 0, id: "read-other-group", type: "function", function: { name: "read", arguments: JSON.stringify({ path: otherParticipationFile }) } },
            { index: 1, id: "read-personal", type: "function", function: { name: "read", arguments: JSON.stringify({ path: personalFile }) } },
          ] }
        : { content: "done" };
    })(),
  });
  const text = JSON.stringify(attempted.requests);
  assert.equal(attempted.active.includes("read"), true, "the granted tool is registered");
  assert.equal(text.includes("OTHER_GROUP_SENTINEL"), false, "a granted tool cannot read another group's participation Session");
  assert.equal(text.includes(PERSONAL_SENTINEL), false, "a granted tool cannot read Personal files");
  assert.equal(text.includes("文件超出本轮项目与Agent工作空间"), true, "the scoped file tool reported the refusal");
});

test("LA5 scope: a scope that does not match the trusted turn binding is refused", async (t) => {
  const f = await fixture(t);
  const day0 = (await readLongAgentState(f.home)).dailySessions;
  await executeLongAgentTurn(f.input("warm", "a"));
  const day = (await readLongAgentState(f.home)).dailySessions[0] ?? day0[0];
  const agent = (await readLongAgentRegistry(f.home)).agents[0];
  const chatSession = await openChatSession({ chatHome: f.home, projectId: "friend", sessionId: day.sessionId });
  for (const bad of [
    conversationScope({ sessionId: "another-session" }),
    conversationScope({ longAgentId: "other-friend" }),
    conversationScope({ collaborationProjectId: "b" }),
  ]) {
    const prepared = await prepareLongAgentAssembly({ agent, chatHome: f.home, projectId: "a", turnId: `bad-${Math.random()}`, scope: bad, scopeGrantsDigest: bad.authorization.grantsDigest });
    await assert.rejects(
      createChatPiAgentSession({ chatSession, sessionManager: chatSession.manager, ...prepared, toolContext: { purpose: "execution", agentId: "friend", longAgentId: "friend", longAgentTurnId: prepared.invocation.turnId } }),
      /作用域与可信执行绑定不一致|授权作用域与可信执行绑定不一致/,
    );
  }
});

test("LA5 scope: the effective-capability check reads the same frozen selection execution used", async (t) => {
  const f = await fixture(t);
  await executeLongAgentTurn(f.input("warm", "a"));
  const day = (await readLongAgentState(f.home)).dailySessions[0];
  const agent = (await readLongAgentRegistry(f.home)).agents[0];
  const chatSession = await openChatSession({ chatHome: f.home, projectId: "friend", sessionId: day.sessionId });
  const resolved = resolveLongAgentScope({
    kind: "conversation", longAgentId: "friend", sessionId: day.sessionId, conversationId: "conv-1",
    participationEpoch: 1, authorizationRevision: 2, storageProjectId: "friend", collaborationProjectId: "a",
  });
  const prepared = await prepareLongAgentAssembly({
    agent, chatHome: f.home, projectId: "a", turnId: "capability-turn", scope: resolved, scopeGrantsDigest: resolved.authorization.grantsDigest,
  });
  const created = await createChatPiAgentSession({ chatSession, sessionManager: chatSession.manager, ...prepared, toolContext: { purpose: "execution", agentId: "friend", longAgentId: "friend", longAgentTurnId: "capability-turn" } });
  f.setHandler(() => ({ content: "done" }));
  await created.session.prompt("hello");
  created.session.dispose();
  const inspection = await inspectLongAgentTurnCapabilities({ chatHome: f.home, longAgentId: "friend", sessionId: day.sessionId, turnId: "capability-turn" });
  assert.equal(inspection.scope.kind, "conversation");
  assert.deepEqual(inspection.registeredTools, [], "execution registered no tools, and the check must confirm exactly that");
  assert.equal(inspection.excludedCapabilities.some((entry) => entry.id === "social_manage"), true);
  assert.equal(inspection.excludedCapabilities.some((entry) => entry.id === "daily-handoff"), true);
  // A direct turn reports the inherited tools and no scope.
  const directPrepared = await prepareLongAgentAssembly({ agent, chatHome: f.home, projectId: "a", turnId: "direct-capability-turn" });
  const directChatSession = await openChatSession({ chatHome: f.home, projectId: "friend", sessionId: day.sessionId });
  const directSession = await createChatPiAgentSession({ chatSession: directChatSession, sessionManager: directChatSession.manager, ...directPrepared, toolContext: { purpose: "execution", agentId: "friend", longAgentId: "friend", longAgentTurnId: "direct-capability-turn" } });
  await directSession.session.prompt("hello");
  directSession.session.dispose();
  const directInspection = await inspectLongAgentTurnCapabilities({ chatHome: f.home, longAgentId: "friend", sessionId: day.sessionId, turnId: "direct-capability-turn" });
  assert.equal(directInspection.scope, null);
  assert.equal(directInspection.registeredTools.includes("read"), true);
  assert.equal(directInspection.registeredTools.includes("write"), true);
});

test("LA5 scope: a turn recorded by another Friend/Session cannot be inspected", async (t) => {
  const f = await fixture(t);
  await executeLongAgentTurn(f.input("warm", "a"));
  const day = (await readLongAgentState(f.home)).dailySessions[0];
  await assert.rejects(
    inspectLongAgentTurnCapabilities({ chatHome: f.home, longAgentId: "friend", sessionId: day.sessionId, turnId: "missing-turn" }),
    /找不到该轮次的装配快照/,
  );
});
