/**
 * Plan Revision状态机（纯领域规则）。
 *
 * 不变量：
 * - Plan只在发布后持久化，初始持久化状态即under_review。
 * - 新Plan产生时上一版必须进入superseded；旧版本不删除。
 * - approved不可变；Execution Contract只从Approved Plan与已提交Decision生成。
 * - 任何终态转换必须有状态机测试和非法转换测试。
 */
export const planRevisionStatuses = [
  "under_review",
  "approved",
  "superseded",
  "rejected",
  "expired",
] as const;

export type PlanRevisionStatus = (typeof planRevisionStatuses)[number];

const allowedTransitions: Readonly<Record<PlanRevisionStatus, readonly PlanRevisionStatus[]>> = {
  under_review: ["approved", "superseded", "rejected", "expired"],
  approved: [],
  superseded: [],
  rejected: [],
  expired: [],
};

export function isTerminalPlanStatus(status: PlanRevisionStatus): boolean {
  return allowedTransitions[status].length === 0;
}

export function canTransitionPlanStatus(from: PlanRevisionStatus, to: PlanRevisionStatus): boolean {
  return allowedTransitions[from].includes(to);
}

/**
 * 计算下一个Plan业务版本号；达到上限时失败关闭，不再调用模型。
 * existingRevisions是该Product Run已持久化的全部Plan业务版本号。
 */
export function nextPlanRevision(
  existingRevisions: readonly number[],
  maxPlanRevisions: number,
): number {
  const next = existingRevisions.length === 0 ? 1 : Math.max(...existingRevisions) + 1;
  if (next > maxPlanRevisions) {
    throw new DomainInvariantError(
      "plan_revision_limit_reached",
      `规划修订已达上限${String(maxPlanRevisions)}，不再产生新版本`,
    );
  }
  return next;
}

export class DomainInvariantError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DomainInvariantError";
    this.code = code;
  }
}
