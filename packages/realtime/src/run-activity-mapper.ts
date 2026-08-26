import {
  TRACE_EVENT_NAMES,
  type ProductRunId,
  type RunAttemptId,
  type RunActivityEventInput,
  type TraceEventInput,
} from "@chat/contracts";

interface ActivityCommon {
  readonly productRunId: ProductRunId;
  readonly attemptId?: RunAttemptId;
  readonly timestamp: string;
  readonly sourceKind: "workflow" | "pi_executor";
  readonly sourceOperationId?: string;
  readonly sourceSequence?: number;
}

function common(event: TraceEventInput, timestamp: string): ActivityCommon | undefined {
  if (!("productRunId" in event) || event.productRunId === undefined) return undefined;
  const sourceSequence =
    "operationEventSequence" in event ? event.operationEventSequence : undefined;
  const sourceOperationId = "piOperationId" in event ? event.piOperationId : undefined;
  return {
    productRunId: event.productRunId,
    ...("attemptId" in event ? { attemptId: event.attemptId } : {}),
    timestamp:
      "sourceTimestamp" in event && event.sourceTimestamp !== undefined
        ? event.sourceTimestamp
        : timestamp,
    sourceKind: sourceOperationId === undefined ? ("workflow" as const) : ("pi_executor" as const),
    ...(sourceOperationId === undefined ? {} : { sourceOperationId }),
    ...(sourceSequence === undefined ? {} : { sourceSequence }),
  };
}

function phase(eventName: string): "started" | "completed" | "failed" {
  return eventName.endsWith(".started")
    ? "started"
    : eventName.endsWith(".completed")
      ? "completed"
      : "failed";
}

function sourceKey(event: TraceEventInput, identity: string): string {
  if (
    "piOperationId" in event &&
    event.piOperationId !== undefined &&
    "operationEventSequence" in event &&
    event.operationEventSequence !== undefined
  ) {
    return `pi:${event.piOperationId}:${String(event.operationEventSequence)}`;
  }
  return `workflow:${identity}`;
}

/** Debug Trace输入 -> Session Activity白名单；非会话诊断事件明确返回undefined。 */
export function runActivityFromTrace(
  event: TraceEventInput,
  timestamp: string,
): RunActivityEventInput | undefined {
  const base = common(event, timestamp);
  if (base === undefined) return undefined;
  switch (event.eventName) {
    case TRACE_EVENT_NAMES.piNodeStarted:
    case TRACE_EVENT_NAMES.piNodeCompleted:
    case TRACE_EVENT_NAMES.piNodeFailed:
      return {
        ...base,
        sourceKey: sourceKey(
          event,
          `${event.productRunId}:${event.attemptId}:agent:${event.nodeKind}:${event.eventName}`,
        ),
        activityType: "agent",
        phase: phase(event.eventName),
        nodeKind: event.nodeKind,
        ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
        ...(event.eventName === TRACE_EVENT_NAMES.piNodeFailed
          ? { errorCode: event.error.code }
          : {}),
      };
    case TRACE_EVENT_NAMES.providerRequestStarted:
    case TRACE_EVENT_NAMES.providerRequestCompleted:
    case TRACE_EVENT_NAMES.providerRequestFailed:
      return {
        ...base,
        sourceKey: sourceKey(
          event,
          `${event.productRunId}:${event.attemptId}:model:${String(event.providerRequestIndex ?? 1)}:${event.eventName}`,
        ),
        activityType: "model",
        phase: phase(event.eventName),
        nodeKind: event.nodeKind ?? "executor",
        provider: event.provider,
        model: event.model,
        ...(event.providerRequestIndex === undefined
          ? {}
          : { requestIndex: event.providerRequestIndex }),
        ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
        ...(event.eventName === TRACE_EVENT_NAMES.providerRequestCompleted
          ? { tokenUsage: event.tokenUsage }
          : {}),
        ...(event.eventName === TRACE_EVENT_NAMES.providerRequestFailed
          ? { errorCode: event.error.code }
          : {}),
      };
    case TRACE_EVENT_NAMES.piToolIntentPersisted:
      return {
        ...base,
        sourceKey: sourceKey(
          event,
          `${event.productRunId}:${event.attemptId}:tool:${event.toolCallId}:started`,
        ),
        activityType: "tool",
        phase: "started",
        nodeKind: "executor",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ...(event.inputDisplay === undefined ? {} : { inputDisplay: event.inputDisplay }),
        ...(event.inputDisplayTruncated === undefined
          ? {}
          : { inputDisplayTruncated: event.inputDisplayTruncated }),
      };
    case TRACE_EVENT_NAMES.piToolCompleted:
    case TRACE_EVENT_NAMES.piToolFailed:
    case TRACE_EVENT_NAMES.piToolBlocked:
    case TRACE_EVENT_NAMES.piToolOutcomeUnknown: {
      const toolPhase =
        event.eventName === TRACE_EVENT_NAMES.piToolCompleted
          ? "completed"
          : event.eventName === TRACE_EVENT_NAMES.piToolBlocked
            ? "blocked"
            : event.eventName === TRACE_EVENT_NAMES.piToolOutcomeUnknown
              ? "outcome_unknown"
              : "failed";
      return {
        ...base,
        sourceKey: sourceKey(
          event,
          `${event.productRunId}:${event.attemptId}:tool:${event.toolCallId}:${toolPhase}`,
        ),
        activityType: "tool",
        phase: toolPhase,
        nodeKind: "executor",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ...(!("resultDisplay" in event) || event.resultDisplay === undefined
          ? {}
          : { resultDisplay: event.resultDisplay }),
        ...(!("resultDisplayTruncated" in event) || event.resultDisplayTruncated === undefined
          ? {}
          : { resultDisplayTruncated: event.resultDisplayTruncated }),
        ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
        ...(event.eventName === TRACE_EVENT_NAMES.piToolFailed ||
        event.eventName === TRACE_EVENT_NAMES.piToolBlocked
          ? { errorCode: event.error.code }
          : event.eventName === TRACE_EVENT_NAMES.piToolOutcomeUnknown
            ? { errorCode: "pi.tool_outcome_unknown" }
            : {}),
      };
    }
    case TRACE_EVENT_NAMES.piMessageCompleted:
      return event.messageRole === "assistant" && event.visibleText !== undefined
        ? {
            ...base,
            sourceKey: sourceKey(
              event,
              `${event.productRunId}:${event.attemptId}:message:${String(event.messageIndex)}`,
            ),
            activityType: "assistant_message",
            text: event.visibleText,
            textTruncated: event.visibleTextTruncated ?? false,
          }
        : undefined;
    case TRACE_EVENT_NAMES.workflowMemoryNodeStarted:
      return {
        ...base,
        sourceKey: `workflow:${event.productRunId}:memory:${event.workflowNodeRunId}:started`,
        activityType: "tool",
        phase: "started",
        workflowNodeRunId: event.workflowNodeRunId,
        toolCallId: `memory-node:${event.workflowNodeRunId}`,
        toolName: event.nodeType === "memory.query" ? "memory_query" : "memory_write",
        inputDisplay: JSON.stringify({
          operation: event.nodeType,
          summary: event.publicSummary ?? "Memory节点已开始",
        }),
        inputDisplayTruncated: false,
      };
    case TRACE_EVENT_NAMES.workflowMemoryNodeCompleted:
    case TRACE_EVENT_NAMES.workflowMemoryNodeFailed:
    case TRACE_EVENT_NAMES.workflowMemoryNodeOutcomeUnknown: {
      const toolPhase =
        event.eventName === TRACE_EVENT_NAMES.workflowMemoryNodeCompleted
          ? "completed"
          : event.eventName === TRACE_EVENT_NAMES.workflowMemoryNodeOutcomeUnknown
            ? "outcome_unknown"
            : "failed";
      return {
        ...base,
        sourceKey: `workflow:${event.productRunId}:memory:${event.workflowNodeRunId}:${toolPhase}`,
        activityType: "tool",
        phase: toolPhase,
        workflowNodeRunId: event.workflowNodeRunId,
        toolCallId: `memory-node:${event.workflowNodeRunId}`,
        toolName: event.nodeType === "memory.query" ? "memory_query" : "memory_write",
        resultDisplay: event.publicSummary ?? `Memory节点结束：${event.outcomeCode}`,
        resultDisplayTruncated: false,
        ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
        ...(event.eventName === TRACE_EVENT_NAMES.workflowMemoryNodeCompleted
          ? {}
          : { errorCode: event.error.code }),
      };
    }
    default:
      return lifecycleFromTrace(event, base);
  }
}

