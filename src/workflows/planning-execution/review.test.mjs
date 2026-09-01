import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { openProject } from "../../projects/registry.ts";
import { recordPlanReviewDecisionStep } from "./steps.ts";
import {
  assertPlanReviewDecisionMatches,
  parsePlanReviewDecision,
} from "./review.ts";
import {
  appendPlanReview,
  appendPlanReviewDecision,
  bindPlanningExecutionRun,
  collectPendingPlanReview,
  findActivePlanningExecutionRun,
  getPlanningExecutionRun,
  planSha256,
  publishPlanReviewState,
  setPlanningExecutionPhase,
} from "./review-state.ts";

function review(overrides = {}) {
  const plan = overrides.plan ?? "first plan";
  return {
    schemaVersion: 1,
    workflowId: "planning-execution",
    stageId: "review",
    reviewId: "invocation-1:1:review",
    workflowInvocationId: "invocation-1",
    sessionId: "session-1",
    planRevision: 1,
    planSha256: planSha256(plan),
    planEntryId: "plan-entry-1",
    plan,
    readiness: "ready_for_review",
    blockingQuestions: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

test("a revision decision requires exact feedback and exact plan binding", () => {
  const current = review();
  const decision = parsePlanReviewDecision({
    kind: "request_revision",
    reviewId: current.reviewId,
    workflowInvocationId: current.workflowInvocationId,
    planRevision: current.planRevision,
    planSha256: current.planSha256,
    feedback: "  split the migration into two reversible steps  ",
  });
  assert.equal(decision.feedback, "  split the migration into two reversible steps  ");
  assert.doesNotThrow(() => assertPlanReviewDecisionMatches(decision, current));
  assert.throws(() => parsePlanReviewDecision({ ...decision, feedback: " " }), /feedback/);
  assert.throws(
    () => assertPlanReviewDecisionMatches({ ...decision, planRevision: 2 }, current),
    /版本不匹配/,
  );
});

test("a clarification review cannot be approved before blocking information is supplied", () => {
  const clarification = review({
    readiness: "needs_clarification",
    blockingQuestions: ["What budget should the Executor use?"],
  });
  const approval = parsePlanReviewDecision({
    kind: "approve",
    reviewId: clarification.reviewId,
    workflowInvocationId: clarification.workflowInvocationId,
    planRevision: clarification.planRevision,
    planSha256: clarification.planSha256,
  });
  assert.throws(
    () => assertPlanReviewDecisionMatches(approval, clarification),
    /阻塞信息.*不能批准执行/,
  );
  const supplied = parsePlanReviewDecision({
    ...approval,
    kind: "request_revision",
    feedback: "The budget is 300 CNY.",
  });
  assert.doesNotThrow(() => assertPlanReviewDecisionMatches(supplied, clarification));
});

test("review requests and decisions remain append-only facts in one Pi Session", () => {
  const manager = SessionManager.inMemory("/workspace");
  const pending = review();
  appendPlanReview(manager, pending);
  assert.deepEqual(collectPendingPlanReview(manager.getEntries()), pending);
  const messageEntryId = manager.appendMessage({
    role: "user",
    content: "已通过执行计划 v1，开始执行。",
    timestamp: 1,
  });
  appendPlanReviewDecision(manager, {
    schemaVersion: 3,
    workflowId: "planning-execution",
    stageId: "review",
    kind: "approve",
    reviewId: pending.reviewId,
    workflowInvocationId: pending.workflowInvocationId,
    planRevision: pending.planRevision,
    planSha256: pending.planSha256,
    messageEntryId,
    decidedAt: "2026-09-01T00:01:00.000Z",
  });
  assert.equal(collectPendingPlanReview(manager.getEntries()), undefined);
  assert.equal(manager.buildSessionContext().messages.length, 1);
});

test("recording revision feedback writes one native user message and references it idempotently", { concurrency: false }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-native-review-feedback-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const chatHome = path.join(root, "home");
  const project = await openProject({
    path: workspace,
    chatHome,
    id: "native-review-feedback",
    name: "Native Review Feedback",
  });
  const manager = SessionManager.create(project.cwd, project.sessionDir);
  manager.appendMessage({ role: "user", content: "original request", timestamp: 1 });
  manager.appendMessage({
    role: "assistant",
    provider: "test",
    model: "planner",
    content: [{ type: "text", text: "first plan" }],
    timestamp: 2,
  });
  manager.flush();
  const decision = {
    kind: "request_revision",
    reviewId: "native-review:1",
    workflowInvocationId: "native-review",
    planRevision: 1,
    planSha256: planSha256("first plan"),
    feedback: "keep the current Session and add rollback",
  };
  const input = {
    projectId: project.projectId,
    chatHome,
    cwd: workspace,
    sessionId: manager.getSessionId(),
    workflowInvocationId: "native-review",
    decision,
  };
  const first = await recordPlanReviewDecisionStep(input);
  const second = await recordPlanReviewDecisionStep(input);
  assert.equal(first.messageEntryId, first.feedbackEntryId);
  assert.equal(second.messageEntryId, first.messageEntryId);
  assert.equal(second.feedbackEntryId, first.feedbackEntryId);
  const reopened = SessionManager.open(manager.getSessionFile(), project.sessionDir);
  const feedbackMessages = reopened.getEntries().filter((entry) => entry.type === "message"
    && entry.message.role === "user" && entry.message.content[0]?.text === decision.feedback);
  assert.equal(feedbackMessages.length, 1);
  const persistedDecision = reopened.getEntries().findLast((entry) => entry.type === "custom"
    && entry.customType === "chat.plan_review_decision");
  assert.equal(persistedDecision.data.schemaVersion, 3);
  assert.equal(persistedDecision.data.messageEntryId, feedbackMessages[0].id);
  assert.equal(persistedDecision.data.feedbackEntryId, feedbackMessages[0].id);
});

test("recording approval writes one native user message and references it idempotently", { concurrency: false }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-native-review-approval-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const chatHome = path.join(root, "home");
  const project = await openProject({
    path: workspace,
    chatHome,
    id: "native-review-approval",
    name: "Native Review Approval",
  });
  const manager = SessionManager.create(project.cwd, project.sessionDir);
  manager.appendMessage({ role: "user", content: "original request", timestamp: 1 });
  manager.appendMessage({
    role: "assistant",
    provider: "test",
    model: "planner",
    content: [{ type: "text", text: "first plan" }],
    timestamp: 2,
  });
  manager.flush();
  const decision = {
    kind: "approve",
    reviewId: "native-review:1",
    workflowInvocationId: "native-review",
    planRevision: 1,
    planSha256: planSha256("first plan"),
  };
  const input = {
    projectId: project.projectId,
    chatHome,
    cwd: workspace,
    sessionId: manager.getSessionId(),
    workflowInvocationId: "native-review",
    decision,
  };

  const first = await recordPlanReviewDecisionStep(input);
  const second = await recordPlanReviewDecisionStep(input);
  assert.equal(second.messageEntryId, first.messageEntryId);
  assert.equal(first.feedbackEntryId, undefined);

  const reopened = SessionManager.open(manager.getSessionFile(), project.sessionDir);
  const approvalMessages = reopened.getEntries().filter((entry) => entry.type === "message"
    && entry.message.role === "user"
    && entry.message.content[0]?.text === "已通过执行计划 v1，开始执行。");
  assert.equal(approvalMessages.length, 1);
  assert.equal(approvalMessages[0].id, first.messageEntryId);
  const decisions = reopened.getEntries().filter((entry) => entry.type === "custom"
    && entry.customType === "chat.plan_review_decision"
    && entry.data.reviewId === decision.reviewId);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].data.schemaVersion, 3);
  assert.equal(decisions[0].data.messageEntryId, first.messageEntryId);
});

