import {
  nodeRunTransitionSchema,
  nodeValueManifestSchema,
  workflowNodeRunSchema,
  type NodeProductRef,
  type NodeValueManifestSlot,
  type ProductSnapshot,
  type WorkflowNodeRun,
  type WorkflowRunSpec,
} from "@chat/contracts";
import {
  computeNodeValueManifestSha256,
  createNodeValueManifest,
  createWorkflowNodeRun,
  hashCanonical,
  transitionWorkflowNodeRun,
  workflowNodeRunIdentityKey,
} from "@chat/domain";
import { assertWorkflowNodeExecutionIdentity } from "./configurable-workflow-runtime-use-cases.js";
import { revisionConflict } from "./errors.js";
import type { WorkflowMemoryProductRun } from "./product-run-kind.js";

type DraftSnapshot = ProductSnapshot;
type PlanningContextNodeType =
  "memory.query" | "context.memory" | "context.project" | "policy.rules";

const deriveNodeRunId = (input: {
  readonly productRunId: string;
  readonly definitionNodeId: string;
  readonly executionPath: WorkflowNodeRun["executionPath"];
  readonly attemptNumber: number;
}) => `wnr_${workflowNodeRunIdentityKey(input).slice(0, 32)}`;

const deriveTransitionId = (workflowNodeRunId: string, sequence: number) =>
  `wnt_${hashCanonical("id.node-transition.v1", { workflowNodeRunId, sequence }).slice(0, 32)}`;

const deriveManifestId = (workflowNodeRunId: string, direction: "input" | "output") =>
  `wvm_${hashCanonical("id.node-value-manifest.v1", { workflowNodeRunId, direction }).slice(0, 32)}`;

function transitionCount(draft: DraftSnapshot, workflowNodeRunId: string): number {
  return Object.values(draft.entities.nodeRunTransitions).filter(
    (transition) => transition.workflowNodeRunId === workflowNodeRunId,
  ).length;
}

function persistImmutableManifest(
  draft: DraftSnapshot,
  nodeRun: WorkflowNodeRun,
  direction: "input" | "output",
  slots: readonly NodeValueManifestSlot[],
  at: string,
): string | undefined {
  if (slots.length === 0) return undefined;
  const nodeValueManifestId = deriveManifestId(nodeRun.workflowNodeRunId, direction);
  const copiedSlots = slots.map((slot) => ({
    ...slot,
    refs: slot.refs.map((ref) => ({ ...ref })),
  }));
  const expectedSha256 = computeNodeValueManifestSha256({
    workflowNodeRunId: nodeRun.workflowNodeRunId,
    direction,
    slots: copiedSlots,
  });
  const existing = draft.entities.nodeValueManifests[nodeValueManifestId];
  if (existing !== undefined) {
    if (existing.sha256 !== expectedSha256) {
      throw revisionConflict("Planning Context Node Manifest已冻结且内容不同");
    }
    return existing.nodeValueManifestId;
  }
  const manifest = nodeValueManifestSchema.parse(
    createNodeValueManifest({
      nodeValueManifestId,
      workflowNodeRunId: nodeRun.workflowNodeRunId,
      direction,
      slots: copiedSlots,
      at,
    }),
  );
  draft.entities.nodeValueManifests[manifest.nodeValueManifestId] = manifest;
  return manifest.nodeValueManifestId;
}

/**
 * context.memory/context.project/policy.rules的业务事实与Node终态必须在同一Store事务提交。
 * 调用方先把业务对象写进draft，再调用本函数；任何Manifest、Transition或状态校验失败都会
 * 回滚整个事务，不会留下“业务事实已存在但Node仍running”的半提交。
 */
