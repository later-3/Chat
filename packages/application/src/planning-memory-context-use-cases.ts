import {
  INTERNAL_RUNTIME_SCHEMA_VERSION,
  planningMemorySelectionIdSchema,
  planningMemorySelectionSchema,
  preparePlanningMemoryContextResponseSchema,
  type NodeProductRef,
  type PlanningMemorySelection,
  type PreparePlanningMemoryContextRequest,
  type PreparePlanningMemoryContextResponse,
  type ProductEntities,
  type WorkflowResolvedResource,
  type WorkflowRunSpec,
} from "@chat/contracts";
import {
  assertPlanningMemorySelectionIntegrity,
  computePlanningMemorySelectionSha256,
  hashCanonical,
} from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import { ApplicationError, notFound, revisionConflict } from "./errors.js";
import { commitPlanningContextNodeFact } from "./planning-context-node-facts.js";
import { requirePlanningRun } from "./product-run-kind.js";
import { validateWorkflowRunSpecIntegrity } from "./workflow-run-spec-compiler.js";

type IncludedResource = Extract<WorkflowResolvedResource, { readonly resolution: "included" }>;

/**
 * 从RunSpec冻结的mrs_*三元组创建不可变Selection，并在同一事务完成context.memory节点。
 * 返回的正文只经过私有Runtime DTO进入当前Step；Selection、Manifest和Receipt均不复制正文。
 */
