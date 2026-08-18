import {
  PROVIDER_MODEL,
  PROVIDER_NAME,
  TRACE_EVENT_NAMES,
  productRunIdSchema,
  runAttemptIdSchema,
  type TraceEventInput,
} from "@chat/contracts";
import type { PiExecutorEvent } from "@chat/pi-runtime";
import {
  getWorkflowRuntimeContext,
  workflowRunTraceId,
  workflowSpanId,
} from "./runtime-context.js";

interface PiExecutorTraceScope {
  readonly productRunId: string;
  readonly attemptId: string;
  readonly promptTemplateVersion: string;
  readonly modelConfigVersion: string;
}

function error<Type extends "PiExecutorError" | "PiToolError" | "ProviderError">(
  code: string,
  type: Type,
) {
  return { code, type } as const;
}

/**
 * Executor Service Journal -> Chat Trace的唯一投影。只复制ID、Hash、枚举、统计和稳定错误码；
 * Agent消息、Prompt、Tool参数/结果与Provider正文没有任何字段通道。
 */
export function emitPiExecutorTrace(scope: PiExecutorTraceScope, event: PiExecutorEvent): void {
  const ctx = getWorkflowRuntimeContext();
  const common = {
    level:
      event.type === "operation.failed" ||
      event.type === "provider.failed" ||
      event.type === "tool.failed"
        ? ("error" as const)
        : event.type === "operation.outcome_unknown" ||
            event.type === "tool.outcome_unknown" ||
            event.type === "tool.blocked"
          ? ("warn" as const)
          : ("info" as const),
    traceId: workflowRunTraceId(scope.productRunId),
    spanId: workflowSpanId(),
    productRunId: productRunIdSchema.parse(scope.productRunId),
    attemptId: runAttemptIdSchema.parse(scope.attemptId),
    promptTemplateVersion: scope.promptTemplateVersion,
    modelConfigVersion: scope.modelConfigVersion,
    piOperationId: event.operationId,
    operationEventSequence: event.sequence,
    sourceTimestamp: event.timestamp,
  };
  const sessionCommon =
    "sessionId" in event ? { ...common, piRuntimeSessionId: event.sessionId } : undefined;

  let traceEvent: TraceEventInput;
  switch (event.type) {
    case "operation.accepted":
      traceEvent = {
        ...common,
        eventName: TRACE_EVENT_NAMES.piOperationAccepted,
        outcome: "unknown",
        requestSha256: event.requestSha256,
        ...(event.workspaceRootId !== undefined ? { workspaceRootId: event.workspaceRootId } : {}),
      };
      break;
    case "operation.started":
      traceEvent = {
        ...common,
        eventName: TRACE_EVENT_NAMES.piOperationStarted,
        outcome: "unknown",
        requestSha256: event.requestSha256,
      };
      break;
    case "operation.completed":
      traceEvent = {
        ...common,
        eventName: TRACE_EVENT_NAMES.piOperationCompleted,
        outcome: "success",
        requestSha256: event.requestSha256,
        resultSha256: event.resultSha256,
        durationMs: event.durationMs,
      };
      break;
    case "operation.failed":
      traceEvent = {
        ...common,
        eventName: TRACE_EVENT_NAMES.piOperationFailed,
        outcome: "failure",
        requestSha256: event.requestSha256,
        error: error(event.errorCode, "PiExecutorError"),
        durationMs: event.durationMs,
      };
      break;
    case "operation.outcome_unknown":
      traceEvent = {
        ...common,
        eventName: TRACE_EVENT_NAMES.piOperationOutcomeUnknown,
        outcome: "unknown",
        requestSha256: event.requestSha256,
        error: error(event.errorCode, "PiExecutorError"),
        durationMs: event.durationMs,
      };
      break;
    case "session.started":
      traceEvent = {
        ...sessionCommon!,
        eventName: TRACE_EVENT_NAMES.piSessionStarted,
        outcome: "unknown",
        enabledTools: event.enabledTools,
      };
      break;
    case "session.settled":
      traceEvent = {
        ...sessionCommon!,
        eventName: TRACE_EVENT_NAMES.piSessionSettled,
        outcome: "success",
        turnCount: event.turnCount,
        providerRequestCount: event.providerRequestCount,
      };
      break;
    case "turn.started":
      traceEvent = {
        ...sessionCommon!,
        eventName: TRACE_EVENT_NAMES.piTurnStarted,
        outcome: "unknown",
        turnIndex: event.turnIndex,
      };
      break;
    case "turn.completed":
      traceEvent = {
        ...sessionCommon!,
        eventName: TRACE_EVENT_NAMES.piTurnCompleted,
        outcome: "success",
        turnIndex: event.turnIndex,
        durationMs: event.durationMs,
      };
      break;
    case "provider.started":
      traceEvent = {
        ...common,
        eventName: TRACE_EVENT_NAMES.providerRequestStarted,
        outcome: "unknown",
        provider: PROVIDER_NAME,
        model: PROVIDER_MODEL,
        endpointHost: event.endpointHost,
        operation: "chat_completion",
        providerRequestIndex: event.requestIndex,
        inputManifestSha256: event.inputSha256,
      };
      break;
    case "provider.completed":
      traceEvent = {
        ...common,
        eventName: TRACE_EVENT_NAMES.providerRequestCompleted,
        outcome: "success",
        provider: PROVIDER_NAME,
        model: PROVIDER_MODEL,
        endpointHost: event.endpointHost,
        operation: "chat_completion",
        providerRequestIndex: event.requestIndex,
        inputManifestSha256: event.inputSha256,
        httpStatus: event.httpStatus,
        providerRequestId: event.providerRequestId,
        tokenUsage: event.usage,
        providerStopReason: event.stopReason,
        toolCallCount: event.toolCallCount,
        durationMs: event.durationMs,
      };
      break;
    case "provider.failed":
      traceEvent = {
        ...common,
        eventName: TRACE_EVENT_NAMES.providerRequestFailed,
        outcome: "failure",
        provider: PROVIDER_NAME,
        model: PROVIDER_MODEL,
        endpointHost: event.endpointHost,
        operation: "chat_completion",
        providerRequestIndex: event.requestIndex,
        ...(event.inputSha256 !== undefined ? { inputManifestSha256: event.inputSha256 } : {}),
        ...(event.httpStatus !== undefined ? { httpStatus: event.httpStatus } : {}),
        ...(event.providerRequestId !== undefined
          ? { providerRequestId: event.providerRequestId }
          : {}),
        error: error(event.errorCode, "ProviderError"),
        durationMs: event.durationMs,
      };
      break;
    case "message.completed":
      traceEvent = {
        ...sessionCommon!,
        eventName: TRACE_EVENT_NAMES.piMessageCompleted,
        outcome: "success",
        messageIndex: event.messageIndex,
        messageRole: event.role,
        contentSha256: event.contentSha256,
        ...(event.visibleText !== undefined ? { visibleText: event.visibleText } : {}),
        ...(event.visibleTextTruncated !== undefined
          ? { visibleTextTruncated: event.visibleTextTruncated }
          : {}),
        ...(event.stopReason !== undefined ? { providerStopReason: event.stopReason } : {}),
        ...(event.usage !== undefined ? { tokenUsage: event.usage } : {}),
      };
      break;
    case "tool.intent_persisted":
      traceEvent = {
        ...sessionCommon!,
        eventName: TRACE_EVENT_NAMES.piToolIntentPersisted,
        outcome: "unknown",
        turnIndex: event.turnIndex,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        inputSha256: event.inputSha256,
        inputDisplay: event.inputDisplay,
        inputDisplayTruncated: event.inputDisplayTruncated,
      };
      break;
    case "tool.blocked":
      traceEvent = {
        ...sessionCommon!,
        eventName: TRACE_EVENT_NAMES.piToolBlocked,
        outcome: "rejected",
        turnIndex: event.turnIndex,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        inputSha256: event.inputSha256,
        inputDisplay: event.inputDisplay,
        inputDisplayTruncated: event.inputDisplayTruncated,
        error: error(event.errorCode, "PiToolError"),
      };
      break;
    case "tool.completed":
      traceEvent = {
        ...sessionCommon!,
        eventName: TRACE_EVENT_NAMES.piToolCompleted,
        outcome: "success",
        turnIndex: event.turnIndex,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        resultSha256: event.resultSha256,
        resultDisplay: event.resultDisplay,
        resultDisplayTruncated: event.resultDisplayTruncated,
        durationMs: event.durationMs,
      };
      break;
    case "tool.failed":
      traceEvent = {
        ...sessionCommon!,
        eventName: TRACE_EVENT_NAMES.piToolFailed,
        outcome: "failure",
        turnIndex: event.turnIndex,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        resultSha256: event.resultSha256,
        resultDisplay: event.resultDisplay,
        resultDisplayTruncated: event.resultDisplayTruncated,
        error: error(event.errorCode, "PiToolError"),
        durationMs: event.durationMs,
      };
      break;
    case "tool.outcome_unknown":
      traceEvent = {
        ...sessionCommon!,
        eventName: TRACE_EVENT_NAMES.piToolOutcomeUnknown,
        outcome: "unknown",
        turnIndex: event.turnIndex,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        inputSha256: event.inputSha256,
        inputDisplay: event.inputDisplay,
        inputDisplayTruncated: event.inputDisplayTruncated,
      };
      break;
    case "compaction.started":
      traceEvent = {
        ...sessionCommon!,
        eventName: TRACE_EVENT_NAMES.piCompactionStarted,
        outcome: "unknown",
        reason: event.reason,
      };
      break;
    case "compaction.completed":
      traceEvent = {
        ...sessionCommon!,
        eventName: TRACE_EVENT_NAMES.piCompactionCompleted,
        outcome: "success",
        reason: event.reason,
        aborted: event.aborted,
      };
      break;
  }
  ctx.trace(traceEvent);
}
