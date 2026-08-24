import {
  INTERNAL_RUNTIME_SCHEMA_VERSION,
  beginMemoryAgentOperationResponseSchema,
  memoryAgentOperationIdSchema,
  memoryAgentOperationResponseSchema,
  memoryAgentOperationSchema,
  memoryAgentOperationResultSchema,
  type BeginMemoryAgentOperationRequest,
  type CompleteMemoryAgentOperationRequest,
  type MarkMemoryAgentOperationOutcomeUnknownRequest,
  type MemoryAgentOperation,
  type MemoryAgentOperationId,
  type ProductSnapshot,
} from "@chat/contracts";
import {
  computeMemoryAgentOperationInputSha256,
  computeMemoryAgentOperationResultSha256,
  deriveMemoryAgentOperationId,
  hashCanonical,
} from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import { CommandIdReusedError, notFound, revisionConflict } from "./errors.js";
import { requireDirectAgentRun } from "./product-run-kind.js";
import { validateWorkflowRunSpecIntegrity } from "./workflow-run-spec-compiler.js";

function operationIdFor(input: {
  readonly productRunId: string;
  readonly definitionNodeId: string;
  readonly operationKind: "retrieval" | "write";
}): MemoryAgentOperationId {
  return memoryAgentOperationIdSchema.parse(deriveMemoryAgentOperationId(input));
}

function assertOperationBinding(
  snapshot: Readonly<ProductSnapshot>,
  input: {
    readonly productRunId: string;
    readonly workflowRunSpecId: string;
    readonly definitionNodeId: string;
    readonly operationKind: "retrieval" | "write";
    readonly inputSha256: string;
    readonly sourceSha256: string;
  },
): void {
  const found = snapshot.entities.runs[input.productRunId];
  if (found === undefined) throw notFound("Product Run不存在");
  const run = requireDirectAgentRun(found);
  const rawRunSpec = snapshot.entities.workflowRunSpecs[input.workflowRunSpecId];
  const validated =
    rawRunSpec === undefined ? undefined : validateWorkflowRunSpecIntegrity(rawRunSpec);
  const node = validated?.success
    ? validated.runSpec.nodeResolutions.find(
        (candidate) => candidate.definitionNodeId === input.definitionNodeId,
      )
    : undefined;
  const expectedNodeType =
    input.operationKind === "retrieval" ? "agent.memory_retrieve" : "agent.memory_write";
  const expectedBlueprintVersions = input.operationKind === "retrieval" ? [3, 4] : [3, 5];
  if (
    run.runnerFamily !== "memory-agent-direct.v1" ||
    run.workflowRunSpecId !== input.workflowRunSpecId ||
    rawRunSpec?.productRunId !== input.productRunId ||
    validated === undefined ||
    !validated.success ||
    validated.runSpec.definitionRef.blueprintKey !== "direct" ||
    !expectedBlueprintVersions.includes(validated.runSpec.definitionRef.blueprintVersion) ||
    node?.nodeType !== expectedNodeType ||
    node.activation === "skipped" ||
    computeMemoryAgentOperationInputSha256({
      operationKind: input.operationKind,
      productRunId: input.productRunId,
      workflowRunSpecId: input.workflowRunSpecId,
      definitionNodeId: input.definitionNodeId,
      sourceSha256: input.sourceSha256,
    }) !== input.inputSha256
  ) {
    throw revisionConflict("Memory Agent Operation的Run/RunSpec/节点绑定无效");
  }
}

function assertSameOperation(
  operation: MemoryAgentOperation,
  input: {
    readonly productRunId: string;
    readonly workflowRunSpecId: string;
    readonly definitionNodeId: string;
    readonly operationKind: "retrieval" | "write";
    readonly inputSha256: string;
    readonly sourceSha256: string;
  },
): void {
  if (
    operation.productRunId !== input.productRunId ||
    operation.workflowRunSpecId !== input.workflowRunSpecId ||
    operation.definitionNodeId !== input.definitionNodeId ||
    operation.operationKind !== input.operationKind ||
    operation.inputSha256 !== input.inputSha256 ||
    operation.sourceSha256 !== input.sourceSha256
  ) {
    throw revisionConflict("Memory Agent Operation稳定身份发生输入漂移");
  }
}

function beginStatus(operation: MemoryAgentOperation) {
  return operation.status === "dispatching" ? "recovery_required" : operation.status;
}

/**
 * 先提交dispatching栅栏再允许任何模型调用。恢复读取到dispatching时只返回
 * recovery_required，调用方必须把它收敛为outcome_unknown，不能再次调用Provider。
 */
