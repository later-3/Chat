import { hashCanonical } from "@chat/domain";
import {
  assertDecisionBinding,
  assertSingleOpenApproval,
  assertSinglePlanUnderReview,
  canTransitionPlanStatus,
  DomainInvariantError,
  nextPlanRevision,
  transitionRunLifecycle,
  validatePlanSemantics,
  type RunLifecycle,
} from "@chat/domain";
import type {
  ApprovalDto,
  ApprovalRequest,
  CommandId,
  Decision,
  DecisionDto,
  PlanContent,
  PlanDto,
  PlanRevision,
  PrincipalId,
  ProductRunId,
  RunAttemptId,
  RunDto,
  SubmitDecisionPayload,
} from "@chat/contracts";
import { B2_MAX_PLAN_STEPS, EXECUTION_CAPABILITY_MARKDOWN_COMPOSE } from "@chat/contracts";
import { DEFAULT_APPROVAL_TTL_MS, type ApplicationDeps } from "./deps.js";
import { toApprovalDto, toDecisionDto, toPlanDto, toRunDto } from "./dto.js";
import { ApplicationError, forbidden, notFound, revisionConflict } from "./errors.js";
import { emitRunEvent, safeErrorType } from "./trace-helpers.js";

/**
 * PublishPlanForReview / SubmitPlanDecision用例。
 *
 * 事务边界（任务书§9.2）：
 * - 新Plan产生时上一版进入superseded，旧版本不删除。
 * - 一个Run任意时刻最多一个under_review Plan和一个open Approval Request。
 * - Decision绑定approvalRequestId + planId + planRevision + planSha256；
 *   过期、旧revision、错误Hash、错误Principal和已决定Request全部失败关闭。
 * - request_revision / approve / reject都形成产品Decision + Resume Outbox，
 *   浏览器不直接恢复Hook。
 */

export interface PublishPlanForReviewInput {
  readonly productRunId: ProductRunId;
  readonly commandId: CommandId;
  readonly content: PlanContent;
  /** 候选必须绑定本轮编译输入的Planning Attempt与Run CAS。 */
  readonly attemptId: RunAttemptId;
  readonly expectedRunRevision: number;
  readonly inputManifestSha256: string;
}

/**
 * Plan审批Hash的唯一实现（任务书§8.6）：canonical JSON + SHA-256 + Schema版本域。
 * 发布用例与Store启动校验都使用本函数，不得在别处复制Hash输入组成。
 */
export function computePlanSha256(input: {
  readonly planId: string;
  readonly productRunId: string;
  readonly planRevision: number;
  readonly content: PlanContent;
}): string {
  return hashCanonical("plan-revision.v1", input);
}

