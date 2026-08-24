import { hashCanonical } from "./canonical-hash.js";

export type ToolExecutionIntentStatus =
  | "waiting_decision"
  | "approved"
  | "rejected"
  | "dispatching"
  | "completed"
  | "failed"
  | "outcome_unknown"
  | "not_executed";

interface ToolExecutionIntentLike {
  readonly toolExecutionIntentId: string;
  readonly status: ToolExecutionIntentStatus;
}

interface ToolExecutionDecisionScope {
  readonly kind: "global" | "workspace" | "provider";
  readonly rootId?: string | undefined;
  readonly providerRef?: string | undefined;
}

export function computeToolExecutionDecisionSha256(input: {
  readonly toolExecutionDecisionId: string;
  readonly toolExecutionIntentId: string;
  readonly productRunId: string;
  readonly intentRevision: number;
  readonly capabilityDescriptorSha256: string;
  readonly inputSha256: string;
  readonly scopeRef: ToolExecutionDecisionScope;
  readonly kind: "approve" | "reject";
  readonly principalId: string;
  readonly explanation?: string | undefined;
  readonly commandId: string;
}): string {
  return hashCanonical("tool-execution-decision.v1", input);
}

/** Product与Executor共同计算；私有Operation ID永不成为公开授权身份。 */
export function computeDirectRuntimeOperationRefSha256(input: {
  readonly productRunId: string;
  readonly directAgentAttemptId: string;
  readonly inputManifestSha256: string;
}): string {
  return hashCanonical("direct-runtime-operation-ref.v1", input);
}

const TRANSITIONS: Readonly<
  Record<ToolExecutionIntentStatus, readonly ToolExecutionIntentStatus[]>
> = {
  waiting_decision: ["approved", "rejected", "not_executed"],
  approved: ["dispatching", "not_executed"],
  rejected: [],
  dispatching: ["completed", "failed", "outcome_unknown"],
  completed: [],
  failed: [],
  outcome_unknown: [],
  not_executed: [],
};

export function assertToolExecutionIntentTransition(
  from: ToolExecutionIntentStatus,
  to: ToolExecutionIntentStatus,
): void {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new Error(`tool_execution.invalid_transition:${from}->${to}`);
  }
}

export function isToolExecutionIntentClosed(intent: ToolExecutionIntentLike): boolean {
  return (
    intent.status === "completed" ||
    intent.status === "failed" ||
    intent.status === "rejected" ||
    intent.status === "outcome_unknown" ||
    intent.status === "not_executed"
  );
}

export function assertHighImpactToolExecutionsClosed(
  intents: readonly ToolExecutionIntentLike[],
): void {
  const unclosed = intents.filter((intent) => !isToolExecutionIntentClosed(intent));
  if (unclosed.length > 0) {
    throw new Error(
      `tool_execution.unclosed:${unclosed.map((intent) => intent.toolExecutionIntentId).join(",")}`,
    );
  }
}
