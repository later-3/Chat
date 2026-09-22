import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./daily-fixture.mjs";
import { readLongAgentState } from "../../src/long-agents/storage.ts";
import { executeLongAgentTurn } from "../../src/long-agents/runtime.ts";
import { controlQueuedRequest, drainLongAgentTurns } from "../../src/long-agents/turn-queue.ts";
import { readChatSession } from "../../src/session-read-model.ts";
import {
  bindParticipationSession,
  createConversation,
  readConversation,
  updateConversation,
} from "../../src/long-agents/conversations/service.ts";
import { runConversationDiscussion } from "../../src/long-agents/conversations/orchestrator.ts";
import { drainConversationWorks, listConversationWorks, startConversationWork } from "../../src/long-agents/conversations/work.ts";
import { readConversationPublicMessages } from "../../src/long-agents/conversations/publication.ts";

const lastUserText = (body) => {
  const messages = body.messages ?? [];
  const last = [...messages].reverse().find((message) => message.role === "user");
  const content = last?.content;
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
};

test("LA6 C: a dropped provider connection is terminal and its retry keeps one user message", async (t) => {
  const f = await fixture(t);
  let dropped = false;
  f.setHandler((_body, res) => {
    if (!dropped) {
      dropped = true;
      res.destroy();
      return undefined;
    }
    return { content: "RECOVERED_AFTER_DROP" };
  });
  await assert.rejects(executeLongAgentTurn(f.input("drop-turn")), /.*/);
  const failed = (await readLongAgentState(f.home)).turns.find((turn) => turn.requestId === "drop-turn");
  assert.equal(failed.status, "failed");
  assert.ok(failed.error, "the transport failure is stored as the terminal reason");
  // The user retries explicitly: exactly one user message, and the recovered answer completes.
  await controlQueuedRequest(f.home, "friend", failed.turnId, "retry");
  await drainLongAgentTurns(f.home, "friend", failed.sessionId);
  const retried = (await readLongAgentState(f.home)).turns.find((turn) => turn.turnId === failed.turnId);
  assert.equal(retried.status, "completed");
  const session = await readChatSession(failed.sessionId, undefined, {}, "friend", f.home);
  assert.equal(session.context.messages.filter((message) => message.role === "user").length, 1, "a retry never duplicates the user message");
  assert.match(JSON.stringify(session.context.messages), /RECOVERED_AFTER_DROP/);
});

