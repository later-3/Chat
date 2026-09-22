import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./daily-fixture.mjs";
import {
  bindParticipationSession,
  createConversation,
  readConversation,
  revokeMember,
} from "../../src/long-agents/conversations/service.ts";
import { appendConversationUserMessage } from "../../src/long-agents/conversations/public-root.ts";
import { readConversationPublicMessages } from "../../src/long-agents/conversations/publication.ts";
import {
  cancelConversationWork,
  drainConversationWorks,
  listConversationWorks,
  startConversationWork,
} from "../../src/long-agents/conversations/work.ts";
import {
  readDiscussionState,
  recordDiscussionModelCall,
  startConversationDiscussion,
} from "../../src/long-agents/conversations/discussions.ts";

async function setup(f, requestId) {
  const conversation = await createConversation({
    chatHome: f.home, storageProjectId: "a", title: "任务小组", requestId, memberLongAgentIds: ["friend"],
  });
  const bound = await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend" });
  const origin = await appendConversationUserMessage({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id,
    clientMessageId: `origin-${requestId}`, text: "请后台研究一下这个问题",
  });
  return { conversation, bound, originEntryId: origin.message.entryId };
}

async function projection(f, conversation) {
  return readConversationPublicMessages({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, viewerLongAgentId: null });
}


