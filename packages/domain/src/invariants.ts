import { DomainInvariantError } from "./plan-state.js";

/**
 * 跨对象领域不变量（任务书§9.2，纯规则、无IO）。
 *
 * 这里只放必须“实现一次”的领域规则；启动时的悬空引用/Hash一致性
 * 全量校验由Product Store Adapter在装载快照时执行。
 */

export interface PlanReviewBinding {
  readonly productRunId: string;
  readonly planId: string;
  readonly planRevision: number;
  readonly status: string;
}

/** 一个Product Run任意时刻最多一个under_review Plan。 */
export function assertSinglePlanUnderReview(plans: readonly PlanReviewBinding[]): void {
  const underReview = plans.filter((plan) => plan.status === "under_review");
  if (underReview.length > 1) {
    throw new DomainInvariantError(
      "multiple_plans_under_review",
      "同一Product Run不允许同时存在多个under_review Plan",
    );
  }
}

export interface ApprovalBinding {
  readonly approvalRequestId: string;
  readonly productRunId: string;
  readonly planId: string;
  readonly planRevision: number;
  readonly planSha256: string;
  readonly status: "open" | "decided" | "expired";
}

/** 一个Product Run任意时刻最多一个open Approval Request。 */
export function assertSingleOpenApproval(approvals: readonly ApprovalBinding[]): void {
  const open = approvals.filter((approval) => approval.status === "open");
  if (open.length > 1) {
    throw new DomainInvariantError(
      "multiple_open_approvals",
      "同一Product Run不允许同时存在多个open Approval Request",
    );
  }
}

export interface DecisionBindingInput {
  readonly planId: string;
  readonly planRevision: number;
  readonly planSha256: string;
}

/**
 * 校验Decision与Approval Request的绑定关系。
 * 过期、旧revision、错误Hash和已决定Request全部失败关闭；
 * Principal校验由Application在调用本函数前完成。
 */
export function assertDecisionBinding(
  approval: ApprovalBinding,
  input: DecisionBindingInput,
): void {
  if (approval.status === "decided") {
    throw new DomainInvariantError("approval_already_decided", "该Approval Request已有决定");
  }
  if (approval.status === "expired") {
    throw new DomainInvariantError("approval_expired", "该Approval Request已过期");
  }
  if (approval.planId !== input.planId || approval.planRevision !== input.planRevision) {
    throw new DomainInvariantError(
      "plan_revision_conflict",
      "Decision绑定的Plan revision与当前Approval不一致",
    );
  }
  if (approval.planSha256 !== input.planSha256) {
    throw new DomainInvariantError(
      "plan_hash_conflict",
      "Decision绑定的Plan Hash与当前Approval不一致",
    );
  }
}