test("LA6 C: concurrent writers on the same group registry never corrupt it", async (t) => {
  const f = await fixture(t);
  const conversation = await createConversation({ chatHome: f.home, storageProjectId: "a", title: "并发小组", requestId: "req-concurrent", memberLongAgentIds: ["friend"] });
  // Five writers using the same expected revision: exactly one CAS wins.
  const results = await Promise.allSettled(Array.from({ length: 5 }, (_unused, index) => updateConversation({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id,
    expectedRevision: conversation.revision, title: `并发 ${String(index)}`,
  })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 4);
  const final = await readConversation(f.home, "a", conversation.id);
  assert.equal(final.revision, conversation.revision + 1);
  assert.equal(final.authorizationRevision, conversation.authorizationRevision);
  assert.equal(final.members.map((member) => member.longAgentId).join(","), "friend");
});

test("LA6 C: private chat, a group discussion and a background task run together with isolated Sessions", async (t) => {
  const f = await fixture(t);
  const conversation = await createConversation({ chatHome: f.home, storageProjectId: "a", title: "联合小组", requestId: "req-joint", memberLongAgentIds: ["friend"] });
  const bound = await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend" });
  const entered = new Set();
  let releaseModels;
  const allEntered = new Promise(resolve => { releaseModels = resolve; });
  const timeout = setTimeout(() => releaseModels(), 5000);
  t.after(() => clearTimeout(timeout));
  f.setHandler(async (body) => {
    const text = lastUserText(body);
    const kind = text.includes("群内后台任务") ? "work" : text.includes("群「") ? "group" : "private";
    entered.add(kind);
    if (entered.size === 3) releaseModels();
    await allEntered;
    if (entered.size !== 3) return { error: "all three model requests must be in flight before any reply is released" };
    if (text.includes("群内后台任务")) return { content: "WORK_REPLY" };
    if (text.includes("群「")) return { content: "GROUP_REPLY" };
    return { content: "PRIVATE_REPLY" };
  });
  const privateTurn = executeLongAgentTurn(f.input("joint-private"));
  const groupRound = runConversationDiscussion({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id,
    discussionId: "joint-round", policy: "mention", targets: ["friend"],
  });
  const work = await startConversationWork({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend",
    requestId: "joint-work", title: "联合任务", instruction: "后台研究", source: "user",
  });
  const workDrain = drainConversationWorks({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id });
  const [privateResult] = await Promise.all([privateTurn, groupRound, workDrain]);
  assert.equal(privateResult.text, "PRIVATE_REPLY");
  // The private daily Session holds only its own turn.
  const privateSession = (await readLongAgentState(f.home)).turns.find((turn) => turn.requestId === "joint-private").sessionId;
  assert.notEqual(privateSession, bound.sessionId, "private chat and group participation use different Sessions");
  const privateView = await readChatSession(privateSession, undefined, {}, "friend", f.home);
  const privateText = JSON.stringify(privateView.context.messages);
  assert.equal(privateText.includes("GROUP_REPLY"), false);
  assert.equal(privateText.includes("WORK_REPLY"), false);
  // The group public projection holds the group answer and the task result, not the private answer.
  const publicMessages = await readConversationPublicMessages({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, viewerLongAgentId: null });
  const publicText = JSON.stringify(publicMessages);
  assert.equal(publicText.includes("GROUP_REPLY"), true);
  assert.equal(publicText.includes("WORK_REPLY"), true);
  assert.equal(publicText.includes("PRIVATE_REPLY"), false, "a private turn never leaks into the group projection");
  const workRow = (await listConversationWorks(f.home, "a", conversation.id)).find((item) => item.workId === work.work.workId);
  assert.equal(workRow.status, "completed");
  assert.notEqual(workRow.sessionId, privateSession);
  assert.notEqual(workRow.sessionId, bound.sessionId);
  assert.deepEqual([...entered].sort(), ["group", "private", "work"]);
});

test("LA6 D: cancel, completion and retry all maintain the durable settledAt", async (t) => {
  const f = await fixture(t);
  const { acceptLongAgentTurn, updateTurnStatus } = await import("../../src/long-agents/turn-queue.ts");
  const { cancelFriendTurn } = await import("../../src/long-agents/turn-controls.ts");
  const turnOf = async (turnId) => (await readLongAgentState(f.home)).turns.find((entry) => entry.turnId === turnId);

  const queued = await acceptLongAgentTurn(f.input("settle-queued"));
  await cancelFriendTurn(f.home, "friend", queued.turnId);
  assert.equal((await turnOf(queued.turnId)).status, "cancelled");
  assert.equal(typeof (await turnOf(queued.turnId)).settledAt, "string", "a queued cancel records its terminal time");

  const queued2 = await acceptLongAgentTurn(f.input("settle-control"));
  await controlQueuedRequest(f.home, "friend", queued2.turnId, "cancel");
  assert.equal(typeof (await turnOf(queued2.turnId)).settledAt, "string", "the control cancel path records its terminal time");

  const done = await acceptLongAgentTurn(f.input("settle-done"));
  await updateTurnStatus(f.home, done.turnId, "completed");
  assert.equal(typeof (await turnOf(done.turnId)).settledAt, "string");

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  f.setHandler(async () => { await gate; return { content: "RETRIED" }; });
  const retry = await acceptLongAgentTurn(f.input("settle-retry"));
  await updateTurnStatus(f.home, retry.turnId, "failed", "boom");
  assert.equal(typeof (await turnOf(retry.turnId)).settledAt, "string");
  const pendingRetry = controlQueuedRequest(f.home, "friend", retry.turnId, "retry");
  const deadline = Date.now() + 5_000;
  let observed = await turnOf(retry.turnId);
  while (Date.now() < deadline && observed.status !== "running") {
    await new Promise((resolve) => setTimeout(resolve, 20));
    observed = await turnOf(retry.turnId);
  }
  assert.equal(observed.status, "running");
  assert.equal(observed.settledAt, null, "a retry clears the stale completion time before it runs again");
  release();
  await pendingRetry;
  assert.equal((await turnOf(retry.turnId)).status, "completed");
});

test("LA6 D: legacy turns without settledAt still parse, but a queued turn with one is rejected", async (t) => {
  const { parseAcceptedTurn } = await import("../../src/long-agents/daily-state.ts");
  const base = {
    turnId: "t1", requestId: "r1", payloadHash: "a".repeat(64), summaryDraft: false, isNewSession: true,
    longAgentId: "friend", source: "chat-web", channelType: null, inboundEventId: null, contextProjectId: null,
    interactionRevision: null, payloadHashVersion: null, sessionId: "s1", date: "2026-09-21", timeZone: "UTC",
    acceptedAt: "2026-09-21T09:00:00.000Z", settledAt: null, sequence: 1, status: "completed", error: null,
    groupContext: { contextRevision: `sha256:${"a".repeat(64)}`, agentGroupId: "g", agentGroupRevision: `sha256:${"b".repeat(64)}`,
      indexRevision: `sha256:${"c".repeat(64)}`, definitionRevision: `sha256:${"d".repeat(64)}`, stale: false, fetchedAt: "2026-09-21T09:00:00.000Z" },
  };
  // Pre-field history: a terminal turn without settledAt keeps parsing (production compatibility).
  assert.equal(parseAcceptedTurn({ ...base }).status, "completed");
  assert.equal(parseAcceptedTurn({ ...base, settledAt: "2026-09-21T09:10:00.000Z" }).settledAt, "2026-09-21T09:10:00.000Z");
  // A non-terminal request carrying a completion time is a writer bug and must fail closed.
  assert.throws(() => parseAcceptedTurn({ ...base, status: "queued", text: "x", seed: [], settledAt: "2026-09-21T09:10:00.000Z" }), /未完成请求不能携带完成时间/);
  assert.equal(parseAcceptedTurn({ ...base, status: "queued", text: "x", seed: [], settledAt: null }).status, "queued");
});
