import assert from "node:assert/strict";
import test from "node:test";
import { lifeosProjectionSchema } from "../src/contracts.ts";
import {
  hasActionableNoteReview,
  hasActionablePlanReview,
  shouldShowLifeosReviewDock,
} from "../src/client/LifeosDock.tsx";

const timestamp = "2026-08-18T08:00:00.000Z";
const planSha256 = "a".repeat(64);

function planReviewProjection() {
  return lifeosProjectionSchema.parse({
    schemaVersion: "chat-dsh-lifeos-bridge.v3",
    dshSessionId: "dsh-session-review",
    run: {
      productRunId: "run_review1",
      status: "waiting_human",
      phase: "plan_review",
      allowedActions: ["request_revision", "approve", "reject"],
      revision: 2,
      updatedAt: timestamp,
    },
    plan: {
      schemaVersion: "chat-product-api.v1",
      planId: "pln_review1",
      planRevision: 1,
      status: "under_review",
      sha256: planSha256,
      content: {
        objective: "完成验证",
        summary: "审核后执行。",
        assumptions: [],
        openQuestions: [],
        steps: [
          {
            stepId: "step-1",
            title: "执行",
            purpose: "完成目标",
            dependsOn: [],
            inputRefs: [],
            expectedOutput: "验证结果",
            successCriteria: ["验证通过"],
            requestedCapabilities: [],
            risk: "low",
          },
        ],
        completionCriteria: ["验证通过"],
        warnings: [],
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    approval: {
      schemaVersion: "chat-product-api.v1",
      approvalRequestId: "apr_review1",
      productRunId: "run_review1",
      planId: "pln_review1",
      planRevision: 1,
      planSha256,
      status: "open",
      createdAt: timestamp,
      expiresAt: "2026-08-19T08:00:00.000Z",
    },
    pendingDecision: null,
    noteCandidate: null,
    pendingNoteDecision: null,
    workflowSelection: null,
  });
}

function noteReviewProjection() {
  return lifeosProjectionSchema.parse({
    schemaVersion: "chat-dsh-lifeos-bridge.v3",
    dshSessionId: "dsh-session-note-review",
    run: {
      productRunId: "run_notereview1",
      status: "waiting_human",
      phase: "note_review",
      allowedActions: [],
      revision: 2,
      updatedAt: timestamp,
    },
    plan: null,
    approval: null,
    pendingDecision: null,
    noteCandidate: {
      schemaVersion: "chat-note-api.v1",
      noteCandidateId: "ntc_review1",
      productRunId: "run_notereview1",
      candidateSequence: 1,
      proposed: {
        title: "候选笔记",
        kind: "general",
        contentMarkdown: "需要人工确认的正文。",
        tags: [{ key: "review", label: "审核" }],
      },
      sourceRefs: [
        {
          kind: "full_message",
          sourceMessageId: "msg_review1",
          sourceMessageSha256: "c".repeat(64),
        },
      ],
      sha256: "d".repeat(64),
      revision: 1,
      status: "under_review",
      allowedActions: ["confirm", "request_revision", "reject"],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    pendingNoteDecision: null,
    workflowSelection: null,
  });
}

test("review dock retires plan cards as soon as the confirmed decision is no longer actionable", () => {
  const waiting = planReviewProjection();
  assert.equal(hasActionablePlanReview(waiting), true);
  assert.equal(shouldShowLifeosReviewDock(waiting), true);

  const completed = lifeosProjectionSchema.parse({
    ...waiting,
    run: {
      ...waiting.run,
      status: "succeeded",
      phase: "completed",
      allowedActions: [],
      revision: 4,
    },
    plan: { ...waiting.plan, status: "approved" },
    approval: { ...waiting.approval, status: "decided" },
  });
  assert.equal(hasActionablePlanReview(completed), false);
  assert.equal(shouldShowLifeosReviewDock(completed), false);
});

test("review dock applies the same transient lifecycle to note candidates", () => {
  const waiting = noteReviewProjection();
  assert.equal(hasActionableNoteReview(waiting), true);
  assert.equal(shouldShowLifeosReviewDock(waiting), true);

  const completed = lifeosProjectionSchema.parse({
    ...waiting,
    run: {
      ...waiting.run,
      status: "succeeded",
      phase: "completed",
      revision: 4,
    },
  });
  assert.equal(hasActionableNoteReview(completed), false);
  assert.equal(shouldShowLifeosReviewDock(completed), false);
});

test("review dock remains visible only for an outcome-unknown decision that must be retried", () => {
  const plan = planReviewProjection();
  const pendingPlan = lifeosProjectionSchema.parse({
    ...plan,
    run: { ...plan.run, status: "running", phase: "executing", allowedActions: [] },
    approval: { ...plan.approval, status: "decided" },
    pendingDecision: {
      kind: "approve",
      binding: {
        productRunId: "run_review1",
        runRevision: 2,
        approvalRequestId: "apr_review1",
        planId: "pln_review1",
        planRevision: 1,
        planSha256,
      },
    },
  });
  assert.equal(hasActionablePlanReview(pendingPlan), false);
  assert.equal(shouldShowLifeosReviewDock(pendingPlan), true);

  const note = noteReviewProjection();
  const pendingNote = lifeosProjectionSchema.parse({
    ...note,
    run: { ...note.run, status: "running", phase: "executing" },
    pendingNoteDecision: {
      kind: "confirm",
      binding: {
        productRunId: "run_notereview1",
        runRevision: 2,
        noteCandidateId: "ntc_review1",
        candidateRevision: 1,
        candidateSha256: "d".repeat(64),
      },
    },
  });
  assert.equal(hasActionableNoteReview(pendingNote), false);
  assert.equal(shouldShowLifeosReviewDock(pendingNote), true);
  assert.equal(shouldShowLifeosReviewDock(null), false);
});