import { executeConversationWork } from "../../src/long-agents/conversations/work.ts";
import { queueSpeechAttempt } from "../../src/long-agents/conversations/discussions.ts";
import { dispatchConversationAttempt } from "../../src/long-agents/conversations/dispatch.ts";
test("review background work must have a distinct execution Session",async t=>{
 const f=await fixture(t);const {conversation,bound}=await setup(f,"isolation");
 const started=await startConversationWork({chatHome:f.home,storageProjectId:"a",conversationId:conversation.id,longAgentId:"friend",requestId:"w",title:"task",instruction:"PRIVATE_WORK_INPUT"});
 await drainConversationWorks({chatHome:f.home,storageProjectId:"a",conversationId:conversation.id});
 const work=(await listConversationWorks(f.home,"a",conversation.id))[0];
 assert.equal(work.status,"completed",JSON.stringify(work));assert.notEqual(work.sourceSessionId,bound.sessionId);
});
test("review cancelling running work prevents public result and completed overwrite",async t=>{
 const f=await fixture(t);const {conversation}=await setup(f,"cancel-running");
 const {work}=await startConversationWork({chatHome:f.home,storageProjectId:"a",conversationId:conversation.id,longAgentId:"friend",requestId:"w",title:"task",instruction:"work"});
 f.setHandler(async()=>{await cancelConversationWork({chatHome:f.home,storageProjectId:"a",conversationId:conversation.id,workId:work.workId});return {content:"CANCELLED_RESULT"}});
 await drainConversationWorks({chatHome:f.home,storageProjectId:"a",conversationId:conversation.id});
 assert.deepEqual({status:(await listConversationWorks(f.home,"a",conversation.id))[0].status,published:JSON.stringify(await projection(f,conversation)).includes("CANCELLED_RESULT")},{status:"cancelled",published:false});
});
test("review discussion and subwork jointly enforce one-call root budget", async (t) => {
  const f = await fixture(t);
  const conversation = await createConversation({ chatHome: f.home, storageProjectId: "a", title: "budget", requestId: "budget", memberLongAgentIds: ["friend"], budget: { maxModelCalls: 1 } });
  await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend" });
  await startConversationDiscussion({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, discussionId: "root", policy: "mention", round: 1, inputCutoffEntryId: null, budget: conversation.budget });
  await queueSpeechAttempt({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, attempt: { discussionId: "root", attemptId: "speech", policy: "mention", round: 1, speakerLongAgentId: "friend", participationEpoch: 1, inputCutoffEntryId: null, replyToEntryId: null, causationId: null, authorizationRevision: conversation.authorizationRevision, instruction: "speak", budget: conversation.budget } });
  const { work } = await startConversationWork({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend", requestId: "w", title: "task", instruction: "work", source: "discussion", discussionId: "root" });
  let release = () => {};
  let entered = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { entered = resolve; });
  f.setHandler(async () => { entered(); await gate; return { content: "answer" }; });
  // The speech reaches the model boundary first and atomically consumes the single root call.
  const speech = dispatchConversationAttempt({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, discussionId: "root", attemptId: "speech" });
  await ready;
  // The sub-work now starts concurrently; it must be denied, not allowed a second call.
  const child = executeConversationWork({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, workId: work.workId });
  await new Promise((resolve) => setTimeout(resolve, 200));
  release();
  const results = await Promise.allSettled([speech, child]);
  assert.ok(results.every((result) => result.status === "fulfilled"));
  assert.equal(f.requests.length, 1, "the root budget admits exactly one model call under concurrency");
  const speechAttempt = (await readDiscussionState(f.home, "a", conversation.id)).discussions.find((item) => item.discussionId === "root").attempts.find((attempt) => attempt.attemptId === "speech");
  const workRow = (await listConversationWorks(f.home, "a", conversation.id))[0];
  const started = [speechAttempt.status, workRow.status];
  assert.equal(started.includes("published") || started.includes("completed"), true, JSON.stringify({ speechAttempt, workRow }));
  assert.equal(started.includes("failed") || started.includes("skipped"), true, "the loser is denied, not run");
});

// --- Permanent gate: execution protocol invariants (P1-1..P1-3) ---

import { openChatSession } from "../../src/chat-session.ts";
import { readLongAgentRegistry, writeLongAgentRegistry } from "../../src/long-agents/storage.ts";
import { recoverConversationWorks } from "../../src/long-agents/conversations/work.ts";
import { participationTurnKey, withParticipationTurnLock } from "../../src/long-agents/conversations/turn-lock.ts";
import { runConversationDiscussion } from "../../src/long-agents/conversations/orchestrator.ts";

async function addSecondFriend(f) {
  const registry = await readLongAgentRegistry(f.home);
  if (registry.agents.some((candidate) => candidate.id === "friend2")) return;
  const first = registry.agents[0];
  await writeLongAgentRegistry({ ...registry, agents: [...registry.agents, {
    ...first, id: "friend2", name: "Friend2", nanoclawAgentGroupId: "group2", defaultProjectId: "friend2",
    definition: { ...first.definition, id: "friend2", name: "Friend2" },
  }] }, f.home);
}

async function rowOf(f, conversation, workId) {
  return (await listConversationWorks(f.home, "a", conversation.id)).find((work) => work.workId === workId);
}

test("review a running work holds only its own Session lock and never enters group history", async (t) => {
  const f = await fixture(t);
  const { conversation, bound } = await setup(f, "no-block");
  let releaseWork = () => {};
  let markEntered = () => {};
  const workGate = new Promise((resolve) => { releaseWork = resolve; });
  const workEntered = new Promise((resolve) => { markEntered = resolve; });
  f.setHandler(async (body) => {
    const text = JSON.stringify(body.messages ?? "");
    if (text.includes("群内后台任务")) { markEntered(); await workGate; return { content: "WORK_ONLY_RESULT" }; }
    return { content: "SPEECH_OK" };
  });
  const { work } = await startConversationWork({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend",
    requestId: "long-work", title: "长任务", instruction: "WORK_PRIVATE_MARKER",
  });
  const drain = drainConversationWorks({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id });
  await workEntered;
  const running = await rowOf(f, conversation, work.workId);
  assert.equal(running.status, "running");
  assert.notEqual(running.sessionId, bound.sessionId, "the work runs in its own Task Session");

  // The member's participation Session must be free while the work runs: this is exactly the lock
  // that previously serialized a long task with the Friend's next group speech.
  let participationFree = false;
  await Promise.race([
    withParticipationTurnLock(participationTurnKey("a", bound.sessionId), async () => { participationFree = true; }),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("参与 Session 被后台任务占用")), 2_000)),
  ]);
  assert.equal(participationFree, true);
  // Conversely, the work's own Session is the one being held.
  const workBusy = await Promise.race([
    withParticipationTurnLock(participationTurnKey("a", running.sessionId), async () => "free"),
    new Promise((resolve) => setTimeout(() => resolve("locked"), 1_000)),
  ]);
  assert.equal(workBusy, "locked");

  releaseWork();
  await drain;
  const finished = await rowOf(f, conversation, work.workId);
  assert.equal(finished.status, "completed");
  assert.equal(finished.sourceSessionId, finished.sessionId);
  const participation = await openChatSession({ chatHome: f.home, projectId: "a", sessionId: bound.sessionId });
  const participationText = JSON.stringify(participation.manager.getEntries());
  assert.equal(participationText.includes("WORK_PRIVATE_MARKER"), false, "the task prompt never enters group history");
  assert.equal(participationText.includes("WORK_ONLY_RESULT"), false, "the task result never enters group history");
  const workSession = await openChatSession({ chatHome: f.home, projectId: "a", sessionId: finished.sessionId });
  assert.equal(JSON.stringify(workSession.manager.getEntries()).includes("WORK_ONLY_RESULT"), true);

  // The Friend can still speak in the group after the task; the task history is not implicit input.
  await queueSpeechAttempt({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id,
    attempt: {
      discussionId: "speech-after-work", attemptId: "speech-after-work-1", policy: "mention", round: 1,
      speakerLongAgentId: "friend", participationEpoch: 1, inputCutoffEntryId: null, replyToEntryId: null,
      causationId: null, authorizationRevision: (await readConversation(f.home, "a", conversation.id)).authorizationRevision,
      instruction: "say something", budget: (await readConversation(f.home, "a", conversation.id)).budget,
    },
  });
  const speech = await dispatchConversationAttempt({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id,
    discussionId: "speech-after-work", attemptId: "speech-after-work-1",
  });
  assert.equal(speech.attempt.status, "published", "the Friend still speaks after the task");
});

