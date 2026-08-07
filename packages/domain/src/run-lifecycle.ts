import { DomainInvariantError } from "./plan-state.js";

/**
 * Product Run生命周期（status + phase，纯领域规则，任务书§9.1）。
 *
 * 不变量：
 * - status是权威生命周期（pending/running/waiting_human/succeeded/failed/
 *   cancelled/outcome_unknown），phase只解释当前用户可见阶段。
 * - 不得建立第二套竞争终态；终态不可再转换。
 * - 失败与结果未知保留最后已知phase，便于用户理解“在哪一步失败”。
 */

export const runPhases = [
  "queued",
  "planning",
  "plan_review",
  "executing",
  "validating",
  "completed",
  "rejected",
] as const;

export type RunPhase = (typeof runPhases)[number];

export interface RunLifecycle {
  readonly status:
    | "pending"
    | "running"
    | "waiting_human"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "outcome_unknown";
  readonly phase: RunPhase;
}

const key = (state: RunLifecycle): string => `${state.status}/${state.phase}`;

/** 合法(status, phase)组合及其允许的后续组合；不在表内的转换一律非法。 */
const allowedTransitions: Readonly<Record<string, readonly string[]>> = {
  "pending/queued": [
    "running/planning",
    "cancelled/queued",
    "failed/queued",
    "outcome_unknown/queued",
  ],
  "running/planning": [
    "waiting_human/plan_review",
    "failed/planning",
    "cancelled/planning",
    "outcome_unknown/planning",
  ],
  "waiting_human/plan_review": [
    // request_revision：回到同一Workflow的规划节点
    "running/planning",
    // approve：进入执行
    "running/executing",
    // reject：用户拒绝的明确终态
    "cancelled/rejected",
    "failed/plan_review",
  ],
  "running/executing": [
    "running/validating",
    "failed/executing",
    "cancelled/executing",
    "outcome_unknown/executing",
  ],
  "running/validating": ["succeeded/completed", "failed/validating", "outcome_unknown/validating"],
};

export function canTransitionRunLifecycle(from: RunLifecycle, to: RunLifecycle): boolean {
  return (allowedTransitions[key(from)] ?? []).includes(key(to));
}

export function isTerminalRunLifecycle(state: RunLifecycle): boolean {
  return (
    state.status === "succeeded" ||
    state.status === "failed" ||
    state.status === "cancelled" ||
    state.status === "outcome_unknown"
  );
}

/** 校验并返回目标生命周期；非法转换抛出DomainInvariantError。 */
export function transitionRunLifecycle(from: RunLifecycle, to: RunLifecycle): RunLifecycle {
  if (isTerminalRunLifecycle(from)) {
    throw new DomainInvariantError(
      "run_already_terminal",
      `Product Run已处于终态${from.status}，不能再转换`,
    );
  }
  if (!canTransitionRunLifecycle(from, to)) {
    throw new DomainInvariantError(
      "run_transition_invalid",
      `非法Run转换：${key(from)} -> ${key(to)}`,
    );
  }
  return to;
}
