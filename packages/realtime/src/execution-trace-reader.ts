import {
  EXECUTION_TRACE_SCHEMA_VERSION,
  TRACE_EVENT_NAMES,
  executionTracePageSchema,
  type ExecutionTraceItem,
  type ExecutionTracePage,
  type ProductRunId,
  type TraceEvent,
} from "@chat/contracts";
import { readTraceEvents } from "./trace-reader.js";

export interface ExecutionTraceReaderOptions {
  readonly dir?: string;
}

function lifecycle(
  event: TraceEvent,
  sequence: number,
): Extract<ExecutionTraceItem, { type: "lifecycle" }> | undefined {
  const base = { sequence, timestamp: event.timestamp, type: "lifecycle" as const };
  switch (event.eventName) {
    case TRACE_EVENT_NAMES.piOperationStarted:
      return { ...base, name: "operation.started", outcome: "unknown" };
    case TRACE_EVENT_NAMES.piOperationCompleted:
      return {
        ...base,
        name: "operation.completed",
        outcome: "success",
        durationMs: event.durationMs,
      };
    case TRACE_EVENT_NAMES.piOperationFailed:
      return {
        ...base,
        name: "operation.failed",
        outcome: "failure",
        durationMs: event.durationMs,
        errorCode: event.error.code,
      };
    case TRACE_EVENT_NAMES.piOperationOutcomeUnknown:
      return {
        ...base,
        name: "operation.outcome_unknown",
        outcome: "unknown",
        durationMs: event.durationMs,
        errorCode: event.error.code,
      };
    case TRACE_EVENT_NAMES.piSessionStarted:
      return { ...base, name: "session.started", outcome: "unknown" };
    case TRACE_EVENT_NAMES.piSessionSettled:
      return { ...base, name: "session.settled", outcome: "success" };
    case TRACE_EVENT_NAMES.piTurnStarted:
      return {
        ...base,
        name: "turn.started",
        outcome: "unknown",
        turnIndex: event.turnIndex,
      };
    case TRACE_EVENT_NAMES.piTurnCompleted:
      return {
        ...base,
        name: "turn.completed",
        outcome: "success",
        turnIndex: event.turnIndex,
        durationMs: event.durationMs,
      };
    case TRACE_EVENT_NAMES.providerRequestStarted:
      return {
        ...base,
        name: "provider.started",
        outcome: "unknown",
        ...(event.providerRequestIndex !== undefined
          ? { providerRequestIndex: event.providerRequestIndex }
          : {}),
      };
    case TRACE_EVENT_NAMES.providerRequestCompleted:
      return {
        ...base,
        name: "provider.completed",
        outcome: "success",
        durationMs: event.durationMs,
        ...(event.providerRequestIndex !== undefined
          ? { providerRequestIndex: event.providerRequestIndex }
          : {}),
        promptTokens: event.tokenUsage.promptTokens,
        completionTokens: event.tokenUsage.completionTokens,
        totalTokens: event.tokenUsage.totalTokens,
      };
    case TRACE_EVENT_NAMES.providerRequestFailed:
      return {
        ...base,
        name: "provider.failed",
        outcome: "failure",
        durationMs: event.durationMs,
        errorCode: event.error.code,
        ...(event.providerRequestIndex !== undefined
          ? { providerRequestIndex: event.providerRequestIndex }
          : {}),
      };
    case TRACE_EVENT_NAMES.piCompactionStarted:
      return { ...base, name: "compaction.started", outcome: "unknown" };
    case TRACE_EVENT_NAMES.piCompactionCompleted:
      return { ...base, name: "compaction.completed", outcome: "success" };
    default:
      return undefined;
  }
}

function project(event: TraceEvent, sequence: number): ExecutionTraceItem | undefined {
  switch (event.eventName) {
    case TRACE_EVENT_NAMES.piMessageCompleted:
      return event.messageRole === "assistant" && event.visibleText !== undefined
        ? {
            sequence,
            timestamp: event.timestamp,
            type: "assistant_message",
            text: event.visibleText,
            textTruncated: event.visibleTextTruncated ?? false,
          }
        : undefined;
    case TRACE_EVENT_NAMES.piToolIntentPersisted:
      return {
        sequence,
        timestamp: event.timestamp,
        type: "tool_call",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.inputDisplay ?? "Legacy trace did not retain observable tool input.",
        inputTruncated: event.inputDisplayTruncated ?? false,
      };
    case TRACE_EVENT_NAMES.piToolCompleted:
      return {
        sequence,
        timestamp: event.timestamp,
        type: "tool_result",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        outcome: "success",
        output: event.resultDisplay ?? "Legacy trace did not retain observable tool output.",
        outputTruncated: event.resultDisplayTruncated ?? false,
        durationMs: event.durationMs,
      };
    case TRACE_EVENT_NAMES.piToolFailed:
      return {
        sequence,
        timestamp: event.timestamp,
        type: "tool_result",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        outcome: "failure",
        output: event.resultDisplay ?? "Legacy trace did not retain observable tool output.",
        outputTruncated: event.resultDisplayTruncated ?? false,
        durationMs: event.durationMs,
        errorCode: event.error.code,
      };
    case TRACE_EVENT_NAMES.piToolBlocked:
      return {
        sequence,
        timestamp: event.timestamp,
        type: "tool_result",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        outcome: "rejected",
        output: `Blocked: ${event.error.code}`,
        outputTruncated: false,
        errorCode: event.error.code,
      };
    case TRACE_EVENT_NAMES.piToolOutcomeUnknown:
      return {
        sequence,
        timestamp: event.timestamp,
        type: "tool_result",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        outcome: "unknown",
        output: "Tool outcome is unknown; reconciliation is required.",
        outputTruncated: false,
      };
    default:
      return lifecycle(event, sequence);
  }
}

/**
 * JSONL Trace -> 浏览器安全执行轨迹。cursor使用Run内原始Trace位置，因此即使
 * 中间事件没有公开投影，也能单调前进且不会在轮询中重复扫描。
 */
export function createExecutionTraceReader(options: ExecutionTraceReaderOptions = {}) {
  return {
    read(input: {
      readonly productRunId: ProductRunId;
      readonly afterSequence: number;
      readonly limit: number;
    }): ExecutionTracePage {
      const events = readTraceEvents({
        ...(options.dir !== undefined ? { dir: options.dir } : {}),
        productRunId: input.productRunId,
      });
      const items: ExecutionTraceItem[] = [];
      // 客户端给出的未来cursor不得回退，否则会把旧工具重复投影进DSH Session。
      let cursor = input.afterSequence;
      while (cursor < events.length && items.length < input.limit) {
        const sequence = cursor + 1;
        const item = project(events[cursor]!, sequence);
        cursor = sequence;
        if (item !== undefined) items.push(item);
      }
      return executionTracePageSchema.parse({
        schemaVersion: EXECUTION_TRACE_SCHEMA_VERSION,
        productRunId: input.productRunId,
        items,
        nextCursor: cursor,
        hasMore: cursor < events.length,
      });
    },
  };
}
