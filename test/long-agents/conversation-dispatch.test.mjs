import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./daily-fixture.mjs";
import { readLongAgentRegistry, writeLongAgentRegistry } from "../../src/long-agents/storage.ts";
import { openChatSession } from "../../src/chat-session.ts";
import { chatSessionOperationKey, withChatSessionOperationLock } from "../../src/session-operation-lock.ts";
import {
  bindParticipationSession,
  createConversation,
  readConversation,
  revokeMember,
} from "../../src/long-agents/conversations/service.ts";
import {
  claimSpeechAttempt,
  finishSpeechAttempt,
  queueSpeechAttempt,
  readDiscussionState,
  recoverDiscussionState,
} from "../../src/long-agents/conversations/discussions.ts";
import { dispatchConversationAttempt, drainConversationAttempts } from "../../src/long-agents/conversations/dispatch.ts";
import {
  publishConversationSpeech,
  readConversationPublicMessages,
} from "../../src/long-agents/conversations/publication.ts";
import { readConversationStreamTick } from "../../src/long-agents/conversations/stream.ts";

async function addSecondFriend(f) {
  const registry = await readLongAgentRegistry(f.home);
  if (registry.agents.some((candidate) => candidate.id === "friend2")) return;
  const first = registry.agents[0];
  await writeLongAgentRegistry({ ...registry, agents: [...registry.agents, {
    ...first, id: "friend2", name: "Friend2", nanoclawAgentGroupId: "group2", defaultProjectId: "friend2",
    definition: { ...first.definition, id: "friend2", name: "Friend2" },
  }] }, f.home);
}

async function group(f, requestId = `req-${Math.random()}`) {
  await addSecondFriend(f);
  return createConversation({
    chatHome: f.home, storageProjectId: "a", title: "派发小组", requestId,
    memberLongAgentIds: ["friend", "friend2"],
  });
}

async function queue(f, { conversation, discussionId, attemptId, speaker = "friend", epoch = 1, instruction }) {
  const current = await readConversation(f.home, "a", conversation.id);
  return queueSpeechAttempt({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id,
    attempt: {
      discussionId, attemptId, policy: "mention", round: 1, speakerLongAgentId: speaker,
      participationEpoch: epoch, inputCutoffEntryId: null, replyToEntryId: null, causationId: null,
      authorizationRevision: current.authorizationRevision, instruction, budget: current.budget,
    },
  });
}

async function attemptStatus(f, conversation, discussionId, attemptId) {
  const state = await readDiscussionState(f.home, "a", conversation.id);
  return state.discussions.find((d) => d.discussionId === discussionId)?.attempts.find((a) => a.attemptId === attemptId)?.status;
}

