import { defineHook } from "workflow";

export const MAX_PLAN_REVIEW_FEEDBACK_CHARS = 20_000;

export interface PlanReviewReference {
  readonly reviewId: string;
  readonly workflowInvocationId: string;
  readonly planRevision: number;
  readonly planSha256: string;
}

export type PlanReviewDecision = PlanReviewReference & (
  | { readonly kind: "approve" }
  | { readonly kind: "request_revision"; readonly feedback: string }
);

/** One durable, server-resumed hook per published plan revision. */
export const planReviewDecisionHook = defineHook<PlanReviewDecision>();

export function planReviewHookToken(workflowInvocationId: string, planRevision: number): string {
  return `chat-plan-review:${workflowInvocationId}:${String(planRevision)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field}必须是非空字符串`);
  return value.trim();
}

/** Validates an HTTP review decision before it can resume a Workflow Hook. */
export function parsePlanReviewDecision(value: unknown): PlanReviewDecision {
  if (!isRecord(value)) throw new Error("审核决定必须是JSON对象");
  const allowed = value.kind === "request_revision"
    ? ["kind", "reviewId", "workflowInvocationId", "planRevision", "planSha256", "feedback"]
    : ["kind", "reviewId", "workflowInvocationId", "planRevision", "planSha256"];
  const unknown = Object.keys(value).filter((field) => !allowed.includes(field));
  if (unknown.length > 0) throw new Error(`审核决定包含未知字段: ${unknown.join(", ")}`);
  if (value.kind !== "approve" && value.kind !== "request_revision") {
    throw new Error("kind必须是approve或request_revision");
  }
  if (!Number.isSafeInteger(value.planRevision) || (value.planRevision as number) < 1) {
    throw new Error("planRevision必须是正整数");
  }
  const reference = {
    reviewId: requiredString(value.reviewId, "reviewId"),
    workflowInvocationId: requiredString(value.workflowInvocationId, "workflowInvocationId"),
    planRevision: value.planRevision as number,
    planSha256: requiredString(value.planSha256, "planSha256"),
  };
  if (!/^[a-f0-9]{64}$/.test(reference.planSha256)) throw new Error("planSha256无效");
  if (value.kind === "approve") return { kind: "approve", ...reference };
  if (typeof value.feedback !== "string" || value.feedback.trim() === "") {
    throw new Error("feedback必须是非空字符串");
  }
  const feedback = value.feedback;
  if (feedback.length > MAX_PLAN_REVIEW_FEEDBACK_CHARS) {
    throw new Error(`feedback不能超过${MAX_PLAN_REVIEW_FEEDBACK_CHARS}个字符`);
  }
  return { kind: "request_revision", ...reference, feedback };
}

export function assertPlanReviewDecisionMatches(
  decision: PlanReviewDecision,
  expected: PlanReviewReference,
): void {
  if (
    decision.reviewId !== expected.reviewId
    || decision.workflowInvocationId !== expected.workflowInvocationId
    || decision.planRevision !== expected.planRevision
    || decision.planSha256 !== expected.planSha256
  ) {
    throw new Error("审核决定与当前计划版本不匹配");
  }
}