export async function publishPlanForReview(
  deps: ApplicationDeps,
  input: PublishPlanForReviewInput,
): Promise<{ plan: PlanDto; approval: ApprovalDto; run: RunDto }> {
  const semanticIssues = validatePlanSemantics(input.content.steps, {
    maxSteps: B2_MAX_PLAN_STEPS,
    allowedCapabilities: new Set([EXECUTION_CAPABILITY_MARKDOWN_COMPOSE]),
    // B2尚未接入Memory/主动上下文选择；源Message由PlanningInput固定传入，不是contextRef。
    allowedContextRefs: new Set(),
  });
  if (semanticIssues.length !== 0) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 400,
      message: semanticIssues[0]?.detail ?? "Plan语义校验失败",
    });
  }
  const now = deps.now();
  const newPlanId = deps.ids.plan();
  const planRevisionId = deps.ids.planRevision();
  const approvalRequestId = deps.ids.approval();
  const expiresAt = new Date(Date.parse(now) + DEFAULT_APPROVAL_TTL_MS).toISOString();
  const requestSha256 = hashCanonical("command.publish-plan-for-review.v1", {
    productRunId: input.productRunId,
    attemptId: input.attemptId,
    expectedRunRevision: input.expectedRunRevision,
    inputManifestSha256: input.inputManifestSha256,
    content: input.content,
  });

  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "PublishPlanForReview",
    requestSha256,
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const run = draft.entities.runs[input.productRunId];
      if (run === undefined) throw notFound("Product Run不存在");
      if (run.revision !== input.expectedRunRevision) {
        throw revisionConflict("Run revision已变化，拒绝发布陈旧Plan Candidate");
      }

      const existingPlans = Object.values(draft.entities.plans).filter(
        (plan) => plan.productRunId === input.productRunId,
      );
      let planRevision: number;
      try {
        planRevision = nextPlanRevision(
          existingPlans.map((plan) => plan.planRevision),
          run.maxPlanRevisions,
        );
      } catch (error) {
        if (error instanceof DomainInvariantError && error.code === "plan_revision_limit_reached") {
          throw new ApplicationError({
            code: "revision_conflict",
            httpStatus: 409,
            message: error.message,
            recoveryAction: "none",
          });
        }
        throw error;
      }
      const planId = existingPlans[0]?.planId ?? newPlanId;
      const attempt = draft.entities.attempts[input.attemptId];
      if (
        attempt === undefined ||
        attempt.productRunId !== input.productRunId ||
        attempt.kind !== "planning" ||
        attempt.outcome !== "running" ||
        attempt.planRevision !== planRevision ||
        attempt.inputRunRevision !== input.expectedRunRevision ||
        attempt.inputManifestSha256 !== input.inputManifestSha256
      ) {
        throw revisionConflict("Plan Candidate与当前Planning Attempt或输入证据不匹配");
      }

      // 生命周期：允许从pending/queued或running/planning进入审核中
      let lifecycle: RunLifecycle = { status: run.status, phase: run.phase };
      if (lifecycle.status === "pending" && lifecycle.phase === "queued") {
        lifecycle = mapRunTransition(lifecycle, { status: "running", phase: "planning" });
      }
      lifecycle = mapRunTransition(lifecycle, { status: "waiting_human", phase: "plan_review" });

      // 上一版under_review必须进入superseded；旧版本不删除
      for (const plan of existingPlans) {
        if (plan.status === "under_review") {
          if (!canTransitionPlanStatus(plan.status, "superseded")) {
            throw revisionConflict("当前Plan状态不允许被取代");
          }
          draft.entities.plans[plan.planRevisionId] = {
            ...plan,
            status: "superseded",
            revision: plan.revision + 1,
            updatedAt: now,
          };
        }
      }

      const planSha256 = computePlanSha256({
        planId,
        productRunId: input.productRunId,
        planRevision,
        content: input.content,
      });

      const plan: PlanRevision = {
        schemaVersion: "plan-revision.v1",
        planRevisionId,
        planId,
        productRunId: input.productRunId,
        planningAttemptId: input.attemptId,
        planRevision,
        status: "under_review",
        content: input.content,
        sha256: planSha256,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const approval: ApprovalRequest = {
        schemaVersion: "approval-request.v1",
        approvalRequestId,
        productRunId: input.productRunId,
        planId,
        planRevision,
        planSha256,
        status: "open",
        expiresAt,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };

      draft.entities.plans[planRevisionId] = plan;
      draft.entities.approvalRequests[approvalRequestId] = approval;
      draft.entities.attempts[input.attemptId] = {
        ...attempt,
        outcome: "success",
        revision: attempt.revision + 1,
        updatedAt: now,
      };
      assertSinglePlanUnderReview(
        Object.values(draft.entities.plans).filter(
          (candidate) => candidate.productRunId === input.productRunId,
        ),
      );
      assertSingleOpenApproval(
        Object.values(draft.entities.approvalRequests).filter(
          (candidate) => candidate.productRunId === input.productRunId,
        ),
      );

      draft.entities.runs[input.productRunId] = {
        ...run,
        status: lifecycle.status,
        phase: lifecycle.phase,
        currentPlanId: planId,
        currentPlanRevision: planRevision,
        currentApprovalRequestId: approvalRequestId,
        revision: run.revision + 1,
        updatedAt: now,
      };
      return {
        resultRefs: { planRevisionId, approvalRequestId, productRunId: input.productRunId },
      };
    },
  });

  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const plan = snapshot.entities.plans[result.resultRefs["planRevisionId"] ?? ""];
  const approval = snapshot.entities.approvalRequests[result.resultRefs["approvalRequestId"] ?? ""];
  const run = snapshot.entities.runs[input.productRunId];
  if (plan === undefined || approval === undefined || run === undefined) {
    throw notFound("Plan或Approval不存在");
  }
  if (!result.replayed) {
    const planRef = {
      objectType: "plan" as const,
      objectId: plan.planId,
      revision: plan.planRevision,
      sha256: plan.sha256,
    };
    emitRunEvent(deps, input.productRunId, {
      level: "info",
      eventName: "plan.candidate.published",
      outcome: "success",
      productRunId: input.productRunId,
      attemptId: input.attemptId,
      planRef,
    });
    emitRunEvent(deps, input.productRunId, {
      level: "info",
      eventName: "approval.created",
      outcome: "success",
      productRunId: input.productRunId,
      attemptId: input.attemptId,
      approvalRequestId: approval.approvalRequestId,
      planRef,
    });
    emitRunEvent(deps, input.productRunId, {
      level: "info",
      eventName: "product_run.transitioned",
      outcome: "success",
      productRunId: input.productRunId,
      fromStatus: "running",
      toStatus: "waiting_human",
      fromPhase: "planning",
      toPhase: "plan_review",
      revision: run.revision,
    });
  }
  return {
    plan: toPlanDto(plan),
    approval: toApprovalDto(approval),
    run: toRunDto(run, plan, approval),
  };
}