test("review crash recovery marks a running work failed and never publishes its result", async (t) => {
  const f = await fixture(t);
  const { conversation } = await setup(f, "crash-recovery");
  let release = () => {};
  let markEntered = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { markEntered = resolve; });
  f.setHandler(async () => { markEntered(); await gate; return { content: "SHOULD_NOT_PUBLISH" }; });
  const { work } = await startConversationWork({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend",
    requestId: "crash-work", title: "崩溃任务", instruction: "work",
  });
  const execution = executeConversationWork({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, workId: work.workId });
  await entered;
  const recovered = await recoverConversationWorks({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id });
  assert.equal(recovered.interrupted, 1);
  release();
  await execution.catch(() => undefined);
  const finished = await rowOf(f, conversation, work.workId);
  assert.equal(finished.status, "failed", "recovered running work is terminal, not completed");
  assert.match(finished.error, /进程重启/);
  assert.equal((await projection(f, conversation)).some((message) => message.text === "SHOULD_NOT_PUBLISH"), false);
});

test("review a failure that lands after cancellation keeps the cancelled terminal state", async (t) => {
  const f = await fixture(t);
  const { conversation } = await setup(f, "late-failure");
  const { work } = await startConversationWork({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend",
    requestId: "late-failure", title: "迟到失败", instruction: "work",
  });
  f.setHandler(async () => {
    await cancelConversationWork({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, workId: work.workId });
    return { error: "late failure" };
  });
  await drainConversationWorks({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id });
  const finished = await rowOf(f, conversation, work.workId);
  assert.equal(finished.status, "cancelled", "a late failure cannot overwrite the cancelled state");
  assert.equal(finished.publicationId, null);
});

test("review a cancelled queued work never runs", async (t) => {
  const f = await fixture(t);
  const { conversation } = await setup(f, "cancel-queued");
  const { work } = await startConversationWork({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend",
    requestId: "queued-cancel", title: "排队取消", instruction: "work",
  });
  f.setHandler(() => ({ content: "MUST_NOT_RUN" }));
  await cancelConversationWork({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, workId: work.workId });
  await drainConversationWorks({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id });
  assert.equal((await rowOf(f, conversation, work.workId)).status, "cancelled");
  assert.equal(f.requests.length, 0);
});

test("review parallel members share one atomic root budget", async (t) => {
  const f = await fixture(t);
  await addSecondFriend(f);
  const conversation = await createConversation({
    chatHome: f.home, storageProjectId: "a", title: "并行预算", requestId: "parallel-budget",
    memberLongAgentIds: ["friend", "friend2"], budget: { maxModelCalls: 1, maxConcurrentSpeakers: 2 },
  });
  f.setHandler(() => ({ content: "P" }));
  await runConversationDiscussion({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, discussionId: "parallel-budget", policy: "parallel",
  });
  assert.equal(f.requests.length, 1, "two parallel members cannot both spend a one-call budget");
  const attempts = (await readDiscussionState(f.home, "a", conversation.id)).discussions.find((item) => item.discussionId === "parallel-budget").attempts;
  assert.equal(attempts.filter((attempt) => attempt.status === "published").length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === "skipped").length, 1);
});