export function commitPlanningContextNodeFact(
  draft: DraftSnapshot,
  input: {
    readonly run: WorkflowMemoryProductRun;
    readonly runSpec: WorkflowRunSpec;
    readonly definitionNodeId: string;
    readonly nodeType: PlanningContextNodeType;
    readonly executionPath: WorkflowNodeRun["executionPath"];
    readonly attemptNumber: number;
    readonly terminal: "succeeded" | "skipped" | "failed";
    readonly outcomeCode: string;
    readonly publicSummary: string;
    readonly inputSlots: readonly NodeValueManifestSlot[];
    readonly outputSlots: readonly NodeValueManifestSlot[];
    readonly relatedProductRef?: NodeProductRef | undefined;
    readonly at: string;
  },
): WorkflowNodeRun {
  const resolution = input.runSpec.nodeResolutions.find(
    (candidate) => candidate.definitionNodeId === input.definitionNodeId,
  );
  if (
    input.runSpec.productRunId !== input.run.productRunId ||
    input.run.workflowRunSpecId !== input.runSpec.workflowRunSpecId ||
    resolution?.nodeType !== input.nodeType
  ) {
    throw revisionConflict("Planning Context Node与RunSpec绑定不一致");
  }
  assertWorkflowNodeExecutionIdentity(input.runSpec, input);
  const workflowNodeRunId = deriveNodeRunId({
    productRunId: input.run.productRunId,
    definitionNodeId: input.definitionNodeId,
    executionPath: input.executionPath,
    attemptNumber: input.attemptNumber,
  });
  let nodeRun = draft.entities.workflowNodeRuns[workflowNodeRunId];
  if (nodeRun === undefined) {
    const created = createWorkflowNodeRun({
      nodeRun: {
        workflowNodeRunId,
        productRunId: input.run.productRunId,
        workflowViewDefinitionId: input.run.workflowViewDefinitionId,
        definitionNodeId: input.definitionNodeId,
        nodeType: input.nodeType,
        nodeSchemaVersion: String(resolution.schemaVersion),
        executionPath: input.executionPath.map((segment) => ({ ...segment })),
        attemptNumber: input.attemptNumber,
      },
      transitionId: deriveTransitionId(workflowNodeRunId, 1),
      at: input.run.createdAt,
      projectionSource: "runtime",
    });
    nodeRun = workflowNodeRunSchema.parse(created.nodeRun);
    draft.entities.workflowNodeRuns[workflowNodeRunId] = nodeRun;
    draft.entities.nodeRunTransitions[created.transition.nodeRunTransitionId] =
      nodeRunTransitionSchema.parse(created.transition);
  }
  if (nodeRun.status === input.terminal) {
    if (
      nodeRun.outcomeCode !== input.outcomeCode ||
      nodeRun.publicSummary !== input.publicSummary
    ) {
      throw revisionConflict("Planning Context Node终态证据与已提交事实不一致");
    }
  } else {
    const apply = (toStatus: "running" | "succeeded" | "skipped" | "failed") => {
      const sequence = transitionCount(draft, workflowNodeRunId) + 1;
      const transitioned = transitionWorkflowNodeRun(nodeRun!, {
        transitionId: deriveTransitionId(workflowNodeRunId, sequence),
        nodeSequence: sequence,
        toStatus,
        reasonKind:
          toStatus === "running"
            ? "started"
            : toStatus === "succeeded"
              ? "completed"
              : toStatus === "failed"
                ? "failed"
                : "skipped",
        at: input.at,
        ...(toStatus === input.terminal
          ? {
              outcomeCode: input.outcomeCode,
              publicSummary: input.publicSummary,
              ...(toStatus === "failed"
                ? {
                    error: {
                      code: input.outcomeCode,
                      summary: input.publicSummary,
                    },
                  }
                : {}),
              ...(input.relatedProductRef !== undefined
                ? { relatedProductRef: input.relatedProductRef }
                : {}),
            }
          : {}),
      });
      draft.entities.nodeRunTransitions[transitioned.transition.nodeRunTransitionId] =
        nodeRunTransitionSchema.parse(transitioned.transition);
      nodeRun = workflowNodeRunSchema.parse(transitioned.nodeRun);
      draft.entities.workflowNodeRuns[workflowNodeRunId] = nodeRun;
    };
    if (nodeRun.status !== "queued" && nodeRun.status !== "running") {
      throw revisionConflict("Planning Context Node已被其他命令推进");
    }
    if (nodeRun.status === "queued" && input.terminal !== "skipped") apply("running");
    apply(input.terminal);
  }

  const inputManifestId = persistImmutableManifest(
    draft,
    nodeRun,
    "input",
    input.inputSlots,
    input.at,
  );
  const outputManifestId = persistImmutableManifest(
    draft,
    nodeRun,
    "output",
    input.outputSlots,
    input.at,
  );
  const manifestsChanged =
    nodeRun.inputManifestId !== inputManifestId || nodeRun.outputManifestId !== outputManifestId;
  const withManifests = workflowNodeRunSchema.parse({
    ...nodeRun,
    ...(inputManifestId !== undefined ? { inputManifestId } : {}),
    ...(outputManifestId !== undefined ? { outputManifestId } : {}),
    revision: manifestsChanged ? nodeRun.revision + 1 : nodeRun.revision,
    updatedAt: manifestsChanged ? input.at : nodeRun.updatedAt,
  });
  draft.entities.workflowNodeRuns[workflowNodeRunId] = withManifests;
  return withManifests;
}
