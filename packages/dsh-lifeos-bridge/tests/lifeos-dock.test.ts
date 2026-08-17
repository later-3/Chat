import assert from "node:assert/strict";
import test from "node:test";
import { lifeosProjectionSchema } from "../src/contracts.ts";
import { hasActionableReview, shouldShowLifeosReviewDock } from "../src/client/LifeosDock.tsx";

const timestamp = "2026-08-17T08:00:00.000Z";
const planSha256 = "a".repeat(64);

function reviewProjection() {
  return lifeosProjectionSchema.parse({
    schemaVersion: "chat-dsh-lifeos-bridge.v2",
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
      expiresAt: "2026-08-18T08:00:00.000Z",
    },
    pendingDecision: null,
    workflowSelection: null,
  });
}

test("review dock is visible only while the current approval is actionable", () => {
  const waiting = reviewProjection();
  assert.equal(hasActionableReview(waiting), true);
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
  assert.equal(hasActionableReview(completed), false);
  assert.equal(shouldShowLifeosReviewDock(completed), false);

  const planning = lifeosProjectionSchema.parse({
    ...waiting,
    run: {
      ...waiting.run,
      status: "running",
      phase: "planning",
      allowedActions: [],
    },
    plan: null,
    approval: null,
  });
  assert.equal(shouldShowLifeosReviewDock(planning), false);
  assert.equal(shouldShowLifeosReviewDock(null), false);
});

test("review dock remains visible when an outcome-unknown decision needs exact retry", () => {
  const waiting = reviewProjection();
  const pending = lifeosProjectionSchema.parse({
    ...waiting,
    run: { ...waiting.run, status: "running", phase: "executing", allowedActions: [] },
    approval: { ...waiting.approval, status: "decided" },
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
  assert.equal(hasActionableReview(pending), false);
  assert.equal(shouldShowLifeosReviewDock(pending), true);
});