function lifecycleFromTrace(
  event: TraceEventInput,
  base: ActivityCommon,
): RunActivityEventInput | undefined {
  type LifecycleInput = Extract<RunActivityEventInput, { activityType: "lifecycle" }>;
  const names = new Map<string, LifecycleInput["name"]>([
    [TRACE_EVENT_NAMES.piOperationAccepted, "operation.accepted"],
    [TRACE_EVENT_NAMES.piOperationStarted, "operation.started"],
    [TRACE_EVENT_NAMES.piOperationCompleted, "operation.completed"],
    [TRACE_EVENT_NAMES.piOperationFailed, "operation.failed"],
    [TRACE_EVENT_NAMES.piOperationOutcomeUnknown, "operation.outcome_unknown"],
    [TRACE_EVENT_NAMES.piSessionStarted, "session.started"],
    [TRACE_EVENT_NAMES.piSessionSettled, "session.settled"],
    [TRACE_EVENT_NAMES.piTurnStarted, "turn.started"],
    [TRACE_EVENT_NAMES.piTurnCompleted, "turn.completed"],
    [TRACE_EVENT_NAMES.piCompactionStarted, "compaction.started"],
    [TRACE_EVENT_NAMES.piCompactionCompleted, "compaction.completed"],
  ]);
  const name = names.get(event.eventName);
  if (name === undefined) return undefined;
  const failed = event.eventName === TRACE_EVENT_NAMES.piOperationFailed;
  const unknown = event.eventName === TRACE_EVENT_NAMES.piOperationOutcomeUnknown;
  return {
    ...base,
    sourceKey: sourceKey(
      event,
      `${base.productRunId}:${"attemptId" in event ? event.attemptId : "none"}:${event.eventName}`,
    ),
    activityType: "lifecycle",
    name,
    outcome: failed ? "failure" : unknown || name.endsWith(".started") ? "unknown" : "success",
    ...("turnIndex" in event && event.turnIndex !== undefined
      ? { turnIndex: event.turnIndex }
      : {}),
    ...("durationMs" in event && event.durationMs !== undefined
      ? { durationMs: event.durationMs }
      : {}),
    ...(failed || unknown
      ? { errorCode: "error" in event ? event.error.code : "pi.operation_failed" }
      : {}),
  };
}