export async function preparePlanningMemoryContext(
  deps: ApplicationDeps,
  input: PreparePlanningMemoryContextRequest,
): Promise<PreparePlanningMemoryContextResponse> {
  const requestSha256 = hashCanonical("command.prepare-planning-memory-context.v1", input);
  const now = deps.now();
  const transaction = await deps.store.transact({
    commandId: input.commandId,
    commandType: "PreparePlanningMemoryContext",
    requestSha256,
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const run = draft.entities.runs[input.productRunId];
      if (run === undefined) throw notFound("Planning Run不存在");
      const planningRun = requirePlanningRun(run);
      const session = draft.entities.sessions[planningRun.sessionId];
      const rawRunSpec = draft.entities.workflowRunSpecs[input.workflowRunSpecId];
      const validated =
        rawRunSpec === undefined ? undefined : validateWorkflowRunSpecIntegrity(rawRunSpec);
      if (
        session === undefined ||
        planningRun.workflowRunSpecId !== input.workflowRunSpecId ||
        rawRunSpec === undefined ||
        rawRunSpec.productRunId !== input.productRunId ||
        validated === undefined ||
        !validated.success
      ) {
        throw revisionConflict("Memory Context的Run/RunSpec绑定不存在或已损坏");
      }
      const runSpec = validated.runSpec;
      const node = runSpec.nodeResolutions.find(
        (candidate) => candidate.definitionNodeId === input.definitionNodeId,
      );
      if (node?.nodeType !== "context.memory") {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 422,
          message: "definitionNodeId不是context.memory节点",
        });
      }
      const maxItems =
        typeof node.config.maxItems === "number" && Number.isInteger(node.config.maxItems)
          ? node.config.maxItems
          : undefined;
      if (maxItems === undefined || maxItems < 1 || maxItems > 20) {
        throw new ApplicationError({
          code: "store_corrupted",
          httpStatus: 500,
          message: "context.memory冻结maxItems无效",
          recoveryAction: "contact_support",
        });
      }
      const included = includedMemoryResources(runSpec, input.definitionNodeId);
      if (included.length > maxItems) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 422,
          message: "Memory选择数量超过Definition maxItems",
        });
      }
      if (included.length === 0) {
        const nodeRun = commitPlanningContextNodeFact(draft, {
          run: planningRun,
          runSpec,
          definitionNodeId: input.definitionNodeId,
          nodeType: "context.memory",
          executionPath: input.executionPath,
          attemptNumber: input.attemptNumber,
          terminal: "skipped",
          outcomeCode: "optional_unavailable",
          publicSummary: "本轮未选择Memory Snapshot",
          inputSlots: [],
          outputSlots: [],
          at: now,
        });
        return {
          resultRefs: {
            productRunId: input.productRunId,
            workflowNodeRunId: nodeRun.workflowNodeRunId,
            contextStatus: "none",
          },
        };
      }

      const snapshots = included.map((resource) => {
        const snapshot = draft.entities.memoryResultSnapshots[resource.resourceId];
        const query =
          snapshot === undefined ? undefined : draft.entities.memoryQueries[snapshot.memoryQueryId];
        const sourceRun = query === undefined ? undefined : draft.entities.runs[query.productRunId];
        const sourceSession =
          sourceRun === undefined ? undefined : draft.entities.sessions[sourceRun.sessionId];
        if (
          snapshot === undefined ||
          snapshot.revision !== resource.expectedRevision ||
          snapshot.sha256 !== resource.expectedSha256 ||
          sourceSession?.ownerPrincipalId !== session.ownerPrincipalId
        ) {
          throw new ApplicationError({
            code: "resource_stale",
            httpStatus: 409,
            message: "RunSpec中的Memory Snapshot不存在、越权或Hash已变化",
            recoveryAction: "rehydrate_and_retry",
          });
        }
        return snapshot;
      });
      const planningMemorySelectionId = planningMemorySelectionIdSchema.parse(
        `pmsl_${hashCanonical("id.planning-memory-selection.v1", {
          productRunId: input.productRunId,
          workflowRunSpecId: input.workflowRunSpecId,
          definitionNodeId: input.definitionNodeId,
        }).slice(0, 32)}`,
      );
      const selected = snapshots
        .map((snapshot) => ({
          memoryResultSnapshotId: snapshot.memoryResultSnapshotId,
          revision: snapshot.revision,
          sha256: snapshot.sha256,
        }))
        .sort((left, right) =>
          left.memoryResultSnapshotId.localeCompare(right.memoryResultSnapshotId),
        );
      const hashInput = {
        productRunId: input.productRunId,
        workflowRunSpecId: input.workflowRunSpecId,
        workflowRunSpecSha256: runSpec.sha256,
        definitionNodeId: input.definitionNodeId,
        maxItems,
        selected,
      };
      const selection = planningMemorySelectionSchema.parse({
        schemaVersion: "planning-memory-selection.v1",
        planningMemorySelectionId,
        ...hashInput,
        sha256: computePlanningMemorySelectionSha256(hashInput),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      assertPlanningMemorySelectionIntegrity(selection);
      const existing = draft.entities.planningMemorySelections[planningMemorySelectionId];
      if (existing !== undefined && existing.sha256 !== selection.sha256) {
        throw revisionConflict("Planning Memory Selection稳定身份发生Hash冲突");
      }
      draft.entities.planningMemorySelections[planningMemorySelectionId] = existing ?? selection;
      const inputRefs: NodeProductRef[] = snapshots
        .map((snapshot) => ({
          kind: "memory_result_snapshot" as const,
          id: snapshot.memoryResultSnapshotId,
          revision: snapshot.revision,
          sha256: snapshot.sha256,
          label: snapshot.title,
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
      const selectionRef: NodeProductRef = {
        kind: "planning_memory_selection",
        id: selection.planningMemorySelectionId,
        revision: selection.revision,
        sha256: selection.sha256,
        label: `已冻结${String(selection.selected.length)}条Memory引用`,
      };
      const nodeRun = commitPlanningContextNodeFact(draft, {
        run: planningRun,
        runSpec,
        definitionNodeId: input.definitionNodeId,
        nodeType: "context.memory",
        executionPath: input.executionPath,
        attemptNumber: input.attemptNumber,
        terminal: "succeeded",
        outcomeCode: "success",
        publicSummary: `已采用${String(selection.selected.length)}条Memory Snapshot`,
        inputSlots: [{ name: "memory_snapshots", refs: inputRefs }],
        outputSlots: [{ name: "selection", refs: [selectionRef] }],
        relatedProductRef: selectionRef,
        at: now,
      });
      return {
        resultRefs: {
          productRunId: input.productRunId,
          workflowNodeRunId: nodeRun.workflowNodeRunId,
          planningMemorySelectionId,
          contextStatus: "ready",
        },
      };
    },
  });

  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const selection =
    snapshot.entities.planningMemorySelections[
      transaction.resultRefs["planningMemorySelectionId"] ?? ""
    ];
  if (selection === undefined) {
    return preparePlanningMemoryContextResponseSchema.parse({
      schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
      status: "none",
      productRunId: input.productRunId,
      workflowRunSpecId: input.workflowRunSpecId,
    });
  }
  return preparePlanningMemoryContextResponseSchema.parse({
    schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
    status: "ready",
    productRunId: input.productRunId,
    workflowRunSpecId: input.workflowRunSpecId,
    selectionRef: {
      planningMemorySelectionId: selection.planningMemorySelectionId,
      revision: selection.revision,
      sha256: selection.sha256,
    },
    snapshots: selection.selected.map((selected) => {
      const memory = snapshot.entities.memoryResultSnapshots[selected.memoryResultSnapshotId];
      if (
        memory === undefined ||
        memory.revision !== selected.revision ||
        memory.sha256 !== selected.sha256
      ) {
        throw notFound("Planning Memory Selection引用不存在或已损坏");
      }
      return {
        memoryResultSnapshotId: memory.memoryResultSnapshotId,
        revision: memory.revision,
        sha256: memory.sha256,
        title: memory.title,
        kind: memory.kind,
        memoryLayer: memory.memoryLayer,
        content: memory.content,
        tags: memory.tags,
        tokenEstimate: memory.tokenEstimate,
      };
    }),
    totalContentCharacters: selection.selected.reduce((total, selected) => {
      const memory = snapshot.entities.memoryResultSnapshots[selected.memoryResultSnapshotId];
      return total + (memory?.content.length ?? 0);
    }, 0),
  });
}

function includedMemoryResources(
  runSpec: WorkflowRunSpec,
  definitionNodeId: string,
): readonly IncludedResource[] {
  return runSpec.resourceResolutions
    .flatMap((resource) =>
      resource.definitionNodeId === definitionNodeId &&
      resource.resourceKind === "memory" &&
      resource.resolution === "included"
        ? [resource]
        : [],
    )
    .sort((left, right) => left.resourceId.localeCompare(right.resourceId));
}

export function planningMemorySelectionForRun(
  entities: ProductEntities,
  productRunId: string,
): PlanningMemorySelection | undefined {
  return Object.values(entities.planningMemorySelections).find(
    (selection) => selection.productRunId === productRunId,
  );
}
