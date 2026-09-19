import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageUpdateForBrowser(event: Extract<AgentSessionEvent, { type: "message_update" }>) {
  const update = structuredClone(event.assistantMessageEvent) as unknown;
  if (!isRecord(update)) return null;
  const partial = isRecord(update.partial) ? update.partial : null;
  const contentIndex = typeof update.contentIndex === "number" ? update.contentIndex : null;
  let metadata: { id: string; toolName: string } | undefined;
  if (
    partial !== null &&
    contentIndex !== null &&
    Array.isArray(partial.content) &&
    (update.type === "toolcall_start" || update.type === "toolcall_delta")
  ) {
    const block = partial.content[contentIndex];
    if (isRecord(block)) {
      const id =
        typeof block.id === "string" ? block.id : typeof block.toolCallId === "string" ? block.toolCallId : null;
      const toolName =
        typeof block.name === "string" ? block.name : typeof block.toolName === "string" ? block.toolName : null;
      if (id !== null && toolName !== null) metadata = { id, toolName };
    }
  }
  delete update.partial;
  return {
    type: "message_update",
    assistantMessageEvent: metadata === undefined ? update : { ...update, ...metadata },
  };
}

/** Keeps only the Pi event fields needed by the browser's existing renderer. */
export function projectAgentSessionEvent(event: AgentSessionEvent): Readonly<Record<string, unknown>> | null {
  switch (event.type) {
    case "turn_start":
    case "agent_start":
      return { type: event.type };
    case "agent_end":
      return { type: event.type, willRetry: event.willRetry };
    case "message_start":
    case "message_end":
      return { type: event.type, message: structuredClone(event.message) };
    case "message_update":
      return messageUpdateForBrowser(event);
    case "tool_execution_start":
      return {
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: structuredClone(event.args) as unknown,
      };
    case "tool_execution_update":
      return {
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        partialResult: structuredClone(event.partialResult) as unknown,
      };
    case "tool_execution_end":
      return {
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
      };
    case "auto_retry_start":
      return {
        type: event.type,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorMessage: event.errorMessage,
      };
    case "auto_retry_end":
      return {
        type: event.type,
        success: event.success,
        attempt: event.attempt,
        ...(event.finalError === undefined ? {} : { finalError: event.finalError }),
      };
    case "compaction_start":
      return { type: event.type, reason: event.reason };
    case "compaction_end":
      return {
        type: event.type,
        reason: event.reason,
        aborted: event.aborted,
        willRetry: event.willRetry,
        ...(event.errorMessage === undefined ? {} : { errorMessage: event.errorMessage }),
      };
    default:
      return null;
  }
}