test("LA5 dispatch: a queued speech runs in the member's own participation Session and publishes", async (t) => {
  const f = await fixture(t);
  const conversation = await group(f, "req-dispatch");
  const author = await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend" });
  await queue(f, { conversation, discussionId: "disc-1", attemptId: "attempt-1", instruction: "GROUP_INSTRUCTION_ONE" });
  f.setHandler(() => ({ content: "GROUP_PUBLIC_ONE" }));
  const result = await dispatchConversationAttempt({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, discussionId: "disc-1", attemptId: "attempt-1",
  });
  assert.equal(result.attempt.status, "published");
  assert.equal(typeof result.publication?.publicationId, "string");
  const projection = await readConversationPublicMessages({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, viewerLongAgentId: "friend2" });
  assert.equal(projection.some((message) => message.text === "GROUP_PUBLIC_ONE"), true);
  // The input and native assistant entry stay in the member's own participation Session.
  const session = await openChatSession({ chatHome: f.home, projectId: "a", sessionId: author.sessionId });
  const entries = session.manager.getEntries();
  assert.equal(entries.some((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("GROUP_INSTRUCTION_ONE")), true);
  assert.equal(entries.some((entry) => entry.type === "message" && entry.message.role === "assistant"), true);
  assert.ok(f.requests.length >= 1, "the real model was called through the public assembly");
});

test("LA5 dispatch: revocation while the model works blocks the publication", async (t) => {
  const f = await fixture(t);
  const conversation = await group(f, "req-dispatch-revoke");
  await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend" });
  await queue(f, { conversation, discussionId: "disc-2", attemptId: "attempt-2", instruction: "GROUP_INSTRUCTION_TWO" });
  f.setHandler(async () => {
    const current = await readConversation(f.home, "a", conversation.id);
    await revokeMember({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend", expectedRevision: current.revision });
    return { content: "MUST_NOT_PUBLISH" };
  });
  await assert.rejects(dispatchConversationAttempt({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, discussionId: "disc-2", attemptId: "attempt-2",
  }), /成员资格已撤销|授权已变化|参与期/);
  assert.equal(await attemptStatus(f, conversation, "disc-2", "attempt-2"), "failed");
  const projection = await readConversationPublicMessages({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, viewerLongAgentId: "friend2" });
  assert.equal(JSON.stringify(projection).includes("MUST_NOT_PUBLISH"), false);
});

test("LA5 recovery: queued work is redispatched, a running attempt without a terminal state is interrupted", async (t) => {
  const f = await fixture(t);
  const conversation = await group(f, "req-recovery");
  await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend" });
  // A running attempt is never replayed: it may have performed unknown side effects.
  await queue(f, { conversation, discussionId: "disc-run", attemptId: "attempt-run", instruction: "GROUP_INSTRUCTION_RUN" });
  const claimed = await claimSpeechAttempt({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, discussionId: "disc-run", attemptId: "attempt-run" });
  assert.equal(claimed.status, "running");
  const recovered = await recoverDiscussionState({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id });
  assert.equal(recovered.interrupted.length, 1);
  assert.equal(await attemptStatus(f, conversation, "disc-run", "attempt-run"), "interrupted");
  assert.equal(f.requests.length, 0, "an interrupted attempt does not call the model again");
  // Queued work is safe to rediscover and run.
  await queue(f, { conversation, discussionId: "disc-queued", attemptId: "attempt-q1", instruction: "GROUP_QUEUED_ONE" });
  await queue(f, { conversation, discussionId: "disc-queued", attemptId: "attempt-q2", instruction: "GROUP_QUEUED_TWO" });
  let call = 0;
  f.setHandler(() => ({ content: `GROUP_ANSWER_${String(++call)}` }));
  await drainConversationAttempts({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id });
  assert.equal(await attemptStatus(f, conversation, "disc-queued", "attempt-q1"), "published");
  assert.equal(await attemptStatus(f, conversation, "disc-queued", "attempt-q2"), "published");
  const projection = await readConversationPublicMessages({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, viewerLongAgentId: "friend2" });
  assert.equal(projection.some((message) => message.text === "GROUP_ANSWER_1"), true);
  assert.equal(projection.some((message) => message.text === "GROUP_ANSWER_2"), true);
});

test("LA5 ordering: revocation and publication commit order is decided inside the public-root lock", async (t) => {
  const f = await fixture(t);
  const conversation = await group(f, "req-ordering");
  const author = await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend" });
  const session = await openChatSession({ chatHome: f.home, projectId: "a", sessionId: author.sessionId });
  session.manager.appendMessage({ role: "assistant", content: "ORDER_BLOCK" });
  session.manager.flush();
  const entryId = session.manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant").at(-1).id;

  // Revocation first: the commit is refused and the public root gains nothing.
  await queue(f, { conversation, discussionId: "disc-a", attemptId: "attempt-a", instruction: "ORDER_A" });
  await revokeMember({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend", expectedRevision: (await readConversation(f.home, "a", conversation.id)).revision });
  await assert.rejects(publishConversationSpeech({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend", attemptId: "attempt-a",
    participationEpoch: 1, authorizationRevision: 1, sourceSessionId: author.sessionId, sourceEntryId: entryId, text: "ORDER_BLOCK",
  }), /成员资格已撤销|参与 Session/);
  const before = await readConversationPublicMessages({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, viewerLongAgentId: null });
  assert.equal(before.some((message) => message.text === "ORDER_BLOCK"), false, "a revoked member adds nothing to the public root");

  // Publication first, revocation while the public-root lock is held: the in-lock re-check refuses it.
  const second = await group(f, "req-ordering-2");
  const secondAuthor = await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: second.id, longAgentId: "friend" });
  const secondSession = await openChatSession({ chatHome: f.home, projectId: "a", sessionId: secondAuthor.sessionId });
  secondSession.manager.appendMessage({ role: "assistant", content: "ORDER_BLOCK_TWO" });
  secondSession.manager.flush();
  const secondEntry = secondSession.manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant").at(-1).id;
  const current = await readConversation(f.home, "a", second.id);
  const key = chatSessionOperationKey("a", second.publicSessionId);
  let release = () => {};
  const hold = withChatSessionOperationLock(key, () => new Promise((resolve) => { release = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const pending = publishConversationSpeech({
    chatHome: f.home, storageProjectId: "a", conversationId: second.id, longAgentId: "friend", attemptId: "attempt-b",
    participationEpoch: 1, authorizationRevision: current.authorizationRevision, sourceSessionId: secondAuthor.sessionId,
    sourceEntryId: secondEntry, text: "ORDER_BLOCK_TWO",
  }).then(() => "published", (error) => `rejected:${error.message}`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await revokeMember({ chatHome: f.home, storageProjectId: "a", conversationId: second.id, longAgentId: "friend", expectedRevision: (await readConversation(f.home, "a", second.id)).revision });
  release();
  await hold;
  assert.match(await pending, /^rejected:.*(撤销|参与期)/, "a revocation landing before the append is not inherited");
  const secondProjection = await readConversationPublicMessages({ chatHome: f.home, storageProjectId: "a", conversationId: second.id, viewerLongAgentId: null });
  assert.equal(secondProjection.some((message) => message.text === "ORDER_BLOCK_TWO"), false);

  // Publication first, then revocation: the reference stays in history but is no longer broadcast.
  const third = await group(f, "req-ordering-3");
  const thirdAuthor = await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: third.id, longAgentId: "friend" });
  const thirdSession = await openChatSession({ chatHome: f.home, projectId: "a", sessionId: thirdAuthor.sessionId });
  thirdSession.manager.appendMessage({ role: "assistant", content: "ORDER_BLOCK_THREE" });
  thirdSession.manager.flush();
  const thirdEntry = thirdSession.manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant").at(-1).id;
  const thirdCurrent = await readConversation(f.home, "a", third.id);
  await publishConversationSpeech({
    chatHome: f.home, storageProjectId: "a", conversationId: third.id, longAgentId: "friend", attemptId: "attempt-c",
    participationEpoch: 1, authorizationRevision: thirdCurrent.authorizationRevision, sourceSessionId: thirdAuthor.sessionId,
    sourceEntryId: thirdEntry, text: "ORDER_BLOCK_THREE",
  });
  await revokeMember({ chatHome: f.home, storageProjectId: "a", conversationId: third.id, longAgentId: "friend2", expectedRevision: (await readConversation(f.home, "a", third.id)).revision });
  const closed = await readConversationStreamTick({ chatHome: f.home, storageProjectId: "a", conversationId: third.id, viewer: { kind: "member", longAgentId: "friend2", conversationId: third.id }, afterCursor: 0 });
  assert.equal(closed.closed, true, "after revocation the stream is closed instead of broadcasting more data");
  const ownerView = await readConversationPublicMessages({ chatHome: f.home, storageProjectId: "a", conversationId: third.id, viewerLongAgentId: null });
  assert.equal(ownerView.some((message) => message.text === "ORDER_BLOCK_THREE"), true, "already published history is retained");
});

test("LA5 dispatch: a failure is recorded as a terminal attempt state without publishing", async (t) => {
  const f = await fixture(t);
  const conversation = await group(f, "req-dispatch-fail");
  await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend" });
  await queue(f, { conversation, discussionId: "disc-fail", attemptId: "attempt-fail", instruction: "GROUP_FAIL" });
  f.setHandler(() => ({ error: "model exploded" }));
  await assert.rejects(dispatchConversationAttempt({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, discussionId: "disc-fail", attemptId: "attempt-fail",
  }));
  assert.equal(await attemptStatus(f, conversation, "disc-fail", "attempt-fail"), "failed");
  const projection = await readConversationPublicMessages({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, viewerLongAgentId: "friend2" });
  assert.equal(projection.filter((message) => message.publicationId !== null).length, 0);
  assert.equal((await finishSpeechAttempt({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, discussionId: "disc-fail",
    attemptId: "attempt-fail", status: "published",
  }).catch((error) => error.message)).includes("终态"), true, "a terminal attempt cannot be overwritten");
});
