import {
  transitionDirectAgentRunLifecycle,
  transitionPromptReviewStatus,
  transitionRunLifecycle,
} from "@chat/domain";
import type { ProductRun, ProductRunId, ProductSnapshot } from "@chat/contracts";
import type { ApplicationDeps } from "./deps.js";
import { notFound } from "./errors.js";
import { emitRunEvent } from "./trace-helpers.js";
import { synchronizePlanningWorkflowProjection } from "./planning-workflow-projection.js";

/** 失败/结果未知的产品事实收敛；跨Runtime派发由Outbox用例负责。 */
export function settleRunWithoutSuccess(
  draft: ProductSnapshot,
  productRunId: ProductRunId,
  status: "failed" | "outcome_unknown",
  errorCode: string,
  summary: string,
  now: string,
): void {
  const run = draft.entities.runs[productRunId];
  if (run === undefined) throw notFound("Product Run不存在");
  if (
    run.status === "succeeded" ||
    run.status === "failed" ||
    run.status === "cancelled" ||
    run.status === "outcome_unknown"
  ) {
    failRunningAttempts(draft, productRunId, now, errorCode);
    synchronizePlanningWorkflowProjection(draft, productRunId, now);
    return;
  }
  if (run.runKind === "note_capture") {
    draft.entities.runs[productRunId] = {
      ...run,
      status,
      failure: { code: errorCode, summary },
      revision: run.revision + 1,
      updatedAt: now,
    };
    failRunningAttempts(draft, productRunId, now, errorCode);
    return;
  }
  if (run.runKind === "direct_agent") {
    const promptReviews = Object.values(draft.entities.promptReviewRequests).filter(
      (review) => review.productRunId === productRunId,
    );
    const providerBoundaryCrossed = promptReviews.some((review) => review.status === "dispatching");
    // dispatching表示一次性permit已交付，Provider fetch是否发生已无法由普通异常证明。
    // 即使调用方报告failed，也必须保守收敛为outcome_unknown，禁止自动重发。
    const effectiveStatus = providerBoundaryCrossed ? "outcome_unknown" : status;
    const current =
      run.status === "pending" && run.phase === "queued"
        ? ({ status: "pending", phase: "queued" } as const)
        : run.status === "running" && run.phase === "executing"
          ? ({ status: "running", phase: "executing" } as const)
          : run.status === "waiting_human" && run.phase === "prompt_review"
            ? ({ status: "waiting_human", phase: "prompt_review" } as const)
            : undefined;
    if (current === undefined) throw new Error("Direct Agent Run生命周期事实损坏");
    const lifecycle =
      effectiveStatus === "failed"
        ? transitionDirectAgentRunLifecycle(current, {
            status: "failed",
            phase: current.phase,
          })
        : current.phase === "prompt_review"
          ? (() => {
              throw new Error("Prompt Review尚未越过Provider边界，不能收敛为outcome_unknown");
            })()
          : transitionDirectAgentRunLifecycle(current, {
              status: "outcome_unknown",
              phase: current.phase,
            });
    const settled = {
      ...run,
      status: lifecycle.status,
      phase: lifecycle.phase,
      failure: { code: errorCode, summary },
      revision: run.revision + 1,
      updatedAt: now,
    };
    delete settled.currentPromptReviewRequestId;
    draft.entities.runs[productRunId] = settled;
    for (const review of promptReviews) {
      const terminalStatus =
        review.status === "open" || review.status === "approved"
          ? "cancelled"
          : review.status === "dispatching"
            ? "outcome_unknown"
            : undefined;
      if (terminalStatus === undefined) continue;
      draft.entities.promptReviewRequests[review.promptReviewRequestId] = {
        ...review,
        status: transitionPromptReviewStatus(review.status, terminalStatus),
        revision: review.revision + 1,
        updatedAt: now,
      };
    }
    failRunningAttempts(draft, productRunId, now, errorCode);
    return;
  }
  const lifecycle = transitionRunLifecycle(
    { status: run.status, phase: run.phase },
    { status, phase: run.phase },
  );
  const settled = {
    ...run,
    status: lifecycle.status,
    phase: lifecycle.phase,
    failure: { code: errorCode, summary },
    revision: run.revision + 1,
    updatedAt: now,
  };
  delete settled.currentApprovalRequestId;
  draft.entities.runs[productRunId] = settled;
  for (const approval of Object.values(draft.entities.approvalRequests)) {
    if (approval.productRunId === productRunId && approval.status === "open") {
      draft.entities.approvalRequests[approval.approvalRequestId] = {
        ...approval,
        status: "expired",
        expiredAt: now,
        revision: approval.revision + 1,
        updatedAt: now,
      };
    }
  }
  for (const plan of Object.values(draft.entities.plans)) {
    if (plan.productRunId === productRunId && plan.status === "under_review") {
      draft.entities.plans[plan.planRevisionId] = {
        ...plan,
        status: "expired",
        revision: plan.revision + 1,
        updatedAt: now,
      };
    }
  }
  failRunningAttempts(draft, productRunId, now, errorCode);
  synchronizePlanningWorkflowProjection(draft, productRunId, now);
}

export function emitProductRunTransition(
  deps: ApplicationDeps,
  priorRun: ProductRun,
  settledRun: ProductRun,
  level: "info" | "warn",
): void {
  if (priorRun.status === settledRun.status && priorRun.phase === settledRun.phase) return;
  emitRunEvent(deps, settledRun.productRunId, {
    level,
    eventName: "product_run.transitioned",
    outcome: "success",
    productRunId: settledRun.productRunId,
    fromStatus: priorRun.status,
    toStatus: settledRun.status,
    fromPhase: priorRun.phase,
    toPhase: settledRun.phase,
    revision: settledRun.revision,
  });
}

function failRunningAttempts(
  draft: ProductSnapshot,
  productRunId: ProductRunId,
  now: string,
  errorCode: string,
): void {
  for (const attempt of Object.values(draft.entities.attempts)) {
    if (attempt.productRunId !== productRunId || attempt.outcome !== "running") continue;
    draft.entities.attempts[attempt.attemptId] = {
      ...attempt,
      outcome: "failure",
      errorCode,
      revision: attempt.revision + 1,
      updatedAt: now,
    };
  }
}
