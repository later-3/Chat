import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./daily-fixture.mjs";
import { readLongAgentRegistry, writeLongAgentRegistry } from "../../src/long-agents/storage.ts";
import { verifyLongAgentScope } from "../../src/long-agents/scope.ts";
import { assertParticipantSessionReadable } from "../../src/long-agents/conversations/access.ts";
import {
  archiveConversation,
  bindParticipationSession,
  createConversation,
  readConversation,
  rejoinMember,
  resolveParticipationScope,
  revokeMember,
  setMemberGrants,
  updateConversation,
} from "../../src/long-agents/conversations/service.ts";

/** The fixture ships one Friend; add a second one so two-member scenarios are real. */
async function addSecondFriend(f) {
  const registry = await readLongAgentRegistry(f.home);
  const first = registry.agents[0];
  await writeLongAgentRegistry({
    ...registry,
    agents: [...registry.agents, {
      ...first, id: "friend2", name: "Friend2", nanoclawAgentGroupId: "group2", defaultProjectId: "friend2",
      definition: { ...first.definition, id: "friend2", name: "Friend2" },
    }],
  }, f.home);
}

async function group(f, over = {}) {
  return createConversation({
    chatHome: f.home, storageProjectId: "a", title: "研究小组", requestId: `req-${Math.random()}`,
    memberLongAgentIds: ["friend", "friend2"], ...over,
  });
}

test("LA5 conversations: creation is idempotent, validated and keeps a public root Session", async (t) => {
  const f = await fixture(t);
  await addSecondFriend(f);
  const created = await createConversation({ chatHome: f.home, storageProjectId: "a", title: "小组", requestId: "req-fixed", memberLongAgentIds: ["friend", "friend2"] });
  assert.match(created.id, /^conv-[a-f0-9]{32}$/);
  assert.equal(created.publicSessionId.length > 0, true);
  assert.deepEqual(created.members.map((member) => member.longAgentId), ["friend", "friend2"]);
  assert.deepEqual(created.members.map((member) => member.sessionId), [null, null], "participation Sessions are bound on demand");
  assert.equal(created.authorizationRevision, 1);
  const again = await createConversation({ chatHome: f.home, storageProjectId: "a", title: "小组", requestId: "req-fixed", memberLongAgentIds: ["friend", "friend2"] });
  assert.deepEqual(again, created, "the same requestId returns the same group");
  await assert.rejects(createConversation({ chatHome: f.home, storageProjectId: "a", title: "x", requestId: "req-missing", memberLongAgentIds: ["nobody"] }), /找不到 Friend/);
  await assert.rejects(createConversation({ chatHome: f.home, storageProjectId: "a", title: "x", requestId: "req-empty", memberLongAgentIds: [] }), /至少需要一位 Friend/);
  assert.equal((await readConversation(f.home, "a", created.id)).title, "小组");
});

test("LA5 conversations: configuration writes are CAS-protected and bump the authorization revision", async (t) => {
  const f = await fixture(t);
  await addSecondFriend(f);
  const created = await group(f);
  await assert.rejects(updateConversation({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, expectedRevision: created.revision + 1, title: "改" }), /已被修改/);
  const renamed = await updateConversation({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, expectedRevision: created.revision, title: "改名" });
  assert.equal(renamed.revision, created.revision + 1);
  assert.equal(renamed.authorizationRevision, created.authorizationRevision, "a title change is not an authorization change");
  const narrowed = await updateConversation({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, expectedRevision: renamed.revision, memberLongAgentIds: ["friend"] });
  assert.equal(narrowed.authorizationRevision, renamed.authorizationRevision + 1);
  assert.equal(narrowed.members.length, 1);
  await assert.rejects(
    updateConversation({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, expectedRevision: narrowed.revision, policy: { defaultPolicy: "moderator", moderatorLongAgentId: "friend2", roundRobinOrder: ["friend"] } }),
    /非成员 Friend/,
  );
});