test("run binding and review publication merge safely regardless of write order", async (t) => {
  const projectDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-plan-review-store-"));
  t.after(() => fs.rmSync(projectDataDir, { recursive: true, force: true }));
  const pending = review();
  await Promise.all([
    publishPlanReviewState({ projectDataDir, projectId: "project-1", review: pending }),
    bindPlanningExecutionRun({
      projectDataDir,
      projectId: "project-1",
      workflowInvocationId: pending.workflowInvocationId,
      runId: "run-1",
    }),
  ]);
  assert.deepEqual(await getPlanningExecutionRun(projectDataDir, pending.workflowInvocationId), {
    schemaVersion: 1,
    projectId: "project-1",
    workflowId: "planning-execution",
    workflowInvocationId: "invocation-1",
    runId: "run-1",
    sessionId: "session-1",
    phase: "waiting_review",
    currentReview: pending,
    updatedAt: (await getPlanningExecutionRun(projectDataDir, pending.workflowInvocationId)).updatedAt,
  });
  const next = await setPlanningExecutionPhase({
    projectDataDir,
    projectId: "project-1",
    workflowInvocationId: pending.workflowInvocationId,
    sessionId: pending.sessionId,
    phase: "planning",
  });
  assert.equal(next.runId, "run-1");
  assert.equal(next.currentReview, undefined);
});

test("a terminal run cannot be revived by a late planning or review write", async (t) => {
  const projectDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-plan-terminal-store-"));
  t.after(() => fs.rmSync(projectDataDir, { recursive: true, force: true }));
  const pending = review({ workflowInvocationId: "invocation-terminal" });
  await bindPlanningExecutionRun({
    projectDataDir,
    projectId: "project-1",
    workflowInvocationId: pending.workflowInvocationId,
    runId: "run-terminal",
    sessionId: pending.sessionId,
  });
  assert.equal(
    (await findActivePlanningExecutionRun(projectDataDir, pending.sessionId))?.runId,
    "run-terminal",
  );
  await setPlanningExecutionPhase({
    projectDataDir,
    projectId: "project-1",
    workflowInvocationId: pending.workflowInvocationId,
    sessionId: pending.sessionId,
    phase: "cancelled",
  });
  await setPlanningExecutionPhase({
    projectDataDir,
    projectId: "project-1",
    workflowInvocationId: pending.workflowInvocationId,
    sessionId: pending.sessionId,
    phase: "planning",
  });
  await publishPlanReviewState({ projectDataDir, projectId: "project-1", review: pending });
  const terminal = await getPlanningExecutionRun(projectDataDir, pending.workflowInvocationId);
  assert.equal(terminal.phase, "cancelled");
  assert.equal(terminal.currentReview, undefined);
  assert.equal(await findActivePlanningExecutionRun(projectDataDir, pending.sessionId), undefined);
});
