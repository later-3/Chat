import { hashCanonical } from "./canonical-hash.js";

export type WorkflowNodeRunStatusShape =
  | "queued"
  | "running"
  | "waiting_human"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled"
  | "outcome_unknown";

export interface WorkflowExecutionPathSegmentShape {
  readonly containerNodeId: string;
  readonly iteration: number;
}

export interface NodeProductRefShape {
  readonly kind: string;
  readonly id: string;
  readonly revision: number;
  readonly sha256: string;
  readonly label: string;
}

export interface NodeValueManifestSlotShape {
  readonly name: string;
  readonly refs: readonly NodeProductRefShape[];
}

export interface NodeValueManifestShape {
  readonly schemaVersion: "node-value-manifest.v1";
  readonly nodeValueManifestId: string;
  readonly workflowNodeRunId: string;
  readonly direction: "input" | "output";
  readonly slots: readonly NodeValueManifestSlotShape[];
  readonly sha256: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowNodeRunShape {
  readonly schemaVersion: "workflow-node-run.v1";
  readonly workflowNodeRunId: string;
  readonly productRunId: string;
  readonly workflowViewDefinitionId: string;
  readonly definitionNodeId: string;
  readonly nodeType: string;
  readonly nodeSchemaVersion: string;
  readonly executionPath: readonly WorkflowExecutionPathSegmentShape[];
  readonly attemptNumber: number;
  readonly parentNodeRunId?: string | undefined;
  readonly status: WorkflowNodeRunStatusShape;
  readonly outcomeCode?: string | undefined;
  readonly inputManifestId?: string | undefined;
  readonly outputManifestId?: string | undefined;
  readonly publicSummary?: string | undefined;
  readonly error?: { readonly code: string; readonly summary: string } | undefined;
  readonly projectionSource: "runtime" | "legacy_product_facts";
  readonly startedAt?: string | undefined;
  readonly finishedAt?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NodeRunTransitionShape {
  readonly schemaVersion: "node-run-transition.v1";
  readonly nodeRunTransitionId: string;
  readonly workflowNodeRunId: string;
  readonly nodeSequence: number;
  readonly fromStatus?: WorkflowNodeRunStatusShape | undefined;
  readonly toStatus: WorkflowNodeRunStatusShape;
  readonly reasonKind:
    | "queued"
    | "started"
    | "waiting_human"
    | "resumed"
    | "completed"
    | "skipped"
    | "failed"
    | "cancelled"
    | "outcome_unknown"
    | "projected";
  readonly relatedProductRef?: NodeProductRefShape | undefined;
  readonly projectionSource: "runtime" | "legacy_product_facts";
  readonly occurredAt: string;
  readonly revision: 1;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const allowedTransitions: Readonly<
  Record<WorkflowNodeRunStatusShape, readonly WorkflowNodeRunStatusShape[]>
> = {
  queued: ["running", "skipped", "failed", "cancelled"],
  running: ["waiting_human", "succeeded", "failed", "cancelled", "outcome_unknown"],
  waiting_human: ["running", "succeeded", "failed", "cancelled"],
  outcome_unknown: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
  skipped: [],
  cancelled: [],
};

export function canonicalWorkflowExecutionPath(
  path: readonly WorkflowExecutionPathSegmentShape[],
): WorkflowExecutionPathSegmentShape[] {
  return path.map((segment) => ({ ...segment }));
}

export function workflowNodeRunIdentityKey(
  run: Pick<
    WorkflowNodeRunShape,
    "productRunId" | "definitionNodeId" | "executionPath" | "attemptNumber"
  >,
): string {
  return hashCanonical("workflow-node-run-identity.v1", {
    productRunId: run.productRunId,
    definitionNodeId: run.definitionNodeId,
    executionPath: canonicalWorkflowExecutionPath(run.executionPath),
    attemptNumber: run.attemptNumber,
  });
}

export function computeNodeValueManifestSha256(
  manifest: Pick<NodeValueManifestShape, "workflowNodeRunId" | "direction" | "slots">,
): string {
  return hashCanonical("node-value-manifest.v1", {
    workflowNodeRunId: manifest.workflowNodeRunId,
    direction: manifest.direction,
    slots: manifest.slots,
  });
}

export function createNodeValueManifest(
  input: Omit<
    NodeValueManifestShape,
    "schemaVersion" | "sha256" | "revision" | "createdAt" | "updatedAt"
  > & { readonly at: string },
): NodeValueManifestShape {
  const shape = {
    workflowNodeRunId: input.workflowNodeRunId,
    direction: input.direction,
    // Manifest是不可变证据；不保留调用方可变数组/对象的引用。
    slots: input.slots.map((slot) => ({
      ...slot,
      refs: slot.refs.map((ref) => ({ ...ref })),
    })),
  };
  return {
    schemaVersion: "node-value-manifest.v1",
    nodeValueManifestId: input.nodeValueManifestId,
    ...shape,
    sha256: computeNodeValueManifestSha256(shape),
    revision: 1,
    createdAt: input.at,
    updatedAt: input.at,
  };
}

export interface CreateWorkflowNodeRunInput {
  readonly nodeRun: Omit<
    WorkflowNodeRunShape,
    | "schemaVersion"
    | "status"
    | "outcomeCode"
    | "publicSummary"
    | "error"
    | "projectionSource"
    | "startedAt"
    | "finishedAt"
    | "durationMs"
    | "revision"
    | "createdAt"
    | "updatedAt"
  >;
  readonly transitionId: string;
  readonly at: string;
  readonly projectionSource: WorkflowNodeRunShape["projectionSource"];
}

export function createWorkflowNodeRun(input: CreateWorkflowNodeRunInput): {
  readonly nodeRun: WorkflowNodeRunShape;
  readonly transition: NodeRunTransitionShape;
} {
  const nodeRun: WorkflowNodeRunShape = {
    schemaVersion: "workflow-node-run.v1",
    ...input.nodeRun,
    status: "queued",
    projectionSource: input.projectionSource,
    revision: 1,
    createdAt: input.at,
    updatedAt: input.at,
  };
  const transition: NodeRunTransitionShape = {
    schemaVersion: "node-run-transition.v1",
    nodeRunTransitionId: input.transitionId,
    workflowNodeRunId: nodeRun.workflowNodeRunId,
    nodeSequence: 1,
    toStatus: "queued",
    reasonKind: input.projectionSource === "runtime" ? "queued" : "projected",
    projectionSource: input.projectionSource,
    occurredAt: input.at,
    revision: 1,
    createdAt: input.at,
    updatedAt: input.at,
  };
  return { nodeRun, transition };
}

export interface TransitionWorkflowNodeRunInput {
  readonly transitionId: string;
  readonly nodeSequence: number;
  readonly toStatus: WorkflowNodeRunStatusShape;
  readonly reasonKind: NodeRunTransitionShape["reasonKind"];
  readonly at: string;
  readonly outcomeCode?: string;
  readonly publicSummary?: string;
  readonly error?: WorkflowNodeRunShape["error"];
  readonly relatedProductRef?: NodeProductRefShape;
}

/**
 * Node Run转换只表达产品运行事实。重复Workflow replay必须在Application以稳定Command
 * 或目标状态短路；显式Retry创建新的attempt，而不是重开这里的终态对象。
 */
export function transitionWorkflowNodeRun(
  current: WorkflowNodeRunShape,
  input: TransitionWorkflowNodeRunInput,
): { readonly nodeRun: WorkflowNodeRunShape; readonly transition: NodeRunTransitionShape } {
  if (!allowedTransitions[current.status].includes(input.toStatus)) {
    throw new Error(`Workflow Node Run不允许${current.status}->${input.toStatus}`);
  }
  if (input.nodeSequence < 2) throw new Error("Workflow Node Transition序号必须递增");
  assertTransitionEvidence(current, input);
  const startedAt =
    current.startedAt ??
    (input.toStatus === "running" ||
    input.toStatus === "waiting_human" ||
    input.toStatus === "succeeded" ||
    input.toStatus === "outcome_unknown"
      ? input.at
      : undefined);
  const terminal = ["succeeded", "failed", "skipped", "cancelled", "outcome_unknown"].includes(
    input.toStatus,
  );
  const finishedAt = terminal ? input.at : undefined;
  const durationMs =
    startedAt !== undefined && finishedAt !== undefined
      ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt))
      : undefined;
  const { error: previousError, ...stableCurrent } = current;
  const nextError =
    input.error ??
    (input.toStatus === "failed" || input.toStatus === "outcome_unknown"
      ? previousError
      : undefined);
  const nodeRun: WorkflowNodeRunShape = {
    ...stableCurrent,
    status: input.toStatus,
    ...(input.outcomeCode !== undefined ? { outcomeCode: input.outcomeCode } : {}),
    ...(input.publicSummary !== undefined ? { publicSummary: input.publicSummary } : {}),
    ...(nextError !== undefined ? { error: nextError } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    revision: current.revision + 1,
    updatedAt: input.at,
  };
  const transition: NodeRunTransitionShape = {
    schemaVersion: "node-run-transition.v1",
    nodeRunTransitionId: input.transitionId,
    workflowNodeRunId: current.workflowNodeRunId,
    nodeSequence: input.nodeSequence,
    fromStatus: current.status,
    toStatus: input.toStatus,
    reasonKind: input.reasonKind,
    ...(input.relatedProductRef !== undefined
      ? { relatedProductRef: input.relatedProductRef }
      : {}),
    projectionSource: current.projectionSource,
    occurredAt: input.at,
    revision: 1,
    createdAt: input.at,
    updatedAt: input.at,
  };
  return { nodeRun, transition };
}

function assertTransitionEvidence(
  current: WorkflowNodeRunShape,
  input: TransitionWorkflowNodeRunInput,
): void {
  const expectedReason: NodeRunTransitionShape["reasonKind"] =
    input.toStatus === "running"
      ? current.status === "waiting_human"
        ? "resumed"
        : "started"
      : input.toStatus === "waiting_human"
        ? "waiting_human"
        : input.toStatus === "succeeded"
          ? "completed"
          : input.toStatus === "failed"
            ? "failed"
            : input.toStatus === "skipped"
              ? "skipped"
              : input.toStatus === "cancelled"
                ? "cancelled"
                : "outcome_unknown";
  if (input.reasonKind !== expectedReason) {
    throw new Error(`Workflow Node Transition状态与reason不匹配:${input.toStatus}`);
  }
  if (
    input.toStatus === "waiting_human" &&
    current.nodeType === "human.note_review" &&
    input.relatedProductRef?.kind !== "note_candidate"
  ) {
    throw new Error("Workflow Node waiting_human必须关联Note Candidate");
  }
  if (
    input.toStatus === "waiting_human" &&
    (current.nodeType === "human.prompt_review" || current.nodeType === "agent.direct") &&
    input.relatedProductRef?.kind !== "prompt_review_request"
  ) {
    throw new Error("Prompt Review节点等待必须关联Prompt Review Request");
  }
  if (
    input.toStatus === "waiting_human" &&
    current.nodeType !== "human.note_review" &&
    current.nodeType !== "human.prompt_review" &&
    current.nodeType !== "agent.direct" &&
    input.relatedProductRef?.kind !== "approval_request"
  ) {
    throw new Error("Workflow Node waiting_human必须关联Approval Request");
  }
  if (
    current.status === "waiting_human" &&
    (input.toStatus === "running" || input.toStatus === "succeeded") &&
    current.nodeType === "human.note_review" &&
    input.relatedProductRef?.kind !== "note_decision"
  ) {
    throw new Error("Workflow Node恢复或完成必须关联已提交Note Decision");
  }
  if (
    current.status === "waiting_human" &&
    (input.toStatus === "running" || input.toStatus === "succeeded") &&
    (current.nodeType === "human.prompt_review" || current.nodeType === "agent.direct") &&
    input.relatedProductRef?.kind !== "prompt_review_decision"
  ) {
    throw new Error("Prompt Review节点恢复或完成必须关联Prompt Review Decision");
  }
  if (
    current.status === "waiting_human" &&
    (input.toStatus === "running" || input.toStatus === "succeeded") &&
    current.nodeType !== "human.note_review" &&
    current.nodeType !== "human.prompt_review" &&
    current.nodeType !== "agent.direct" &&
    input.relatedProductRef?.kind !== "decision"
  ) {
    throw new Error("Workflow Node恢复或完成必须关联已提交Decision");
  }
  if (
    current.status === "waiting_human" &&
    input.toStatus === "cancelled" &&
    current.nodeType === "human.note_review" &&
    input.relatedProductRef?.kind !== "note_decision"
  ) {
    throw new Error("Workflow Node取消必须关联已提交Note Decision事实");
  }
  if (
    current.status === "waiting_human" &&
    input.toStatus === "cancelled" &&
    (current.nodeType === "human.prompt_review" || current.nodeType === "agent.direct") &&
    input.relatedProductRef?.kind !== "prompt_review_decision"
  ) {
    throw new Error("Prompt Review节点取消必须关联已提交Prompt Review Decision事实");
  }
  if (
    input.toStatus === "outcome_unknown" &&
    !current.nodeType.startsWith("execute.") &&
    current.nodeType !== "agent.direct"
  ) {
    throw new Error("outcome_unknown只允许用于无法确认的外部执行节点");
  }
}

/**
 * Store启动时复核已经持久化的Transition，不能只相信写入时曾调用过状态机。
 * 首条legacy投影允许直接落到可证明状态；runtime首条只能是queued。
 */
export function assertPersistedWorkflowNodeTransition(input: {
  readonly nodeType: string;
  readonly projectionSource: WorkflowNodeRunShape["projectionSource"];
  readonly fromStatus?: WorkflowNodeRunStatusShape | undefined;
  readonly toStatus: WorkflowNodeRunStatusShape;
  readonly reasonKind: NodeRunTransitionShape["reasonKind"];
  readonly relatedProductRef?: NodeProductRefShape | undefined;
}): void {
  if (input.fromStatus === undefined) {
    if (
      (input.projectionSource === "legacy_product_facts" && input.reasonKind === "projected") ||
      (input.projectionSource === "runtime" &&
        input.toStatus === "queued" &&
        input.reasonKind === "queued")
    ) {
      return;
    }
    throw new Error("Workflow Node首条Transition与投影来源不一致");
  }
  if (!allowedTransitions[input.fromStatus].includes(input.toStatus)) {
    throw new Error(`Workflow Node Run不允许${input.fromStatus}->${input.toStatus}`);
  }
  assertTransitionEvidence(
    {
      schemaVersion: "workflow-node-run.v1",
      workflowNodeRunId: "integrity-check",
      productRunId: "integrity-check",
      workflowViewDefinitionId: "integrity-check",
      definitionNodeId: "integrity-check",
      nodeType: input.nodeType,
      nodeSchemaVersion: "integrity-check",
      executionPath: [],
      attemptNumber: 1,
      status: input.fromStatus,
      projectionSource: input.projectionSource,
      revision: 1,
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
    },
    {
      transitionId: "integrity-check",
      nodeSequence: 2,
      toStatus: input.toStatus,
      reasonKind: input.reasonKind,
      at: "1970-01-01T00:00:00.000Z",
      ...(input.relatedProductRef !== undefined
        ? { relatedProductRef: input.relatedProductRef }
        : {}),
    },
  );
}

export function assertWorkflowNodeRunTimestamps(nodeRun: WorkflowNodeRunShape): void {
  const terminal = ["succeeded", "failed", "skipped", "cancelled", "outcome_unknown"].includes(
    nodeRun.status,
  );
  if (terminal !== (nodeRun.finishedAt !== undefined)) {
    throw new Error(`Workflow Node Run ${nodeRun.workflowNodeRunId}终态时间不一致`);
  }
  if (nodeRun.durationMs !== undefined && nodeRun.startedAt === undefined) {
    throw new Error(`Workflow Node Run ${nodeRun.workflowNodeRunId}耗时缺少开始时间`);
  }
  if (
    nodeRun.startedAt !== undefined &&
    nodeRun.finishedAt !== undefined &&
    Date.parse(nodeRun.finishedAt) < Date.parse(nodeRun.startedAt)
  ) {
    throw new Error(`Workflow Node Run ${nodeRun.workflowNodeRunId}时间倒序`);
  }
  if (
    nodeRun.startedAt !== undefined &&
    Date.parse(nodeRun.startedAt) < Date.parse(nodeRun.createdAt)
  ) {
    throw new Error(`Workflow Node Run ${nodeRun.workflowNodeRunId}开始时间早于创建时间`);
  }
  if (
    nodeRun.durationMs !== undefined &&
    nodeRun.finishedAt !== undefined &&
    nodeRun.durationMs !== Date.parse(nodeRun.finishedAt) - Date.parse(nodeRun.startedAt ?? "")
  ) {
    throw new Error(`Workflow Node Run ${nodeRun.workflowNodeRunId}耗时与时间戳不一致`);
  }
}
