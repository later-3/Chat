import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./daily-fixture.mjs";
import { readLongAgentRegistry, writeLongAgentRegistry } from "../../src/long-agents/storage.ts";
import { openChatSession } from "../../src/chat-session.ts";
import { createChatPiAgentSession } from "../../src/agents/pi-agent-session.ts";
import { prepareLongAgentAssembly } from "../../src/long-agents/assembly.ts";
import {
  bindParticipationSession, createConversation, readConversation, revokeMember,
} from "../../src/long-agents/conversations/service.ts";
import { readConversationStreamSnapshot, readConversationStreamTick } from "../../src/long-agents/conversations/stream.ts";
import {
  publishConversationSpeech, readConversationPublicMessages, recoverConversationPublication,
} from "../../src/long-agents/conversations/publication.ts";

async function addSecondFriend(f) {
  const registry = await readLongAgentRegistry(f.home);
  const first = registry.agents[0];
  await writeLongAgentRegistry({ ...registry, agents: [...registry.agents, {
    ...first, id: "friend2", name: "Friend2", nanoclawAgentGroupId: "group2", defaultProjectId: "friend2",
    definition: { ...first.definition, id: "friend2", name: "Friend2" },
  }] }, f.home);
}

/** Run one real turn inside the member's own participation Session and return its assistant entry. */
async function speak(f, { conversation, sessionId, longAgentId, text }) {
  const agent = (await readLongAgentRegistry(f.home)).agents.find((candidate) => candidate.id === longAgentId);
  const member = conversation.members.find((candidate) => candidate.longAgentId === longAgentId);
  const session = await openChatSession({ chatHome: f.home, projectId: conversation.storageProjectId, sessionId });
  const scope = await scopeFor(f, conversation, longAgentId, sessionId);
  const prepared = await prepareLongAgentAssembly({
    agent, chatHome: f.home, projectId: scope.authorization.collaborationProjectId, turnId: `turn-${Math.random()}`,
    scope: { ...scope },
  });
  const digest = prepared.invocation.scope.authorization.grantsDigest;
  const created = await createChatPiAgentSession({
    chatSession: session, sessionManager: session.manager,
    ...(await prepareLongAgentAssembly({ agent, chatHome: f.home, projectId: scope.authorization.collaborationProjectId, turnId: prepared.invocation.turnId, scope: prepared.invocation.scope, scopeGrantsDigest: digest })),
    toolContext: { purpose: "execution", agentId: longAgentId, longAgentId, longAgentTurnId: prepared.invocation.turnId },
  });
  f.setHandler(() => ({ content: text }));
  await created.session.prompt("please speak");
  created.session.dispose();
  const entry = session.manager.getEntries().filter((candidate) => candidate.type === "message" && candidate.message.role === "assistant").at(-1);
  assert.ok(entry, "the participation Session keeps its own assistant entry");
  const content = entry.message.content;
  const entryText = typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  assert.equal(member.participationEpoch >= 1, true);
  return { entryId: entry.id, text: entryText };
}

async function scopeFor(f, conversation, longAgentId, sessionId) {
  const { resolveParticipationScope } = await import("../../src/long-agents/conversations/service.ts");
  return (await resolveParticipationScope({
    chatHome: f.home, storageProjectId: conversation.storageProjectId, conversationId: conversation.id, longAgentId, sessionId,
  })).scope;
}

