import {
  MemoryImportBackendError,
  type MemoryImportAccepted,
  type MemoryImportInput,
  type MemoryImportReconcileOutput,
} from "@chat/application";
import { computeMemoryImportBackendDescriptorSha256, sha256Hex } from "@chat/domain";
import type { MemoryImportResult } from "@chat/contracts";
import {
  getWorkflowRuntimeContext,
  workflowMemoryImportTraceId,
  workflowSpanId,
} from "./runtime-context.js";
import { cmdId, wrapApiError } from "./workflow-step-support.js";
import type { RuntimeApiClient } from "./api-client.js";

export type LoadedMemoryImportStepResult = Awaited<
  ReturnType<RuntimeApiClient["loadMemoryImport"]>
> & { readonly outboxId: string };

export type MemoryImportCallOutcome =
  | {
      readonly status: "accepted";
      readonly accepted: MemoryImportAccepted;
      readonly durationMs: number;
    }
  | {
      readonly status: "failed";
      readonly errorCode: string;
      readonly summary: string;
      readonly durationMs: number;
    }
  | { readonly status: "outcome_unknown"; readonly errorCode: string; readonly durationMs: number };

function importTraceBase(loaded: LoadedMemoryImportStepResult, resultRevision: number) {
  return {
    traceId: workflowMemoryImportTraceId(loaded.intent.memoryImportIntentId),
    spanId: workflowSpanId(),
    memoryImportIntentId: loaded.intent.memoryImportIntentId,
    memoryImportResultId: loaded.result.memoryImportResultId,
    outboxId: loaded.outboxId,
    operationId: loaded.intent.operationId,
    backendId: loaded.intent.backendId,
    requestSha256: loaded.intent.requestSha256,
    intentRevision: loaded.intent.revision,
    resultRevision,
  };
}

function importError(errorCode: string) {
  return { code: errorCode, type: "MemoryImportBackendError" as const };
}

export async function loadMemoryImportStep(input: {
  memoryImportIntentId: string;
  memoryImportResultId: string;
  outboxId: string;
}): Promise<LoadedMemoryImportStepResult> {
  "use step";
  try {
    const loaded = await getWorkflowRuntimeContext().api.loadMemoryImport({
      memoryImportIntentId: input.memoryImportIntentId as never,
      memoryImportResultId: input.memoryImportResultId as never,
    });
    return { ...loaded, outboxId: input.outboxId };
  } catch (error) {
    wrapApiError(error);
  }
}

export async function markMemoryImportDispatchingStep(input: {
  memoryImportIntentId: string;
  memoryImportResultId: string;
  requestSha256: string;
  expectedRevision: number;
}): Promise<MemoryImportResult> {
  "use step";
  try {
    const response = await getWorkflowRuntimeContext().api.markMemoryImportDispatching({
      commandId: cmdId("memory-import-dispatching", input.memoryImportIntentId),
      memoryImportIntentId: input.memoryImportIntentId,
      memoryImportResultId: input.memoryImportResultId,
      requestSha256: input.requestSha256,
      expectedRevision: input.expectedRevision,
    });
    return response.result;
  } catch (error) {
    wrapApiError(error);
  }
}

function runtimeImportBackend(loaded: LoadedMemoryImportStepResult) {
  const backend = getWorkflowRuntimeContext().memoryImportBackends?.get(loaded.intent.backendId);
  if (backend === undefined) {
    throw new MemoryImportBackendError({
      code: "memory.import.backend_not_configured",
      message: "Workflow Runtime未配置Memory Import后端",
      phase: "before_external_call",
    });
  }
  const current = backend.describeImport().descriptor;
  if (
    computeMemoryImportBackendDescriptorSha256(current) !== loaded.intent.backendDescriptorSha256
  ) {
    throw new MemoryImportBackendError({
      code: "memory.import.backend_configuration_drift",
      message: "Memory Import后端配置与冻结Intent不一致",
      phase: "before_external_call",
    });
  }
  return backend;
}