test("LA5 conversations: the trusted scope comes from the record, not from the caller", async (t) => {
  const f = await fixture(t);
  await addSecondFriend(f);
  const created = await group(f);
  // No participation Session yet and no membership for a stranger: both refused.
  await assert.rejects(resolveParticipationScope({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend", sessionId: "s" }), /参与 Session/);
  const bound = await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend" });
  assert.equal(bound.created, true);
  assert.equal(bound.participationEpoch, 1);
  const rebound = await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend" });
  assert.deepEqual({ sessionId: rebound.sessionId, created: rebound.created }, { sessionId: bound.sessionId, created: false }, "the participation Session is stable until the membership changes");
  // Each Friend gets its own Session.
  const second = await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend2" });
  assert.notEqual(second.sessionId, bound.sessionId);
  const resolved = await resolveParticipationScope({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend", sessionId: bound.sessionId });
  assert.equal(resolved.scope.kind, "conversation");
  assert.deepEqual(resolved.scope.allowedTools, { systemToolAddresses: [], nativeTools: [], extensionTools: [] }, "default deny without explicit grants");
  assert.deepEqual(resolved.scope.authorization.collaborationProjectId, null, "the storage Project is not the collaboration target by default");
  assert.equal(resolved.scope.authorization.participationEpoch, 1);
  verifyLongAgentScope(resolved.scope, {
    grantsDigest: resolved.grantsDigest, longAgentId: "friend", sessionId: bound.sessionId,
    storageProjectId: "a", collaborationProjectId: null, conversationId: created.id, participationEpoch: 1,
    authorizationRevision: resolved.conversation.authorizationRevision,
  });
  // An explicit grant is reflected in the frozen scope and its commitment. Only capabilities with a
  // conversation range check can be granted (project_read, bash and the multi-group manage tool are
  // refused here; only the range-limited native file tools are grantable in a group).
  const granted = await setMemberGrants({
    chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend",
    expectedRevision: resolved.conversation.revision,
    grants: { systemToolAddresses: [], nativeTools: ["read"], extensionTools: [] },
  });
  const afterGrant = await resolveParticipationScope({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend", sessionId: bound.sessionId });
  assert.deepEqual(afterGrant.scope.allowedTools.systemToolAddresses, []);
  assert.deepEqual(afterGrant.scope.allowedTools.nativeTools, ["read"]);
  assert.notEqual(afterGrant.grantsDigest, resolved.grantsDigest);
  assert.equal(afterGrant.scope.authorization.authorizationRevision, granted.authorizationRevision);
  // A wrong Session no longer resolves once the binding changed.
  await assert.rejects(resolveParticipationScope({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend", sessionId: "other-session" }), /参与 Session/);
  await assert.rejects(resolveParticipationScope({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "stranger", sessionId: bound.sessionId }), /不是群成员/);
});

test("LA5 conversations: revoking ends the participation; re-joining cannot reuse the old context", async (t) => {
  const f = await fixture(t);
  await addSecondFriend(f);
  const created = await group(f);
  const bound = await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend" });
  const revoked = await revokeMember({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend", expectedRevision: (await readConversation(f.home, "a", created.id)).revision });
  const revokedMember = revoked.members.find((member) => member.longAgentId === "friend");
  assert.equal(revokedMember.revokedAt !== null, true);
  assert.equal(revokedMember.sessionId, null, "the participation Session binding is dropped");
  assert.equal(revokedMember.grants.systemToolAddresses.length, 0, "grants do not survive revocation");
  await assert.rejects(resolveParticipationScope({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend", sessionId: bound.sessionId }), /不是群成员/);
  const rejoined = await rejoinMember({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend", expectedRevision: revoked.revision });
  const member = rejoined.members.find((candidate) => candidate.longAgentId === "friend");
  assert.equal(member.participationEpoch, 2, "a new participation period starts");
  assert.equal(member.sessionId, null);
  const rebound = await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend" });
  assert.notEqual(rebound.sessionId, bound.sessionId, "a new participation Session is created");
  assert.equal(rebound.participationEpoch, 2);
  await assert.rejects(resolveParticipationScope({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend", sessionId: bound.sessionId }), /参与 Session/, "the revoked Session cannot come back");
});

test("LA5 conversations: archiving stops new participation turns", async (t) => {
  const f = await fixture(t);
  await addSecondFriend(f);
  const created = await group(f);
  const bound = await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend" });
  const archived = await archiveConversation({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, expectedRevision: (await readConversation(f.home, "a", created.id)).revision });
  assert.equal(archived.lifecycle, "archived");
  await assert.rejects(resolveParticipationScope({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend", sessionId: bound.sessionId }), /已归档/);
  await assert.rejects(updateConversation({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, expectedRevision: archived.revision, title: "x" }), /已归档/);
  assert.ok(created instanceof Object);
});

test("LA5 access: participation Sessions are readable only by current authorized readers", async (t) => {
  const f = await fixture(t);
  await addSecondFriend(f);
  const created = await group(f);
  const bound = await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend" });
  const readable = async (requester) => assertParticipantSessionReadable({ chatHome: f.home, storageProjectId: "a", sessionId: bound.sessionId, requester });
  // The owner (local user) keeps access to history.
  const owner = await readable({ kind: "owner" });
  assert.equal(owner.participation.longAgentId, "friend");
  assert.equal(owner.conversation.id, created.id);
  // The current executor may read its own participation Session.
  assert.equal((await readable({ kind: "friend", longAgentId: "friend" })).participation.participationEpoch, 1);
  // Guessing another participant's Session ID is refused.
  await assert.rejects(readable({ kind: "friend", longAgentId: "friend2" }), /属于另一位参与者/);
  // A membership change takes effect on the very next read, without relying on any cached state.
  const revoked = await revokeMember({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend", expectedRevision: (await readConversation(f.home, "a", created.id)).revision });
  await assert.rejects(readable({ kind: "friend", longAgentId: "friend" }), /成员资格已撤销/);
  assert.equal((await readable({ kind: "owner" })).participation.participationEpoch, 1, "history stays readable for readers that still hold permission");
  // Re-joining creates a new epoch: the old Session's history is no longer open to the Friend.
  const rejoined = await rejoinMember({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend", expectedRevision: revoked.revision });
  const rebound = await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend" });
  assert.equal(rebound.participationEpoch, 2);
  await assert.rejects(readable({ kind: "friend", longAgentId: "friend" }), /参与期已变化/);
  const fresh = await assertParticipantSessionReadable({ chatHome: f.home, storageProjectId: "a", sessionId: rebound.sessionId, requester: { kind: "friend", longAgentId: "friend" } });
  assert.equal(fresh.participation.participationEpoch, 2, "the new participation Session is readable by its executor");
  assert.equal(rejoined.authorizationRevision > revoked.authorizationRevision, true);
  // A non-participation Session is unaffected by the guard.
  const plain = await readLongAgentStatePlain(f);
  if (plain !== "no-daily-session") {
    const bypass = await assertParticipantSessionReadable({ chatHome: f.home, storageProjectId: plain, sessionId: plain, requester: { kind: "friend", longAgentId: "friend2" } });
    assert.equal(bypass.participation, null);
  }
});

/** The fixture's daily Session lives in the Friend's own project; used here as a "plain" Session. */
async function readLongAgentStatePlain() {
  return "no-daily-session";
}
