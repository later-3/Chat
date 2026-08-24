import {
  EXECUTION_TRACE_SCHEMA_VERSION,
  executionTracePageSchema,
  type ExecutionTraceItem,
  type ExecutionTracePage,
  type ProductRunId,
  type RunActivityEvent,
} from "@chat/contracts";
import { createRunActivityReader, type RunActivityReader } from "./run-activity-journal.js";

export interface ExecutionTraceReaderOptions {
  readonly dir?: string;
  readonly reader?: RunActivityReader;
}

function project(event: RunActivityEvent): ExecutionTraceItem | undefined {
  if (event.activityType === "assistant_message") {
    return {
      sequence: event.sequence,
      timestamp: event.timestamp,
      type: "assistant_message",
      text: event.text,
      textTruncated: event.textTruncated,
    };
  }
  if (event.activityType === "tool") {
    if (event.phase === "started") {
      return {
        sequence: event.sequence,
        timestamp: event.timestamp,
        type: "tool_call",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ...(event.capability === undefined ? {} : { capability: event.capability }),
        input: event.inputDisplay ?? "工具输入只保留在原生 Agent Session 中",
        inputTruncated: event.inputDisplayTruncated ?? false,
      };
    }
    return {
      sequence: event.sequence,
      timestamp: event.timestamp,
      type: "tool_result",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      ...(event.capability === undefined ? {} : { capability: event.capability }),
      outcome:
        event.phase === "completed"
          ? "success"
          : event.phase === "blocked"
            ? "rejected"
            : event.phase === "outcome_unknown"
              ? "unknown"
              : "failure",
      output: event.resultDisplay ?? "工具结果只保留在原生 Agent Session 中",
      outputTruncated: event.resultDisplayTruncated ?? false,
      ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
    };
  }
  if (event.activityType === "model") {
    return {
      sequence: event.sequence,
      timestamp: event.timestamp,
      type: "lifecycle",
      name:
        event.phase === "started"
          ? "provider.started"
          : event.phase === "completed"
            ? "provider.completed"
            : "provider.failed",
      outcome:
        event.phase === "started" ? "unknown" : event.phase === "completed" ? "success" : "failure",
      ...(event.requestIndex === undefined ? {} : { providerRequestIndex: event.requestIndex }),
      ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      ...(event.tokenUsage === undefined
        ? {}
        : {
            promptTokens: event.tokenUsage.promptTokens,
            completionTokens: event.tokenUsage.completionTokens,
            totalTokens: event.tokenUsage.totalTokens,
          }),
      ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
    };
  }
  if (event.activityType !== "lifecycle") return undefined;
  if (
    event.name === "operation.accepted" ||
    event.name === "operation.cancelled" ||
    event.name === "session.resumed" ||
    event.name.startsWith("prompt_review.")
  ) {
    return undefined;
  }
  type PublicLifecycleName = Extract<ExecutionTraceItem, { type: "lifecycle" }>["name"];
  return {
    sequence: event.sequence,
    timestamp: event.timestamp,
    type: "lifecycle",
    name: event.name as PublicLifecycleName,
    outcome: event.outcome === "cancelled" ? "failure" : event.outcome,
    ...(event.turnIndex === undefined ? {} : { turnIndex: event.turnIndex }),
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
  };
}

/** Run Activity Journal -> 兼容的公开cursor页；Debug Trace不参与读取。 */
export function createExecutionTraceReader(options: ExecutionTraceReaderOptions = {}) {
  const reader =
    options.reader ??
    createRunActivityReader(options.dir === undefined ? {} : { dir: options.dir });
  return {
    async read(input: {
      readonly productRunId: ProductRunId;
      readonly afterSequence: number;
      readonly limit: number;
    }): Promise<ExecutionTracePage> {
      const events = await reader.read({ productRunId: input.productRunId });
      const items: ExecutionTraceItem[] = [];
      let cursor = input.afterSequence;
      while (cursor < events.length && items.length < input.limit) {
        const event = events[cursor];
        if (event === undefined || event.sequence !== cursor + 1) {
          throw new Error("Run Activity sequence不连续");
        }
        cursor = event.sequence;
        const item = project(event);
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
