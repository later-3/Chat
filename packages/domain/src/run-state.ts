/**
 * Product Run状态机（纯领域规则）。
 *
 * 不变量（见docs/architecture/system-boundaries.md）：
 * - Product Run终态为succeeded/failed/cancelled/outcome_unknown之一。
 * - 终态不可再转换；Workflow成功不等于Product Run成功。
 * - 任何终态转换必须有状态机测试和非法转换测试。
 */
export const productRunStatuses = [
  "pending",
  "running",
  "waiting_human",
  "succeeded",
  "failed",
  "cancelled",
  "outcome_unknown",
] as const;

export type ProductRunStatus = (typeof productRunStatuses)[number];

const terminalStatuses: ReadonlySet<ProductRunStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "outcome_unknown",
]);

export function isTerminalRunStatus(status: ProductRunStatus): boolean {
  return terminalStatuses.has(status);
}

const allowedTransitions: Readonly<Record<ProductRunStatus, readonly ProductRunStatus[]>> = {
  pending: ["running", "cancelled"],
  running: ["waiting_human", "succeeded", "failed", "cancelled", "outcome_unknown"],
  waiting_human: ["running", "cancelled", "failed"],
  succeeded: [],
  failed: [],
  cancelled: [],
  outcome_unknown: [],
};

export function canTransitionRunStatus(from: ProductRunStatus, to: ProductRunStatus): boolean {
  return allowedTransitions[from].includes(to);
}
