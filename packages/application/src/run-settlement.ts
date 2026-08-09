import { transitionRunLifecycle } from "@chat/domain";
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