export async function beginMemoryAgentOperation(
  deps: ApplicationDeps,
  input: Omit<BeginMemoryAgentOperationRequest, "schemaVersion">,
) {
  const memoryAgentOperationId = operationIdFor(input);
  const { snapshot: before } = await deps.store.read({ kind: "committedSnapshot" });
  const requestSha256 = hashCanonical("command.begin-memory-agent-operation.v1", input);
  const priorReceipt = before.commandReceipts[input.commandId];
  if (priorReceipt !== undefined && priorReceipt.requestSha256 !== requestSha256) {
    throw new CommandIdReusedError(input.commandId);
  }
  assertOperationBinding(before, input);
  const existing = before.entities.memoryAgentOperations[memoryAgentOperationId];
  if (existing !== undefined) {
    assertSameOperation(existing, input);
    return beginMemoryAgentOperationResponseSchema.parse({
      schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
      status: beginStatus(existing),
      operation: existing,
    });
  }
  const now = deps.now();
  const transaction = await deps.store.transact({
    commandId: input.commandId,
    commandType: "BeginMemoryAgentOperation",
    requestSha256,
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      assertOperationBinding(draft, input);
      const current = draft.entities.memoryAgentOperations[memoryAgentOperationId];
      if (current !== undefined) {
        assertSameOperation(current, input);
        return {
          resultRefs: { memoryAgentOperationId, dispatchDisposition: "existing" },
        };
      }
      draft.entities.memoryAgentOperations[memoryAgentOperationId] =
        memoryAgentOperationSchema.parse({
          schemaVersion: "memory-agent-operation.v1",
          memoryAgentOperationId,
          operationKind: input.operationKind,
          productRunId: input.productRunId,
          workflowRunSpecId: input.workflowRunSpecId,
          definitionNodeId: input.definitionNodeId,
          inputSha256: input.inputSha256,
          sourceSha256: input.sourceSha256,
          status: "dispatching",
          providerRequestCount: 0,
          revision: 1,
          startedAt: now,
          createdAt: now,
          updatedAt: now,
        });
      return { resultRefs: { memoryAgentOperationId, dispatchDisposition: "created" } };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const committed = snapshot.entities.memoryAgentOperations[memoryAgentOperationId];
  if (committed === undefined) throw notFound("Memory Agent Operation不存在");
  assertSameOperation(committed, input);
  return beginMemoryAgentOperationResponseSchema.parse({
    schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
    status:
      !transaction.replayed &&
      transaction.resultRefs["dispatchDisposition"] === "created" &&
      committed.status === "dispatching"
        ? "dispatch_required"
        : beginStatus(committed),
    operation: committed,
  });
}

export async function completeMemoryAgentOperation(
  deps: ApplicationDeps,
  input: Omit<CompleteMemoryAgentOperationRequest, "schemaVersion">,
) {
  const now = deps.now();
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "CompleteMemoryAgentOperation",
    requestSha256: hashCanonical("command.complete-memory-agent-operation.v1", input),
    mutate: (draft) => {
      const current = draft.entities.memoryAgentOperations[input.memoryAgentOperationId];
      if (current === undefined) throw notFound("Memory Agent Operation不存在");
      if (
        current.status !== "dispatching" ||
        current.revision !== input.expectedRevision ||
        current.inputSha256 !== input.inputSha256
      ) {
        throw revisionConflict("Memory Agent Operation已完成或输入已变化");
      }
      if (
        input.outcome.kind === "succeeded" &&
        input.outcome.result.kind !== current.operationKind
      ) {
        throw revisionConflict("Memory Agent Operation结果类型与节点不一致");
      }
      const next =
        input.outcome.kind === "succeeded"
          ? memoryAgentOperationSchema.parse({
              ...current,
              status: "succeeded",
              result: memoryAgentOperationResultSchema.parse(input.outcome.result),
              resultSha256: computeMemoryAgentOperationResultSha256(input.outcome.result),
              providerRequestCount: input.outcome.providerRequestCount,
              ...(input.outcome.usage === undefined ? {} : { usage: input.outcome.usage }),
              completedAt: now,
              updatedAt: now,
              revision: 2,
            })
          : memoryAgentOperationSchema.parse({
              ...current,
              status: "failed",
              errorCode: input.outcome.errorCode,
              providerRequestCount: input.outcome.providerRequestCount,
              ...(input.outcome.usage === undefined ? {} : { usage: input.outcome.usage }),
              completedAt: now,
              updatedAt: now,
              revision: 2,
            });
      draft.entities.memoryAgentOperations[current.memoryAgentOperationId] = next;
      return { resultRefs: { memoryAgentOperationId: current.memoryAgentOperationId } };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const operation = snapshot.entities.memoryAgentOperations[input.memoryAgentOperationId];
  if (operation === undefined) throw notFound("Memory Agent Operation不存在");
  return memoryAgentOperationResponseSchema.parse({ operation });
}

export async function markMemoryAgentOperationOutcomeUnknown(
  deps: ApplicationDeps,
  input: Omit<MarkMemoryAgentOperationOutcomeUnknownRequest, "schemaVersion">,
) {
  const now = deps.now();
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "MarkMemoryAgentOperationOutcomeUnknown",
    requestSha256: hashCanonical("command.mark-memory-agent-operation-unknown.v1", input),
    mutate: (draft) => {
      const current = draft.entities.memoryAgentOperations[input.memoryAgentOperationId];
      if (current === undefined) throw notFound("Memory Agent Operation不存在");
      if (
        current.status !== "dispatching" ||
        current.revision !== input.expectedRevision ||
        current.inputSha256 !== input.inputSha256
      ) {
        throw revisionConflict("Memory Agent Operation已完成或输入已变化");
      }
      draft.entities.memoryAgentOperations[current.memoryAgentOperationId] =
        memoryAgentOperationSchema.parse({
          ...current,
          status: "outcome_unknown",
          errorCode: input.errorCode,
          providerRequestCount: input.providerRequestCount,
          completedAt: now,
          updatedAt: now,
          revision: 2,
        });
      return { resultRefs: { memoryAgentOperationId: current.memoryAgentOperationId } };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const operation = snapshot.entities.memoryAgentOperations[input.memoryAgentOperationId];
  if (operation === undefined) throw notFound("Memory Agent Operation不存在");
  return memoryAgentOperationResponseSchema.parse({ operation });
}