export interface SubmitPlanDecisionInput {
  readonly principalId: PrincipalId;
  readonly productRunId: ProductRunId;
  readonly commandId: CommandId;
  /** 即Command Envelope的expectedRevision；Decision Command必填。 */
  readonly expectedRunRevision: number;
  readonly payload: SubmitDecisionPayload;
}

export async function submitPlanDecision(
  deps: ApplicationDeps,
  input: SubmitPlanDecisionInput,
): Promise<{ decision: DecisionDto; run: RunDto }> {
  const now = deps.now();
  const decisionId = deps.ids.decision();
  const revisionInputId = deps.ids.revisionInput();
  const outboxId = deps.ids.outbox();
  const requestSha256 = hashCanonical("command.submit-plan-decision.v1", {
    principalId: input.principalId,
    productRunId: input.productRunId,
    expectedRunRevision: input.expectedRunRevision,
    payload: input.payload,
  });

  const result = await deps.store
    .transact({
      commandId: input.commandId,
      commandType: "SubmitPlanDecision",
      requestSha256,
      traceContext: { productRunId: input.productRunId },
      mutate: (draft) => {
        const run = draft.entities.runs[input.productRunId];
        if (run === undefined) throw notFound("Product Run不存在");
        if (run.revision !== input.expectedRunRevision) {
          throw revisionConflict("Run revision已变化，请重新读取后重试");
        }
        const session = draft.entities.sessions[run.sessionId];
        if (session === undefined) throw notFound("Session不存在");
        if (session.ownerPrincipalId !== input.principalId) {
          throw forbidden("无权决定该Product Run");
        }

        const approval = draft.entities.approvalRequests[input.payload.approvalRequestId];
        if (approval === undefined || approval.productRunId !== input.productRunId) {
          throw notFound("Approval Request不存在");
        }
        if (approval.status === "open" && Date.parse(now) >= Date.parse(approval.expiresAt)) {
          const expiredPlan = Object.values(draft.entities.plans).find(
            (candidate) =>
              candidate.productRunId === input.productRunId &&
              candidate.planId === approval.planId &&
              candidate.planRevision === approval.planRevision,
          );
          draft.entities.approvalRequests[approval.approvalRequestId] = {
            ...approval,
            status: "expired",
            expiredAt: now,
            revision: approval.revision + 1,
            updatedAt: now,
          };
          if (expiredPlan?.status === "under_review") {
            draft.entities.plans[expiredPlan.planRevisionId] = {
              ...expiredPlan,
              status: "expired",
              revision: expiredPlan.revision + 1,
              updatedAt: now,
            };
          }
          const expiredRun = {
            ...run,
            status: "failed" as const,
            phase: "plan_review" as const,
            failure: { code: "approval.expired", summary: "计划确认已过期，请重新开始" },
            revision: run.revision + 1,
            updatedAt: now,
          };
          delete expiredRun.currentApprovalRequestId;
          draft.entities.runs[input.productRunId] = expiredRun;
          return {
            resultRefs: {
              productRunId: input.productRunId,
              approvalExpired: "true",
            },
          };
        }
        mapDecisionBindingError(() =>
          assertDecisionBinding(approval, {
            planId: input.payload.planId,
            planRevision: input.payload.planRevision,
            planSha256: input.payload.planSha256,
          }),
        );

        const plan = Object.values(draft.entities.plans).find(
          (candidate) =>
            candidate.planId === input.payload.planId &&
            candidate.planRevision === input.payload.planRevision &&
            candidate.productRunId === input.productRunId,
        );
        if (plan === undefined) throw notFound("Plan Revision不存在");
        if (plan.status !== "under_review") {
          throw revisionConflict("当前Plan不在可决定状态");
        }
        if (plan.sha256 !== input.payload.planSha256) {
          throw new ApplicationError({
            code: "plan_hash_conflict",
            httpStatus: 409,
            message: "Plan Hash与持久化事实不一致",
          });
        }

        const nextPlanStatus =
          input.payload.kind === "approve"
            ? ("approved" as const)
            : input.payload.kind === "request_revision"
              ? ("superseded" as const)
              : ("rejected" as const);
        if (!canTransitionPlanStatus(plan.status, nextPlanStatus)) {
          throw revisionConflict("当前Plan状态不允许该决定");
        }
        const nextLifecycle: RunLifecycle =
          input.payload.kind === "approve"
            ? { status: "running", phase: "executing" }
            : input.payload.kind === "request_revision"
              ? { status: "running", phase: "planning" }
              : { status: "cancelled", phase: "rejected" };
        const lifecycle = mapRunTransition({ status: run.status, phase: run.phase }, nextLifecycle);

        if (
          input.payload.kind === "request_revision" &&
          input.payload.revisionInstruction !== undefined
        ) {
          draft.entities.revisionInputs[revisionInputId] = {
            schemaVersion: "revision-input.v1",
            revisionInputId,
            productRunId: input.productRunId,
            planId: plan.planId,
            planRevision: plan.planRevision,
            instruction: input.payload.revisionInstruction,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          };
        }

        const decision: Decision = {
          schemaVersion: "decision.v1",
          decisionId,
          approvalRequestId: approval.approvalRequestId,
          productRunId: input.productRunId,
          planId: plan.planId,
          planRevision: plan.planRevision,
          planSha256: plan.sha256,
          kind: input.payload.kind,
          ...(input.payload.kind === "request_revision" ? { revisionInputId } : {}),
          ...(input.payload.reason !== undefined ? { reason: input.payload.reason } : {}),
          principalId: input.principalId,
          commandId: input.commandId,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        draft.entities.decisions[decisionId] = decision;
        draft.entities.approvalRequests[approval.approvalRequestId] = {
          ...approval,
          status: "decided",
          decidedByDecisionId: decisionId,
          revision: approval.revision + 1,
          updatedAt: now,
        };
        draft.entities.plans[plan.planRevisionId] = {
          ...plan,
          status: nextPlanStatus,
          revision: plan.revision + 1,
          updatedAt: now,
        };
        const decidedRun = {
          ...run,
          status: lifecycle.status,
          phase: lifecycle.phase,
          revision: run.revision + 1,
          updatedAt: now,
        };
        delete decidedRun.currentApprovalRequestId;
        draft.entities.runs[input.productRunId] = decidedRun;
        // Resume Outbox与Decision同一次快照提交；Hook Token只属于Workflow Adapter
        draft.outbox[outboxId] = {
          schemaVersion: "outbox-entry.v1",
          outboxId,
          kind: "workflow_resume",
          status: "pending",
          productRunId: input.productRunId,
          approvalRequestId: approval.approvalRequestId,
          decisionId,
          dispatchAttempts: 0,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        return { resultRefs: { decisionId, productRunId: input.productRunId } };
      },
    })
    .catch(async (error: unknown) => {
      await emitRejectedDecision(deps, input, error);
      throw error;
    });

  if (result.resultRefs["approvalExpired"] === "true") {
    const expiredError = new ApplicationError({
      code: "approval_expired",
      httpStatus: 409,
      message: "Approval Request已过期",
      recoveryAction: "rehydrate_and_retry",
    });
    if (!result.replayed) {
      const { snapshot: expiredSnapshot } = await deps.store.read({ kind: "committedSnapshot" });
      const expiredRun = expiredSnapshot.entities.runs[input.productRunId];
      if (expiredRun !== undefined) {
        emitRunEvent(deps, input.productRunId, {
          level: "warn",
          eventName: "product_run.transitioned",
          outcome: "success",
          productRunId: input.productRunId,
          fromStatus: "waiting_human",
          toStatus: expiredRun.status,
          fromPhase: "plan_review",
          toPhase: expiredRun.phase,
          revision: expiredRun.revision,
        });
      }
      await emitRejectedDecision(deps, input, expiredError);
    }
    throw expiredError;
  }

  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const decision = snapshot.entities.decisions[result.resultRefs["decisionId"] ?? ""];
  const run = snapshot.entities.runs[input.productRunId];
  if (decision === undefined || run === undefined) throw notFound("Decision或Run不存在");
  const currentPlan = Object.values(snapshot.entities.plans).find(
    (plan) =>
      run.currentPlanId !== undefined &&
      plan.planId === run.currentPlanId &&
      plan.planRevision === run.currentPlanRevision,
  );
  const currentApproval =
    run.currentApprovalRequestId !== undefined
      ? snapshot.entities.approvalRequests[run.currentApprovalRequestId]
      : undefined;
  if (!result.replayed) {
    const planningAttempt = Object.values(snapshot.entities.attempts).find(
      (attempt) =>
        attempt.productRunId === input.productRunId &&
        attempt.kind === "planning" &&
        attempt.planRevision === decision.planRevision,
    );
    if (planningAttempt !== undefined) {
      const plan = Object.values(snapshot.entities.plans).find(
        (candidate) =>
          candidate.planId === decision.planId && candidate.planRevision === decision.planRevision,
      );
      if (plan !== undefined) {
        emitRunEvent(deps, input.productRunId, {
          level: "info",
          eventName: "decision.committed",
          outcome: "success",
          productRunId: input.productRunId,
          attemptId: planningAttempt.attemptId,
          commandId: input.commandId,
          decisionKind: decision.kind,
          decisionRef: {
            objectType: "decision",
            objectId: decision.decisionId,
            revision: decision.revision,
            sha256: hashCanonical("decision.v1", {
              decisionId: decision.decisionId,
              approvalRequestId: decision.approvalRequestId,
              productRunId: decision.productRunId,
              planId: decision.planId,
              planRevision: decision.planRevision,
              planSha256: decision.planSha256,
              kind: decision.kind,
              ...(decision.revisionInputId !== undefined
                ? { revisionInputId: decision.revisionInputId }
                : {}),
              ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
              principalId: decision.principalId,
              commandId: decision.commandId,
            }),
          },
          planRef: {
            objectType: "plan",
            objectId: plan.planId,
            revision: plan.planRevision,
            sha256: plan.sha256,
          },
        });
      }
    }
    emitRunEvent(deps, input.productRunId, {
      level: "info",
      eventName: "product_run.transitioned",
      outcome: "success",
      productRunId: input.productRunId,
      fromStatus: "waiting_human",
      toStatus: run.status,
      fromPhase: "plan_review",
      toPhase: run.phase,
      revision: run.revision,
    });
  }
  return { decision: toDecisionDto(decision), run: toRunDto(run, currentPlan, currentApproval) };
}

function mapRunTransition(from: RunLifecycle, to: RunLifecycle): RunLifecycle {
  try {
    return transitionRunLifecycle(from, to);
  } catch (error) {
    if (error instanceof DomainInvariantError) {
      throw revisionConflict(`Run状态不允许该转换:${from.status}/${from.phase}`);
    }
    throw error;
  }
}

function mapDecisionBindingError(check: () => void): void {
  try {
    check();
  } catch (error) {
    if (error instanceof DomainInvariantError) {
      switch (error.code) {
        case "approval_already_decided":
          throw new ApplicationError({
            code: "approval_already_decided",
            httpStatus: 409,
            message: error.message,
          });
        case "approval_expired":
          throw new ApplicationError({
            code: "approval_expired",
            httpStatus: 409,
            message: error.message,
            recoveryAction: "rehydrate_and_retry",
          });
        case "plan_hash_conflict":
          throw new ApplicationError({
            code: "plan_hash_conflict",
            httpStatus: 409,
            message: error.message,
            recoveryAction: "rehydrate_and_retry",
          });
        default:
          throw revisionConflict(error.message);
      }
    }
    throw error;
  }
}

async function emitRejectedDecision(
  deps: ApplicationDeps,
  input: SubmitPlanDecisionInput,
  error: unknown,
): Promise<void> {
  if (deps.trace === undefined) return;
  try {
    const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
    const plan = Object.values(snapshot.entities.plans).find(
      (candidate) =>
        candidate.productRunId === input.productRunId &&
        candidate.planId === input.payload.planId &&
        candidate.planRevision === input.payload.planRevision,
    );
    const attempt = Object.values(snapshot.entities.attempts).find(
      (candidate) =>
        candidate.productRunId === input.productRunId &&
        candidate.kind === "planning" &&
        candidate.planRevision === input.payload.planRevision,
    );
    if (attempt === undefined) return;
    const errorCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      /^[a-z][a-z0-9_.-]{0,63}$/u.test(error.code)
        ? error.code
        : "decision.rejected";
    emitRunEvent(deps, input.productRunId, {
      level: "warn",
      eventName: "decision.rejected",
      outcome: "rejected",
      productRunId: input.productRunId,
      attemptId: attempt.attemptId,
      commandId: input.commandId,
      decisionKind: input.payload.kind,
      error: { code: errorCode, type: safeErrorType(error) },
      ...(plan !== undefined
        ? {
            planRef: {
              objectType: "plan" as const,
              objectId: plan.planId,
              revision: plan.planRevision,
              sha256: plan.sha256,
            },
          }
        : {}),
    });
  } catch {
    // Trace补充失败不能覆盖原始Decision错误。
  }
}
