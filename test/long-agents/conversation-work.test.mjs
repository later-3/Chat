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

test("LA5 S8: a group task runs independently, verifies its origin and publishes an authorized result", async (t) => {
  const f = await fixture(t);
  const { conversation, originEntryId } = await setup(f, "req-work-1");
  f.setHandler(() => ({ content: "WORK_RESULT_ONE" }));
  const started = await startConversationWork({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend",
    requestId: "work-req-1", title: "后台研究", instruction: "研究并给出结论", originEntryId,
  });
  assert.equal(started.created, true);
  assert.equal(started.work.status, "queued");
  // The task does not occupy a discussion round or its budget.
  assert.equal((await import("../../src/long-agents/conversations/discussions.ts")).readDiscussionState !== undefined, true);
  await drainConversationWorks({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id });
  const works = await listConversationWorks(f.home, "a", conversation.id);
  assert.equal(works[0].status, "completed");
  assert.equal(typeof works[0].publicationId, "string");
  const visible = await projection(f, conversation);
  assert.equal(visible.some((message) => message.text === "WORK_RESULT_ONE"), true);
  // Idempotent per requestId with the same input.
  const repeat = await startConversationWork({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend",
    requestId: "work-req-1", title: "后台研究", instruction: "研究并给出结论", originEntryId,
  });
  assert.equal(repeat.created, false);
  assert.equal(repeat.work.workId, started.work.workId);
});

test("LA5 S8: a forged origin is refused and a revoked member's task is cancelled, not published", async (t) => {
  const f = await fixture(t);
  const { conversation } = await setup(f, "req-work-2");
  await assert.rejects(startConversationWork({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend",
    requestId: "work-forged", title: "伪造来源", instruction: "x", originEntryId: "not-a-public-entry",
  }), /来源条目不在该成员有权读取的公共投影中/);

  f.setHandler(() => ({ content: "MUST_NOT_APPEAR" }));
  await startConversationWork({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend",
    requestId: "work-revoked", title: "撤销后任务", instruction: "不应发布",
  });
  await revokeMember({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend", expectedRevision: (await readConversation(f.home, "a", conversation.id)).revision });
  await drainConversationWorks({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id });
  const works = await listConversationWorks(f.home, "a", conversation.id);
  const cancelled = works.find((work) => work.title === "撤销后任务");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(f.requests.length, 0, "a revoked member's task never calls the model");
  const visible = await projection(f, conversation);
  assert.equal(JSON.stringify(visible).includes("MUST_NOT_APPEAR"), false);
});

test("LA5 S8: a discussion-derived sub-work is charged to its root budget and never escapes it", async (t) => {
  const f = await fixture(t);
  const conversation = await createConversation({
    chatHome: f.home, storageProjectId: "a", title: "预算群", requestId: "req-work-budget", memberLongAgentIds: ["friend"],
    budget: { maxModelCalls: 1 },
  });
  await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend" });
  await startConversationDiscussion({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, discussionId: "root-1",
    policy: "mention", round: 1, inputCutoffEntryId: null, budget: conversation.budget,
  });
  // The root already used its single allowed call.
  await recordDiscussionModelCall({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, discussionId: "root-1" });
  // A derived sub-work cannot claim an independent budget, and must name its root.
  await assert.rejects(startConversationWork({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend",
    requestId: "work-orphan", title: "孤儿任务", instruction: "x", source: "discussion",
  }), /根讨论/);
  f.setHandler(() => ({ content: "MUST_NOT_RUN" }));
  const derived = await startConversationWork({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend",
    requestId: "work-derived", title: "派生任务", instruction: "研究", source: "discussion", discussionId: "root-1",
  });
  await drainConversationWorks({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id });
  const after = (await listConversationWorks(f.home, "a", conversation.id)).find((work) => work.workId === derived.work.workId);
  assert.equal(after.status, "failed");
  assert.match(after.error, /根预算已用尽/);
  assert.equal(f.requests.length, 0, "an over-budget sub-work never calls the model");
  const root = (await readDiscussionState(f.home, "a", conversation.id)).discussions.find((item) => item.discussionId === "root-1");
  assert.equal(root.modelCalls, 1, "the root budget is unchanged because nothing ran");
});

test("LA5 S8: a within-budget sub-work adds its model call to the root discussion", async (t) => {
  const f = await fixture(t);
  const conversation = await createConversation({
    chatHome: f.home, storageProjectId: "a", title: "预算群二", requestId: "req-work-budget-2", memberLongAgentIds: ["friend"],
    budget: { maxModelCalls: 2 },
  });
  await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend" });
  await startConversationDiscussion({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, discussionId: "root-2",
    policy: "mention", round: 1, inputCutoffEntryId: null, budget: conversation.budget,
  });
  f.setHandler(() => ({ content: "DERIVED_RESULT" }));
  await startConversationWork({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend",
    requestId: "work-derived-2", title: "派生任务二", instruction: "研究", source: "discussion", discussionId: "root-2",
  });
  await drainConversationWorks({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id });
  const root = (await readDiscussionState(f.home, "a", conversation.id)).discussions.find((item) => item.discussionId === "root-2");
  assert.equal(root.modelCalls, 1, "the sub-work's real model call is charged to the root");
});

test("LA5 S8: a queued task can be cancelled before it runs", async (t) => {
  const f = await fixture(t);
  const { conversation } = await setup(f, "req-work-3");
  const started = await startConversationWork({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend",
    requestId: "work-cancel", title: "可取消任务", instruction: "不要执行",
  });
  const cancelled = await cancelConversationWork({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, workId: started.work.workId });
  assert.equal(cancelled.status, "cancelled");
  await drainConversationWorks({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id });
  assert.equal(f.requests.length, 0, "a cancelled task is never drained");
});
