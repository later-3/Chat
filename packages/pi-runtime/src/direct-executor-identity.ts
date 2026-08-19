import { hashExecutorValue } from "./executor-operation-store.js";

/** 一个Direct Agent Attempt只能映射到一个Pi Operation，防止换ID重复越过审核。 */
export function operationIdForDirectAgentAttempt(directAgentAttemptId: string): string {
  return `pio_${hashExecutorValue({ kind: "direct-agent", directAgentAttemptId }).slice(0, 32)}`;
}