export async function callMemoryImportStep(input: {
  loaded: LoadedMemoryImportStepResult;
  dispatching: MemoryImportResult;
}): Promise<MemoryImportCallOutcome> {
  "use step";
  const ctx = getWorkflowRuntimeContext();
  const startedAt = Date.now();
  ctx.trace({
    ...importTraceBase(input.loaded, input.dispatching.revision),
    level: "info",
    eventName: "memory.import.started",
    outcome: "unknown",
    dispatchAttempt: input.dispatching.dispatchAttempts,
  } as never);
  try {
    const accepted = await runtimeImportBackend(input.loaded).import(
      input.loaded.adapterInput as MemoryImportInput,
    );
    return { status: "accepted", accepted, durationMs: Date.now() - startedAt };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (error instanceof MemoryImportBackendError) {
      return error.phase === "write_outcome_unknown"
        ? { status: "outcome_unknown", errorCode: error.code, durationMs }
        : {
            status: "failed",
            errorCode: error.code,
            summary: "Memory服务拒绝导入请求",
            durationMs,
          };
    }
    return {
      status: "outcome_unknown",
      errorCode: "memory.import.unexpected_failure",
      durationMs,
    };
  }
}
callMemoryImportStep.maxRetries = 0;

export async function reconcileMemoryImportStep(input: {
  loaded: LoadedMemoryImportStepResult;
  result: MemoryImportResult;
  externalObjectId?: string;
}): Promise<MemoryImportReconcileOutput> {
  "use step";
  const ctx = getWorkflowRuntimeContext();
  const startedAt = Date.now();
  ctx.trace({
    ...importTraceBase(input.loaded, input.result.revision),
    level: "info",
    eventName: "memory.import.reconcile.started",
    outcome: "unknown",
    reconcileAttempt: input.result.reconcileAttempts + 1,
  } as never);
  try {
    const result = await runtimeImportBackend(input.loaded).reconcile({
      ...(input.loaded.adapterInput as MemoryImportInput),
      ...(input.externalObjectId !== undefined ? { externalObjectId: input.externalObjectId } : {}),
    });
    const durationMs = Date.now() - startedAt;
    if (result.status === "outcome_unknown") {
      ctx.trace({
        ...importTraceBase(input.loaded, input.result.revision),
        level: "warn",
        eventName: "memory.import.reconcile.failed",
        outcome: "failure",
        error: importError(result.errorCode),
        reconcileAttempt: input.result.reconcileAttempts + 1,
        durationMs,
      } as never);
    } else {
      ctx.trace({
        ...importTraceBase(input.loaded, input.result.revision),
        level: "info",
        eventName: "memory.import.reconcile.completed",
        outcome: "success",
        resolution: result.status,
        reconcileAttempt: input.result.reconcileAttempts + 1,
        ...(result.status === "accepted" || result.status === "materialized"
          ? { externalObjectIdSha256: sha256Hex(result.accepted.externalObjectId) }
          : {}),
        durationMs,
      } as never);
    }
    return result;
  } catch (error) {
    const outcome = {
      status: "outcome_unknown",
      errorCode:
        error instanceof MemoryImportBackendError ? error.code : "memory.import.reconcile_failed",
    } as const;
    ctx.trace({
      ...importTraceBase(input.loaded, input.result.revision),
      level: "warn",
      eventName: "memory.import.reconcile.failed",
      outcome: "failure",
      error: importError(outcome.errorCode),
      reconcileAttempt: input.result.reconcileAttempts + 1,
      durationMs: Date.now() - startedAt,
    } as never);
    return outcome;
  }
}
reconcileMemoryImportStep.maxRetries = 0;

export async function commitMemoryImportAcceptedStep(input: {
  loaded: LoadedMemoryImportStepResult;
  intentId: string;
  result: MemoryImportResult;
  accepted: MemoryImportAccepted;
  durationMs: number;
  reconciled?: boolean;
}): Promise<MemoryImportResult> {
  "use step";
  try {
    const response = await getWorkflowRuntimeContext().api.commitMemoryImportAccepted({
      commandId: cmdId("memory-import-accepted", input.intentId, String(input.result.revision)),
      memoryImportIntentId: input.loaded.intent.memoryImportIntentId,
      memoryImportResultId: input.result.memoryImportResultId,
      requestSha256: input.loaded.intent.requestSha256,
      expectedRevision: input.result.revision,
      accepted: input.accepted,
      ...(input.reconciled === true ? { reconciled: true } : {}),
    });
    if (input.reconciled !== true) {
      getWorkflowRuntimeContext().trace({
        ...importTraceBase(input.loaded, response.result.revision),
        level: "info",
        eventName: "memory.import.accepted",
        outcome: "success",
        externalObjectIdSha256: sha256Hex(input.accepted.externalObjectId),
        responseSha256: input.accepted.responseSha256,
        dispatchAttempt: input.result.dispatchAttempts,
        durationMs: input.durationMs,
      } as never);
    }
    return response.result;
  } catch (error) {
    wrapApiError(error);
  }
}

