import type { MemoryWriteResult } from "@chat/contracts";
import {
  memoryWriteWorkflowInputSchema,
  type MemoryWriteWorkflowInput,
} from "./memory-write-workflow-input.js";
import {
  callMemoryWriteProviderStep,
  commitMemoryWriteAcceptedStep,
  commitMemoryWriteFailedStep,
  commitMemoryWriteMaterializedStep,
  commitMemoryWriteUnknownStep,
  loadMemoryWriteStep,
  markMemoryWriteDispatchingStep,
  reconcileMemoryWriteProviderStep,
  type LoadedMemoryWriteStepResult,
} from "./memory-write-workflow-steps.js";

export interface MemoryWriteWorkflowResult {
  readonly memoryWriteIntentId: string;
  readonly status: MemoryWriteResult["status"];
}

type TerminalMemoryWriteResult = Extract<
  MemoryWriteResult,
  { readonly status: "accepted" | "materialized" | "failed" | "outcome_unknown" }
>;

function terminalMemoryWriteResult(result: MemoryWriteResult): TerminalMemoryWriteResult {
  if (result.status === "queued" || result.status === "dispatching") {
    throw new Error("memory.write.lifecycle_not_terminal");
  }
  return result;
}

async function settleReconcile(
  loaded: LoadedMemoryWriteStepResult,
  result: MemoryWriteResult,
): Promise<MemoryWriteResult> {
  const reconciled = await reconcileMemoryWriteProviderStep({
    loaded,
    ...(result.status === "accepted" ? { externalObjectId: result.externalObjectId } : {}),
  });
  if (reconciled.status === "materialized") {
    return commitMemoryWriteMaterializedStep({
      loaded,
      result,
      accepted: reconciled.accepted,
      verificationKind: reconciled.verificationKind,
      verificationSha256: reconciled.verificationSha256,
      reconciled: true,
    });
  }
  if (reconciled.status === "accepted") {
    return commitMemoryWriteAcceptedStep({
      loaded,
      result,
      accepted: reconciled.accepted,
      reconciled: true,
    });
  }
  if (reconciled.status === "failed") {
    return commitMemoryWriteFailedStep({
      loaded,
      result,
      errorCode: reconciled.errorCode,
      summary: reconciled.summary,
      reconciled: true,
    });
  }
  return commitMemoryWriteUnknownStep({
    loaded,
    result,
    errorCode: reconciled.errorCode,
    reconciled: true,
  });
}

/** 同一耐久写入生命周期可由独立MemoryWriteWorkflow或显式Memory Planning节点调用。 */
export async function executeLoadedMemoryWrite(
  loaded: LoadedMemoryWriteStepResult,
  expectedResultRevision: number,
): Promise<TerminalMemoryWriteResult> {
  if (
    loaded.result.status === "dispatching" ||
    loaded.result.status === "accepted" ||
    loaded.result.status === "outcome_unknown"
  ) {
    return terminalMemoryWriteResult(await settleReconcile(loaded, loaded.result));
  }
  if (loaded.result.status === "materialized" || loaded.result.status === "failed") {
    return loaded.result;
  }
  const dispatching = await markMemoryWriteDispatchingStep({
    loaded,
    expectedRevision: expectedResultRevision,
  });
  const called = await callMemoryWriteProviderStep({ loaded });
  if (called.status === "failed") {
    return terminalMemoryWriteResult(
      await commitMemoryWriteFailedStep({
        loaded,
        result: dispatching,
        errorCode: called.errorCode,
        summary: called.summary,
      }),
    );
  }
  if (called.status === "outcome_unknown") {
    const unknown = await commitMemoryWriteUnknownStep({
      loaded,
      result: dispatching,
      errorCode: called.errorCode,
    });
    return terminalMemoryWriteResult(await settleReconcile(loaded, unknown));
  }
  const accepted = await commitMemoryWriteAcceptedStep({
    loaded,
    result: dispatching,
    accepted: called.accepted,
  });
  return terminalMemoryWriteResult(await settleReconcile(loaded, accepted));
}

export async function memoryWriteWorkflow(
  rawInput: MemoryWriteWorkflowInput,
): Promise<MemoryWriteWorkflowResult> {
  "use workflow";
  const input = memoryWriteWorkflowInputSchema.parse(rawInput);
  const loaded = await loadMemoryWriteStep(input);
  if (input.mode === "reconcile") {
    if (!["dispatching", "accepted", "outcome_unknown"].includes(loaded.result.status)) {
      return { memoryWriteIntentId: input.memoryWriteIntentId, status: loaded.result.status };
    }
    const result = await settleReconcile(loaded, loaded.result);
    return { memoryWriteIntentId: input.memoryWriteIntentId, status: result.status };
  }
  const result = await executeLoadedMemoryWrite(loaded, input.expectedResultRevision);
  return { memoryWriteIntentId: input.memoryWriteIntentId, status: result.status };
}
