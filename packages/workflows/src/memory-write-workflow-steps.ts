import {
  WorkflowMemoryWriteProviderError,
  type WorkflowMemoryWriteAccepted,
  type WorkflowMemoryWriteReconcileOutput,
} from "@chat/application";
import { type MemoryWriteResult, type LoadMemoryWriteResponse } from "@chat/contracts";
import { computeMemoryProviderDescriptorSha256 } from "@chat/domain";
import { getWorkflowRuntimeContext } from "./runtime-context.js";
import { cmdId, wrapApiError } from "./workflow-step-support.js";
import { runStep } from "./workflow-step-support.js";
import type { RuntimeApiClient } from "./api-client.js";
import type { WorkflowMemoryNodeIdentity } from "./workflow-memory-steps.js";

export type LoadedMemoryWriteStepResult = Awaited<ReturnType<RuntimeApiClient["loadMemoryWrite"]>>;

export type MemoryWriteCallOutcome =
  | { readonly status: "accepted"; readonly accepted: WorkflowMemoryWriteAccepted }
  | { readonly status: "failed"; readonly errorCode: string; readonly summary: string }
  | { readonly status: "outcome_unknown"; readonly errorCode: string };

export async function loadMemoryWriteStep(input: {
  readonly memoryWriteIntentId: string;
  readonly memoryWriteResultId: string;
  readonly outboxId: string;
}): Promise<LoadedMemoryWriteStepResult> {
  "use step";
  try {
    const loaded: LoadMemoryWriteResponse = await getWorkflowRuntimeContext().api.loadMemoryWrite({
      memoryWriteIntentId: input.memoryWriteIntentId as never,
      memoryWriteResultId: input.memoryWriteResultId as never,
    });
    return loaded;
  } catch (error) {
    wrapApiError(error);
  }
}

function nodeExecutionIdentity(input: WorkflowMemoryNodeIdentity): string {
  return [
    input.workflowRunSpecId,
    input.definitionNodeId,
    ...input.executionPath.map(
      (segment) => `${segment.containerNodeId}:${String(segment.iteration)}`,
    ),
    `attempt:${String(input.attemptNumber)}`,
  ].join("/");
}

export async function beginWorkflowMemoryWriteNodeStep(
  input: WorkflowMemoryNodeIdentity,
): Promise<LoadedMemoryWriteStepResult> {
  "use step";
  return runStep(
    input.productRunId,
    input.workflowAttemptId,
    "begin_workflow_memory_write",
    async () => {
      try {
        return await getWorkflowRuntimeContext().api.beginWorkflowMemoryWrite({
          commandId: cmdId(
            "begin-workflow-memory-write",
            input.productRunId,
            nodeExecutionIdentity(input),
          ) as never,
          productRunId: input.productRunId as never,
          workflowRunSpecId: input.workflowRunSpecId as never,
          definitionNodeId: input.definitionNodeId,
          executionPath: input.executionPath.map((segment) => ({
            containerNodeId: segment.containerNodeId as never,
            iteration: segment.iteration,
          })),
          attemptNumber: input.attemptNumber,
        });
      } catch (error) {
        wrapApiError(error);
      }
    },
  );
}

export async function markMemoryWriteDispatchingStep(input: {
  readonly loaded: LoadedMemoryWriteStepResult;
  readonly expectedRevision: number;
}): Promise<MemoryWriteResult> {
  "use step";
  try {
    return (
      await getWorkflowRuntimeContext().api.markMemoryWriteDispatching({
        commandId: cmdId("memory-write-dispatching", input.loaded.intent.memoryWriteIntentId),
        memoryWriteIntentId: input.loaded.intent.memoryWriteIntentId,
        memoryWriteResultId: input.loaded.result.memoryWriteResultId,
        requestSha256: input.loaded.intent.requestSha256,
        expectedRevision: input.expectedRevision,
      })
    ).result;
  } catch (error) {
    wrapApiError(error);
  }
}

function runtimeProvider(loaded: LoadedMemoryWriteStepResult) {
  const provider = getWorkflowRuntimeContext().workflowMemoryProviders.getWrite(
    loaded.intent.providerId,
  );
  if (provider === undefined) {
    throw new WorkflowMemoryWriteProviderError({
      code: "memory.write.provider_not_configured",
      message: "Workflow Runtime未配置Memory Write Provider",
      phase: "before_external_call",
    });
  }
  if (
    computeMemoryProviderDescriptorSha256(provider.describeProvider()) !==
    loaded.intent.providerDescriptorSha256
  ) {
    throw new WorkflowMemoryWriteProviderError({
      code: "memory.write.provider_configuration_drift",
      message: "Memory Write Provider配置与冻结Intent不一致",
      phase: "before_external_call",
    });
  }
  return provider;
}

/** 外部写入只调用一次；未知结果只能进入对账，绝不由Workflow SDK重试。 */
export async function callMemoryWriteProviderStep(input: {
  readonly loaded: LoadedMemoryWriteStepResult;
}): Promise<MemoryWriteCallOutcome> {
  "use step";
  try {
    const accepted = await runtimeProvider(input.loaded).writeMemory(input.loaded.adapterInput);
    return { status: "accepted", accepted };
  } catch (error) {
    if (error instanceof WorkflowMemoryWriteProviderError) {
      return error.phase === "write_outcome_unknown"
        ? { status: "outcome_unknown", errorCode: error.code }
        : { status: "failed", errorCode: error.code, summary: "Memory Provider拒绝写入" };
    }
    return { status: "outcome_unknown", errorCode: "memory.write.unexpected_failure" };
  }
}
callMemoryWriteProviderStep.maxRetries = 0;