export async function commitMemoryImportMaterializedStep(input: {
  loaded: LoadedMemoryImportStepResult;
  intentId: string;
  result: MemoryImportResult;
  accepted: MemoryImportAccepted;
  verificationKind: "read_by_id_and_search" | "l0_and_session_l1";
  verificationSha256: string;
  reconciled?: boolean;
}): Promise<MemoryImportResult> {
  "use step";
  try {
    const response = await getWorkflowRuntimeContext().api.commitMemoryImportMaterialized({
      commandId: cmdId("memory-import-materialized", input.intentId, String(input.result.revision)),
      memoryImportIntentId: input.loaded.intent.memoryImportIntentId,
      memoryImportResultId: input.result.memoryImportResultId,
      requestSha256: input.loaded.intent.requestSha256,
      expectedRevision: input.result.revision,
      accepted: input.accepted,
      verificationKind: input.verificationKind,
      verificationSha256: input.verificationSha256,
      ...(input.reconciled === true ? { reconciled: true } : {}),
    });
    getWorkflowRuntimeContext().trace({
      ...importTraceBase(input.loaded, response.result.revision),
      level: "info",
      eventName: "memory.import.materialized",
      outcome: "success",
      externalObjectIdSha256: sha256Hex(input.accepted.externalObjectId),
      verificationSha256: input.verificationSha256,
      reconcileAttempt: response.result.reconcileAttempts,
      durationMs: 0,
    } as never);
    return response.result;
  } catch (error) {
    wrapApiError(error);
  }
}

export async function commitMemoryImportFailedStep(input: {
  loaded: LoadedMemoryImportStepResult;
  intentId: string;
  result: MemoryImportResult;
  errorCode: string;
  summary: string;
  durationMs: number;
  reconciled?: boolean;
}): Promise<MemoryImportResult> {
  "use step";
  try {
    const response = await getWorkflowRuntimeContext().api.commitMemoryImportFailed({
      commandId: cmdId(
        "memory-import-failed",
        input.intentId,
        String(input.result.revision),
        input.errorCode,
      ),
      memoryImportIntentId: input.loaded.intent.memoryImportIntentId,
      memoryImportResultId: input.result.memoryImportResultId,
      requestSha256: input.loaded.intent.requestSha256,
      expectedRevision: input.result.revision,
      errorCode: input.errorCode,
      summary: input.summary,
      ...(input.reconciled === true ? { reconciled: true } : {}),
    });
    getWorkflowRuntimeContext().trace({
      ...importTraceBase(input.loaded, response.result.revision),
      level: "warn",
      eventName: "memory.import.failed",
      outcome: "failure",
      error: importError(input.errorCode),
      origin: input.reconciled === true ? "reconcile" : "dispatch",
      attempt:
        input.reconciled === true
          ? response.result.reconcileAttempts
          : response.result.dispatchAttempts,
      durationMs: input.durationMs,
    } as never);
    return response.result;
  } catch (error) {
    wrapApiError(error);
  }
}

export async function commitMemoryImportUnknownStep(input: {
  loaded: LoadedMemoryImportStepResult;
  intentId: string;
  result: MemoryImportResult;
  errorCode: string;
  durationMs: number;
  reconciled?: boolean;
}): Promise<MemoryImportResult> {
  "use step";
  try {
    const response = await getWorkflowRuntimeContext().api.commitMemoryImportOutcomeUnknown({
      commandId: cmdId(
        "memory-import-outcome-unknown",
        input.intentId,
        String(input.result.revision),
        input.errorCode,
      ),
      memoryImportIntentId: input.loaded.intent.memoryImportIntentId,
      memoryImportResultId: input.result.memoryImportResultId,
      requestSha256: input.loaded.intent.requestSha256,
      expectedRevision: input.result.revision,
      errorCode: input.errorCode,
      ...(input.reconciled === true ? { reconciled: true } : {}),
    });
    getWorkflowRuntimeContext().trace({
      ...importTraceBase(input.loaded, response.result.revision),
      level: "warn",
      eventName: "memory.import.outcome_unknown",
      outcome: "unknown",
      error: importError(input.errorCode),
      origin: input.reconciled === true ? "reconcile" : "dispatch",
      attempt:
        input.reconciled === true
          ? response.result.reconcileAttempts
          : response.result.dispatchAttempts,
      durationMs: input.durationMs,
    } as never);
    return response.result;
  } catch (error) {
    wrapApiError(error);
  }
}