// --- Round-2 independent review probes (R2-P1-1, R2-P1-2) ---

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { chatSessionOperationKey, withChatSessionOperationLock } from "../../src/session-operation-lock.ts";
import { setMemberGrants } from "../../src/long-agents/conversations/service.ts";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test("review R2-P1-1: cancellation before the public append suppresses publication", async (t) => {
  const f = await fixture(t);
  const { conversation } = await setup(f, "late-cancel");
  const { work } = await startConversationWork({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend",
    requestId: "w", title: "task", instruction: "work",
  });
  const locked = deferred();
  const release = deferred();
  const publishing = deferred();
  const lock = withChatSessionOperationLock(chatSessionOperationKey("a", conversation.publicSessionId), async () => {
    locked.resolve();
    await release.promise;
  });
  await locked.promise;
  const original = SessionManager.prototype.getEntries;
  SessionManager.prototype.getEntries = function (...args) {
    const rows = original.apply(this, args);
    if (new Error().stack.includes("assertSourceSessionAuthorized")) publishing.resolve();
    return rows;
  };
  f.setHandler(() => ({ content: "LATE_CANCEL_PUBLIC_RESULT" }));
  const execution = executeConversationWork({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, workId: work.workId });
  try {
    // Wait until the publisher has entered the publish path but cannot append (lock held by us).
    await publishing.promise;
    await cancelConversationWork({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, workId: work.workId });
  } finally {
    SessionManager.prototype.getEntries = original;
    release.resolve();
  }
  await lock;
  await execution.catch(() => undefined);
  assert.deepEqual({
    status: (await listConversationWorks(f.home, "a", conversation.id))[0].status,
    published: JSON.stringify(await projection(f, conversation)).includes("LATE_CANCEL_PUBLIC_RESULT"),
  }, { status: "cancelled", published: false });
});