export async function reconcileMemoryWriteProviderStep(input: {
  readonly loaded: LoadedMemoryWriteStepResult;
  readonly externalObjectId?: string;
}): Promise<WorkflowMemoryWriteReconcileOutput> {
  "use step";
  try {
    return await runtimeProvider(input.loaded).reconcileMemoryWrite({
      ...input.loaded.adapterInput,
      ...(input.externalObjectId !== undefined ? { externalObjectId: input.externalObjectId } : {}),
    });
  } catch (error) {
    return {
      status: "outcome_unknown",
      errorCode:
        error instanceof WorkflowMemoryWriteProviderError
          ? error.code
          : "memory.write.reconcile_failed",
    };
  }
}
reconcileMemoryWriteProviderStep.maxRetries = 0;

interface CommitBase {
  readonly loaded: LoadedMemoryWriteStepResult;
  readonly result: MemoryWriteResult;
}

export async function commitMemoryWriteAcceptedStep(
  input: CommitBase & {
    readonly accepted: WorkflowMemoryWriteAccepted;
    readonly reconciled?: boolean;
  },
): Promise<MemoryWriteResult> {
  "use step";
  try {
    return (
      await getWorkflowRuntimeContext().api.commitMemoryWriteAccepted({
        commandId: cmdId(
          "memory-write-accepted",
          input.loaded.intent.memoryWriteIntentId,
          String(input.result.revision),
        ),
        memoryWriteIntentId: input.loaded.intent.memoryWriteIntentId,
        memoryWriteResultId: input.result.memoryWriteResultId,
        requestSha256: input.loaded.intent.requestSha256,
        expectedRevision: input.result.revision,
        accepted: input.accepted,
        ...(input.reconciled === true ? { reconciled: true } : {}),
      })
    ).result;
  } catch (error) {
    wrapApiError(error);
  }
}

export async function commitMemoryWriteMaterializedStep(
  input: CommitBase & {
    readonly accepted: WorkflowMemoryWriteAccepted;
    readonly verificationKind: string;
    readonly verificationSha256: string;
    readonly reconciled?: boolean;
  },
): Promise<MemoryWriteResult> {
  "use step";
  try {
    return (
      await getWorkflowRuntimeContext().api.commitMemoryWriteMaterialized({
        commandId: cmdId(
          "memory-write-materialized",
          input.loaded.intent.memoryWriteIntentId,
          String(input.result.revision),
        ),
        memoryWriteIntentId: input.loaded.intent.memoryWriteIntentId,
        memoryWriteResultId: input.result.memoryWriteResultId,
        requestSha256: input.loaded.intent.requestSha256,
        expectedRevision: input.result.revision,
        accepted: input.accepted,
        verificationKind: input.verificationKind,
        verificationSha256: input.verificationSha256,
        ...(input.reconciled === true ? { reconciled: true } : {}),
      })
    ).result;
  } catch (error) {
    wrapApiError(error);
  }
}

export async function commitMemoryWriteFailedStep(
  input: CommitBase & {
    readonly errorCode: string;
    readonly summary: string;
    readonly reconciled?: boolean;
  },
): Promise<MemoryWriteResult> {
  "use step";
  try {
    return (
      await getWorkflowRuntimeContext().api.commitMemoryWriteFailed({
        commandId: cmdId(
          "memory-write-failed",
          input.loaded.intent.memoryWriteIntentId,
          String(input.result.revision),
        ),
        memoryWriteIntentId: input.loaded.intent.memoryWriteIntentId,
        memoryWriteResultId: input.result.memoryWriteResultId,
        requestSha256: input.loaded.intent.requestSha256,
        expectedRevision: input.result.revision,
        errorCode: input.errorCode,
        summary: input.summary,
        ...(input.reconciled === true ? { reconciled: true } : {}),
      })
    ).result;
  } catch (error) {
    wrapApiError(error);
  }
}

export async function commitMemoryWriteUnknownStep(
  input: CommitBase & { readonly errorCode: string; readonly reconciled?: boolean },
): Promise<MemoryWriteResult> {
  "use step";
  try {
    return (
      await getWorkflowRuntimeContext().api.commitMemoryWriteOutcomeUnknown({
        commandId: cmdId(
          "memory-write-outcome-unknown",
          input.loaded.intent.memoryWriteIntentId,
          String(input.result.revision),
        ),
        memoryWriteIntentId: input.loaded.intent.memoryWriteIntentId,
        memoryWriteResultId: input.result.memoryWriteResultId,
        requestSha256: input.loaded.intent.requestSha256,
        expectedRevision: input.result.revision,
        errorCode: input.errorCode,
        ...(input.reconciled === true ? { reconciled: true } : {}),
      })
    ).result;
  } catch (error) {
    wrapApiError(error);
  }
}
