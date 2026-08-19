import {
  PRODUCT_API_SCHEMA_VERSION,
  type ApprovalDto,
  type ApprovalRequest,
  type Message,
  type MessageDto,
  type PlanDto,
  type PlanRevision,
  type ProductRun,
  type ProductSession,
  type RunAllowedAction,
  type RunDto,
  type SessionDto,
  type Decision,
  type DecisionDto,
  type PromptReviewRequest,
} from "@chat/contracts";
import { computeMessageSha256 } from "@chat/domain";

/**
 * 实体 -> 公开DTO映射。
 *
 * 不变量：DTO永远不携带Workflow Run ID、Hook Token、pi Session ID或
 * Provider内部身份；allowedActions由服务端状态机决定，浏览器不自行猜测。
 */

export function toSessionDto(session: ProductSession): SessionDto {
  return {
    schemaVersion: PRODUCT_API_SCHEMA_VERSION,
    sessionId: session.sessionId,
    status: session.status,
    ...(session.title !== undefined ? { title: session.title } : {}),
    revision: session.revision,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export function toMessageDto(message: Message): MessageDto {
  return {
    schemaVersion: PRODUCT_API_SCHEMA_VERSION,
    messageId: message.messageId,
    sessionId: message.sessionId,
    sessionSequence: message.sessionSequence,
    role: message.role,
    content: message.content,
    ...(message.sourceRunId !== undefined ? { sourceRunId: message.sourceRunId } : {}),
    sha256: computeMessageSha256(message) as never,
    createdAt: message.createdAt,
  };
}

export function toPlanDto(plan: PlanRevision): PlanDto {
  return {
    schemaVersion: PRODUCT_API_SCHEMA_VERSION,
    planId: plan.planId,
    planRevision: plan.planRevision,
    status: plan.status,
    sha256: plan.sha256,
    content: plan.content,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

export function toApprovalDto(approval: ApprovalRequest): ApprovalDto {
  return {
    schemaVersion: PRODUCT_API_SCHEMA_VERSION,
    approvalRequestId: approval.approvalRequestId,
    productRunId: approval.productRunId,
    planId: approval.planId,
    planRevision: approval.planRevision,
    planSha256: approval.planSha256,
    status: approval.status,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
  };
}

export function toDecisionDto(decision: Decision): DecisionDto {
  return {
    schemaVersion: PRODUCT_API_SCHEMA_VERSION,
    decisionId: decision.decisionId,
    approvalRequestId: decision.approvalRequestId,
    productRunId: decision.productRunId,
    planId: decision.planId,
    planRevision: decision.planRevision,
    planSha256: decision.planSha256,
    kind: decision.kind,
    createdAt: decision.createdAt,
  };
}

export function runAllowedActions(
  run: ProductRun,
  currentApproval: ApprovalRequest | undefined,
  currentPromptReview?: PromptReviewRequest | undefined,
): RunAllowedAction[] {
  if (
    run.runKind === "direct_agent" &&
    run.status === "waiting_human" &&
    currentPromptReview?.status === "open"
  ) {
    return ["approve", "reject"];
  }
  if (run.status === "waiting_human" && currentApproval?.status === "open") {
    return ["request_revision", "approve", "reject"];
  }
  return [];
}

export function toRunDto(
  run: ProductRun,
  currentPlan: PlanRevision | undefined,
  currentApproval: ApprovalRequest | undefined,
  currentPromptReview?: PromptReviewRequest | undefined,
): RunDto {
  return {
    schemaVersion: PRODUCT_API_SCHEMA_VERSION,
    productRunId: run.productRunId,
    sessionId: run.sessionId,
    sourceMessageId: run.sourceMessageId,
    status: run.status,
    phase: run.phase,
    ...(currentPlan !== undefined
      ? {
          currentPlan: {
            planId: currentPlan.planId,
            planRevision: currentPlan.planRevision,
            status: currentPlan.status,
            sha256: currentPlan.sha256,
          },
        }
      : {}),
    ...(run.runKind === "planning" && run.currentApprovalRequestId !== undefined
      ? { currentApprovalRequestId: run.currentApprovalRequestId }
      : {}),
    ...(run.runKind === "direct_agent" && run.currentPromptReviewRequestId !== undefined
      ? { currentPromptReviewRequestId: run.currentPromptReviewRequestId }
      : {}),
    ...(run.runKind === "direct_agent" && run.currentDirectAgentCandidateId !== undefined
      ? { currentDirectAgentCandidateId: run.currentDirectAgentCandidateId }
      : {}),
    ...(run.runKind === "direct_agent" && run.finalDirectAgentCandidateId !== undefined
      ? { finalDirectAgentCandidateId: run.finalDirectAgentCandidateId }
      : {}),
    ...(run.finalMessageId !== undefined ? { finalMessageId: run.finalMessageId } : {}),
    ...(run.failure !== undefined ? { failure: run.failure } : {}),
    ...(run.runKind === "planning" ? { maxPlanRevisions: run.maxPlanRevisions } : {}),
    allowedActions: runAllowedActions(run, currentApproval, currentPromptReview),
    revision: run.revision,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}
