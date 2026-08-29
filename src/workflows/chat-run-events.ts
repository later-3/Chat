import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { getWritable } from "workflow";
import { localTimestamp } from "../runtime-log.js";

export interface ChatRunStage {
  readonly workflowId: string;
  readonly stageId: string;
  readonly agentId: string;
}

export type ChatRunEvent =
  | { readonly type: "stage_start"; readonly stage: ChatRunStage }
  | {
      readonly type: "agent_event";
      readonly stage: ChatRunStage;
      readonly event: Readonly<Record<string, unknown>>;
    };

export interface ChatRunEventPublisher {
  readonly publishAgentEvent: (event: AgentSessionEvent) => void;
  readonly finish: (closeStream: boolean) => Promise<void>;
}

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
    partial !== null
    && contentIndex !== null
    && Array.isArray(partial.content)
    && (update.type === "toolcall_start" || update.type === "toolcall_delta")
  ) {
    const block = partial.content[contentIndex];
    if (isRecord(block)) {
      const id = typeof block.id === "string"
        ? block.id
        : (typeof block.toolCallId === "string" ? block.toolCallId : null);
      const toolName = typeof block.name === "string"
        ? block.name
        : (typeof block.toolName === "string" ? block.toolName : null);
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
export function projectAgentSessionEvent(
  event: AgentSessionEvent,
): Readonly<Record<string, unknown>> | null {
  switch (event.type) {
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

/** Publishes ordered NDJSON chunks through the Workflow run's durable stream. */
export function createChatRunEventPublisher(stage: ChatRunStage): ChatRunEventPublisher {
  let writer: WritableStreamDefaultWriter<string>;
  try {
    writer = getWritable<string>().getWriter();
  } catch {
    // Unit tests call Step functions directly, outside a Workflow runtime.
    return {
      publishAgentEvent: () => {},
      finish: async () => {},
    };
  }

  let failed = false;
  let pending = Promise.resolve();
  const publish = (event: ChatRunEvent) => {
    pending = pending
      .then(async () => {
        if (!failed) await writer.write(`${JSON.stringify(event)}\n`);
      })
      .catch((error: unknown) => {
        if (!failed) {
          failed = true;
          console.error(
            `${localTimestamp()} [workflow-stream] write failed error=${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
  };

  publish({ type: "stage_start", stage });
  return {
    publishAgentEvent: (event) => {
      const projected = projectAgentSessionEvent(event);
      if (projected !== null) publish({ type: "agent_event", stage, event: projected });
    },
    finish: async (closeStream) => {
      await pending;
      if (closeStream && !failed) {
        try {
          await writer.close();
        } catch (error) {
          console.error(
            `${localTimestamp()} [workflow-stream] close failed error=${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      writer.releaseLock();
    },
  };
}
