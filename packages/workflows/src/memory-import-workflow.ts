import type { MemoryImportResult } from "@chat/contracts";
import {
  memoryImportWorkflowInputSchema,
  type MemoryImportWorkflowInput,
} from "./memory-import-workflow-input.js";
import {
  callMemoryImportStep,
  commitMemoryImportAcceptedStep,
  commitMemoryImportFailedStep,
  commitMemoryImportMaterializedStep,
  commitMemoryImportUnknownStep,
  loadMemoryImportStep,
  markMemoryImportDispatchingStep,
  reconcileMemoryImportStep,
  type LoadedMemoryImportStepResult,
} from "./memory-import-workflow-steps.js";

export interface MemoryImportWorkflowResult {
  readonly memoryImportIntentId: string;
  readonly status: MemoryImportResult["status"];
}

async function settleReconcile(
  input: MemoryImportWorkflowInput,
  loaded: LoadedMemoryImportStepResult,
  result: MemoryImportResult,
  externalObjectId?: string,
): Promise<MemoryImportResult> {
  const reconciled = await reconcileMemoryImportStep({
    loaded,
    result,
    ...(externalObjectId !== undefined ? { externalObjectId } : {}),
  });
  if (reconciled.status === "materialized") {
    return commitMemoryImportMaterializedStep({
      loaded,
      intentId: input.memoryImportIntentId,
      result,
      accepted: reconciled.accepted,
      verificationSha256: reconciled.verificationSha256,
      reconciled: true,
    });
  }
  if (reconciled.status === "accepted") {
    return commitMemoryImportAcceptedStep({
      loaded,
      intentId: input.memoryImportIntentId,
      result,
      accepted: reconciled.accepted,
      durationMs: 0,
      reconciled: true,
    });
  }
  if (reconciled.status === "failed") {
    return commitMemoryImportFailedStep({
      loaded,
      intentId: input.memoryImportIntentId,
      result,
      errorCode: reconciled.errorCode,
      summary: reconciled.summary,
      durationMs: 0,
      reconciled: true,
    });
  }
  if (result.status === "accepted") {
    return commitMemoryImportAcceptedStep({
      loaded,
      intentId: input.memoryImportIntentId,
      result,
      accepted: {
        externalObjectId: result.externalObjectId,
        responseSha256: result.responseSha256,
        ...(result.externalObjectVersion !== undefined
          ? { externalObjectVersion: result.externalObjectVersion }
          : {}),
        ...(result.externalStatus !== undefined ? { externalStatus: result.externalStatus } : {}),
      },
      durationMs: 0,
      reconciled: true,
    });
  }
  return commitMemoryImportUnknownStep({
    loaded,
    intentId: input.memoryImportIntentId,
    result,
    errorCode: reconciled.errorCode,
    durationMs: 0,
    reconciled: true,
  });
}

export async function memoryImportWorkflow(
  rawInput: MemoryImportWorkflowInput,
): Promise<MemoryImportWorkflowResult> {
  "use workflow";
  const input = memoryImportWorkflowInputSchema.parse(rawInput);
  const loaded = await loadMemoryImportStep(input);

  if (input.mode === "reconcile") {
    if (!["dispatching", "accepted", "outcome_unknown"].includes(loaded.result.status)) {
      return {
        memoryImportIntentId: input.memoryImportIntentId,
        status: loaded.result.status,
      };
    }
    const result = await settleReconcile(
      input,
      loaded,
      loaded.result,
      loaded.result.status === "accepted" ? loaded.result.externalObjectId : undefined,
    );
    return { memoryImportIntentId: input.memoryImportIntentId, status: result.status };
  }

  if (loaded.result.status !== "queued") {
    return {
      memoryImportIntentId: input.memoryImportIntentId,
      status: loaded.result.status,
    };
  }
  const dispatching = await markMemoryImportDispatchingStep({
    memoryImportIntentId: input.memoryImportIntentId,
    memoryImportResultId: input.memoryImportResultId,
    expectedRevision: input.expectedResultRevision,
  });
  const call = await callMemoryImportStep({ loaded, dispatching });
  if (call.status === "failed") {
    const result = await commitMemoryImportFailedStep({
      loaded,
      intentId: input.memoryImportIntentId,
      result: dispatching,
      errorCode: call.errorCode,
      summary: call.summary,
      durationMs: call.durationMs,
    });
    return { memoryImportIntentId: input.memoryImportIntentId, status: result.status };
  }
  if (call.status === "outcome_unknown") {
    const unknown = await commitMemoryImportUnknownStep({
      loaded,
      intentId: input.memoryImportIntentId,
      result: dispatching,
      errorCode: call.errorCode,
      durationMs: call.durationMs,
    });
    const result = await settleReconcile(input, loaded, unknown);
    return { memoryImportIntentId: input.memoryImportIntentId, status: result.status };
  }
  const accepted = await commitMemoryImportAcceptedStep({
    loaded,
    intentId: input.memoryImportIntentId,
    result: dispatching,
    accepted: call.accepted,
    durationMs: call.durationMs,
  });
  const result = await settleReconcile(input, loaded, accepted, call.accepted.externalObjectId);
  return { memoryImportIntentId: input.memoryImportIntentId, status: result.status };
}