test("review R2-P1-2: a tool continuation cannot exceed maxModelCalls=1", async (t) => {
  const f = await fixture(t);
  let conversation = await createConversation({
    chatHome: f.home, storageProjectId: "a", title: "budget", requestId: "tool-budget",
    memberLongAgentIds: ["friend"], budget: { maxModelCalls: 1 },
  });
  const bound = await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend" });
  conversation = await setMemberGrants({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend",
    expectedRevision: bound.conversation.revision,
    grants: { systemToolAddresses: [], nativeTools: ["read"], extensionTools: [] },
  });
  await queueSpeechAttempt({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id,
    attempt: {
      discussionId: "root", attemptId: "speech", policy: "mention", round: 1, speakerLongAgentId: "friend",
      participationEpoch: 1, inputCutoffEntryId: null, replyToEntryId: null, causationId: null,
      authorizationRevision: conversation.authorizationRevision, instruction: "read", budget: conversation.budget,
    },
  });
  // First provider request returns a tool call; Pi would request a second turn for the tool result.
  f.setHandler(() => f.requests.length === 1
    ? { tool_calls: [{ index: 0, id: "read1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "/not-authorized" }) } }] }
    : { content: "SECOND_CALL_RESULT" });
  await dispatchConversationAttempt({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, discussionId: "root", attemptId: "speech" });
  assert.equal(f.requests.length, 1, "the tool continuation is denied at the provider request boundary");
});

// --- Round-3 independent review probe (R3-P1): cancel/commit arbitration ---

import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

test("review R3-P1: cancellation queues behind an in-flight commit and cannot bypass it", async (t) => {
  const f = await fixture(t);
  const { conversation } = await setup(f, "commit-arbitration");
  const { work } = await startConversationWork({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend",
    requestId: "w", title: "task", instruction: "work",
  });
  const readReady = deferred();
  const releaseRead = deferred();
  let intercepted = false;
  const original = fsp.readFile;
  fsp.readFile = async function (...args) {
    const stack = new Error().stack;
    const value = await original.apply(this, args);
    if (!intercepted && String(args[0]).endsWith("works.json") && stack.includes("assertStillAuthorized")) {
      intercepted = true;
      readReady.resolve();
      await releaseRead.promise;
    }
    return value;
  };
  syncBuiltinESMExports();
  f.setHandler(() => ({ content: "COMMIT_WINS_RESULT" }));
  const execution = executeConversationWork({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, workId: work.workId });
  try {
    // The publisher holds the public-root lock and the work commit lock and is paused in its guard.
    await readReady.promise;
    const cancellation = cancelConversationWork({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, workId: work.workId })
      .then((row) => ({ ok: true, status: row.status }))
      .catch((error) => ({ ok: false, message: error instanceof Error ? error.message : String(error) }));
    const raced = await Promise.race([
      cancellation.then(() => "done"),
      new Promise((resolve) => setTimeout(() => resolve("queued"), 300)),
    ]);
    assert.equal(raced, "queued", "cancel must queue behind the held commit lock instead of racing a stale read");
    releaseRead.resolve();
    await execution;
    // The commit already held the lock, so it linearizes first and keeps its reference.
    assert.equal((await projection(f, conversation)).some((message) => message.text === "COMMIT_WINS_RESULT"), true);
    const row = (await listConversationWorks(f.home, "a", conversation.id))[0];
    assert.notEqual(row.status, "running", "the work is terminal after recovery from the paused commit");
    const outcome = await cancellation;
    // Cancellation either wins the lock (status cancelled) or observes the already-completed task.
    if ("ok" in outcome && outcome.ok) assert.equal(outcome.status, "cancelled");
  } finally {
    fsp.readFile = original;
    syncBuiltinESMExports();
    releaseRead.resolve();
  }
});

test("review R3-P1: a cancellation that commits first blocks the late publication", async (t) => {
  const f = await fixture(t);
  const { conversation } = await setup(f, "cancel-first");
  const { work } = await startConversationWork({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend",
    requestId: "w", title: "task", instruction: "work",
  });
  // Cancel before the execution ever reaches the commit guard.
  const cancelled = await cancelConversationWork({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, workId: work.workId });
  assert.equal(cancelled.status, "cancelled");
  f.setHandler(() => ({ content: "MUST_NOT_PUBLISH" }));
  await drainConversationWorks({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id });
  assert.equal((await listConversationWorks(f.home, "a", conversation.id))[0].status, "cancelled");
  assert.equal((await projection(f, conversation)).some((message) => message.text === "MUST_NOT_PUBLISH"), false);
  assert.equal(f.requests.length, 0);
});

// --- Budget completeness: soft token admission and independent user-work budget ---

test("review budget: maxTokensSoft refuses the next provider request after usage is observed", async (t) => {
  const f = await fixture(t);
  let conversation = await createConversation({
    chatHome: f.home, storageProjectId: "a", title: "token-budget", requestId: "token-budget",
    memberLongAgentIds: ["friend"], budget: { maxModelCalls: 5, maxTokensSoft: 50 },
  });
  const bound = await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend" });
  conversation = await setMemberGrants({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend",
    expectedRevision: bound.conversation.revision, grants: { systemToolAddresses: [], nativeTools: ["read"], extensionTools: [] },
  });
  await queueSpeechAttempt({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id,
    attempt: {
      discussionId: "root", attemptId: "speech", policy: "mention", round: 1, speakerLongAgentId: "friend",
      participationEpoch: 1, inputCutoffEntryId: null, replyToEntryId: null, causationId: null,
      authorizationRevision: conversation.authorizationRevision, instruction: "read", budget: conversation.budget,
    },
  });
  // The fixture provider reports 60 total tokens, above the 50 soft limit.
  f.setHandler(() => f.requests.length === 1
    ? { tool_calls: [{ index: 0, id: "read1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "/not-authorized" }) } }] }
    : { content: "TOKEN_BUDGET_SECOND" });
  await dispatchConversationAttempt({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, discussionId: "root", attemptId: "speech" });
  assert.equal(f.requests.length, 1, "the observed token usage blocks the continuation request");
  const discussion = (await readDiscussionState(f.home, "a", conversation.id)).discussions.find((item) => item.discussionId === "root");
  assert.ok(discussion.tokensUsed >= 50, `expected durable token usage, got ${String(discussion.tokensUsed)}`);
});

test("review budget: an independent user work enforces its own durable budget", async (t) => {
  const f = await fixture(t);
  const conversation = await createConversation({
    chatHome: f.home, storageProjectId: "a", title: "work-budget", requestId: "work-budget",
    memberLongAgentIds: ["friend"], budget: { maxModelCalls: 1, maxTokensSoft: 10_000 },
  });
  const bound = await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend" });
  await setMemberGrants({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend",
    expectedRevision: bound.conversation.revision, grants: { systemToolAddresses: [], nativeTools: ["read"], extensionTools: [] },
  });
  const { work } = await startConversationWork({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend",
    requestId: "user-work-budget", title: "独立任务", instruction: "read", source: "user",
  });
  f.setHandler(() => f.requests.length === 1
    ? { tool_calls: [{ index: 0, id: "read1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "/not-authorized" }) } }] }
    : { content: "WORK_BUDGET_SECOND" });
  await drainConversationWorks({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id });
  assert.equal(f.requests.length, 1, "the user work's own budget blocks the continuation");
  const row = (await listConversationWorks(f.home, "a", conversation.id))[0];
  assert.equal(row.budget.maxModelCalls, 1, "the user work snapshots its own durable budget");
  assert.equal(row.modelCalls, 1, "the work's model calls are metered durably");
  assert.ok(row.tokensUsed >= 50, `expected durable work token usage, got ${String(row.tokensUsed)}`);
  assert.equal((await readDiscussionState(f.home, "a", conversation.id)).discussions.length, 0, "a user work never consumes a discussion budget");
});

for (const source of ["discussion", "user"]) {
  test(`usage persistence failure blocks ${source} continuation and publication`, async (t) => {
    const f = await fixture(t);
    let conversation = await createConversation({
      chatHome: f.home, storageProjectId: "a", title: "usage-failure", requestId: `usage-${source}`,
      memberLongAgentIds: ["friend"], budget: { maxModelCalls: 5, maxTokensSoft: 50 },
    });
    const bound = await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend" });
    conversation = await setMemberGrants({
      chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend",
      expectedRevision: bound.conversation.revision,
      grants: { systemToolAddresses: [], nativeTools: ["read"], extensionTools: [] },
    });
    const base = { chatHome: f.home, storageProjectId: "a", conversationId: conversation.id };
    let execute;
    if (source === "discussion") {
      await queueSpeechAttempt({ ...base, attempt: {
        discussionId: "root", attemptId: "speech", policy: "mention", round: 1, speakerLongAgentId: "friend",
        participationEpoch: 1, inputCutoffEntryId: null, replyToEntryId: null, causationId: null,
        authorizationRevision: conversation.authorizationRevision, instruction: "read", budget: conversation.budget,
      } });
      execute = () => dispatchConversationAttempt({ ...base, discussionId: "root", attemptId: "speech" });
    } else {
      const { work } = await startConversationWork({ ...base, longAgentId: "friend", requestId: "work", title: "task", instruction: "read", source: "user" });
      execute = () => executeConversationWork({ ...base, workId: work.workId });
    }
    f.setHandler(() => f.requests.length === 1
      ? { tool_calls: [{ index: 0, id: "read1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "/not-authorized" }) } }] }
      : { content: "MUST_NOT_RUN_WITH_UNRECORDED_USAGE" });
    const original = fsp.writeFile;
    let injected = false;
    fsp.writeFile = async function (...args) {
      if (!injected && String(args[0]).startsWith(f.home) && typeof args[1] === "string") {
        let body;
        try { body = JSON.parse(args[1]); } catch { /* Not a JSON state write. */ }
        const rows = source === "discussion" ? body?.discussions : body?.works;
        if (rows?.some(row => row.tokensUsed > 0)) {
          injected = true;
          throw Object.assign(new Error("usage persistence EIO"), { code: "EIO" });
        }
      }
      return original.apply(this, args);
    };
    syncBuiltinESMExports();
    try { await assert.rejects(execute(), /usage persistence EIO/); }
    finally { fsp.writeFile = original; syncBuiltinESMExports(); }
    assert.equal(injected, true);
    assert.equal(f.requests.length, 1);
    assert.equal((await projection(f, conversation)).some(message => message.publicationId !== null), false);
  });
}