test("LA5 publication: published references are idempotent, authorized and never leak drafts", async (t) => {
  const f = await fixture(t);
  await addSecondFriend(f);
  const created = await createConversation({
    chatHome: f.home, storageProjectId: "a", title: "研究小组", requestId: "req-pub",
    memberLongAgentIds: ["friend", "friend2"],
  });
  const bound = await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend" });
  const spoken = await speak(f, { conversation: created, sessionId: bound.sessionId, longAgentId: "friend", text: "PUBLIC_BLOCK_ONE" });
  const conversation = await readConversation(f.home, "a", created.id);
  const published = await publishConversationSpeech({
    chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend", attemptId: "attempt-1",
    participationEpoch: 1, authorizationRevision: conversation.authorizationRevision,
    sourceSessionId: bound.sessionId, sourceEntryId: spoken.entryId, text: "PUBLIC_BLOCK_ONE",
  });
  assert.equal(published.created, true);
  const repeat = await publishConversationSpeech({
    chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend", attemptId: "attempt-1",
    participationEpoch: 1, authorizationRevision: conversation.authorizationRevision,
    sourceSessionId: bound.sessionId, sourceEntryId: spoken.entryId, text: "PUBLIC_BLOCK_ONE",
  });
  assert.equal(repeat.created, false, "a lost receipt only re-publishes, never duplicates");
  assert.equal(repeat.publication.publicationId, published.publication.publicationId);
  // A draft (unpublished assistant entry) stays private.
  const draft = await speak(f, { conversation, sessionId: bound.sessionId, longAgentId: "friend", text: "PRIVATE_DRAFT_TWO" });
  const projection = await readConversationPublicMessages({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, viewerLongAgentId: "friend2" });
  const visible = JSON.stringify(projection);
  assert.equal(visible.includes("PUBLIC_BLOCK_ONE"), true);
  assert.equal(visible.includes("PRIVATE_DRAFT_TWO"), false, "an unpublished draft never enters the public stream");
  assert.equal(projection.filter((message) => message.publicationId !== null).length, 1);
  // Viewers must be members; a stranger cannot read the group projection.
  await assert.rejects(readConversationPublicMessages({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, viewerLongAgentId: "stranger" }), /只有群成员/);
  // Publication must come from the member's own current participation Session.
  await assert.rejects(publishConversationSpeech({
    chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend2", attemptId: "attempt-x",
    participationEpoch: 1, authorizationRevision: conversation.authorizationRevision,
    sourceSessionId: bound.sessionId, sourceEntryId: draft.entryId, text: "PRIVATE_DRAFT_TWO",
  }), /不是该成员当前的参与 Session/);
  // Revocation blocks late publication but keeps the already published reference readable.
  const revoked = await revokeMember({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend", expectedRevision: (await readConversation(f.home, "a", created.id)).revision });
  assert.ok(revoked.members.find((member) => member.longAgentId === "friend").revokedAt);
  await assert.rejects(publishConversationSpeech({
    chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend", attemptId: "attempt-2",
    participationEpoch: 1, authorizationRevision: revoked.authorizationRevision,
    sourceSessionId: bound.sessionId, sourceEntryId: draft.entryId, text: "PRIVATE_DRAFT_TWO",
  }), /成员资格已撤销/);
  await assert.rejects(recoverConversationPublication({
    chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend", attemptId: "attempt-3",
    sourceSessionId: bound.sessionId, sourceEntryId: draft.entryId, text: "PRIVATE_DRAFT_TWO",
  }), /参与期已结束/);
  const after = await readConversationPublicMessages({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, viewerLongAgentId: "friend2" });
  assert.equal(after.filter((message) => message.publicationId !== null).length, 1, "revocation does not remove published history");
  // An authorization change invalidates a stale frozen revision.
  await assert.rejects(publishConversationSpeech({
    chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend2", attemptId: "attempt-4",
    participationEpoch: 1, authorizationRevision: conversation.authorizationRevision,
    sourceSessionId: bound.sessionId, sourceEntryId: spoken.entryId, text: "PUBLIC_BLOCK_ONE",
  }), /授权已变化|参与 Session/);
});

test("LA5 stream: authorization is re-evaluated per tick, so revocation closes an open connection", async (t) => {
  const f = await fixture(t);
  await addSecondFriend(f);
  const created = await createConversation({ chatHome: f.home, storageProjectId: "a", title: "研究小组", requestId: "req-stream", memberLongAgentIds: ["friend", "friend2"] });
  const bound = await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend" });
  const spoken = await speak(f, { conversation: created, sessionId: bound.sessionId, longAgentId: "friend", text: "STREAM_BLOCK_ONE" });
  const current = await readConversation(f.home, "a", created.id);
  await publishConversationSpeech({
    chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend", attemptId: "stream-1",
    participationEpoch: 1, authorizationRevision: current.authorizationRevision,
    sourceSessionId: bound.sessionId, sourceEntryId: spoken.entryId, text: "STREAM_BLOCK_ONE",
  });
  const viewer = { kind: "member", longAgentId: "friend2", conversationId: created.id };
  const first = await readConversationStreamTick({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, viewer, afterCursor: 0 });
  assert.equal(first.closed, false);
  assert.equal(first.events.some((event) => event.message?.text === "STREAM_BLOCK_ONE"), true);
  assert.ok(first.nextCursor >= 1);
  const idle = await readConversationStreamTick({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, viewer, afterCursor: first.nextCursor });
  assert.deepEqual(idle.events, [], "an already delivered publication is not re-sent");
  // A user message that arrives after the connection opened is delivered incrementally.
  const { openChatSession: openPublic } = await import("../../src/chat-session.ts");
  const publicRoot = await openPublic({ chatHome: f.home, projectId: "a", sessionId: created.publicSessionId });
  publicRoot.manager.appendMessage({ role: "user", content: "USER_MESSAGE_TWO" });
  publicRoot.manager.flush();
  const incremental = await readConversationStreamTick({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, viewer, afterCursor: first.nextCursor });
  assert.equal(incremental.events.length, 1, "only the new message is delivered");
  assert.equal(incremental.events[0].message.text, "USER_MESSAGE_TWO");
  assert.equal(incremental.events[0].message.publicationId, null);
  assert.equal(incremental.nextCursor, first.nextCursor + 1);
  // Stable identity + cursor: replaying from the same cursor must not duplicate anything.
  const replayed = await readConversationStreamTick({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, viewer, afterCursor: incremental.nextCursor });
  assert.deepEqual(replayed.events, []);
  // An invalid stored cursor yields a full snapshot rather than silent gaps.
  const reset = await readConversationStreamTick({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, viewer, afterCursor: 999 });
  assert.equal(reset.events[0].type, "reset");
  assert.equal(reset.events[0].messages.length, reset.nextCursor);
  // Revoke the viewer: the very next tick must close the stream instead of serving more data.
  await revokeMember({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend2", expectedRevision: (await readConversation(f.home, "a", created.id)).revision });
  const revoked = await readConversationStreamTick({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, viewer, afterCursor: incremental.nextCursor });
  assert.equal(revoked.closed, true);
  assert.equal(revoked.events[0].type, "revoked");
  assert.equal(revoked.events.some((event) => event.message !== undefined), false, "no restricted data after revocation");
  // Reconnect / history read is checked by the same rule.
  await assert.rejects(readConversationStreamSnapshot({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, viewer }), /成员资格已撤销/);
  // The owner entry keeps access, and a stranger Friend is refused.
  assert.equal((await readConversationStreamSnapshot({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, viewer: { kind: "owner" } })).length > 0, true);
  await assert.rejects(readConversationStreamSnapshot({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, viewer: { kind: "member", longAgentId: "stranger", conversationId: created.id } }), /只有群成员|成员资格已撤销/);
});

test("LA5 stream: no close happens while the viewer stays authorized", async (t) => {
  const f = await fixture(t);
  const created = await createConversation({ chatHome: f.home, storageProjectId: "a", title: "小组", requestId: "req-stream-2", memberLongAgentIds: ["friend"] });
  const tick = await readConversationStreamTick({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, viewer: { kind: "member", longAgentId: "friend", conversationId: created.id }, afterCursor: 0 });
  assert.equal(tick.closed, false);
  assert.equal(tick.events.every((event) => event.type === "message"), true);
});
