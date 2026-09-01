import type { SessionManager } from "@earendil-works/pi-coding-agent";

export const CHAT_TOOL_EXECUTION_CUSTOM_TYPE = "chat.tool_execution";
export const CHAT_TOOL_EXECUTION_SCHEMA_VERSION = 1;

export interface ChatToolExecutionData {
  readonly schemaVersion: typeof CHAT_TOOL_EXECUTION_SCHEMA_VERSION;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolAddress: string;
  readonly toolVersion?: string;
  readonly projectId?: string;
  readonly workflowId: string;
  readonly workflowInvocationId: string;
  readonly stageId: string;
  readonly agentId?: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: "completed" | "error";
}

export interface ChatToolExecutionRecord extends ChatToolExecutionData {
  readonly entryId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function appendChatToolExecution(
  sessionManager: SessionManager,
  data: Omit<ChatToolExecutionData, "schemaVersion">,
): string {
  return sessionManager.appendCustomEntry(CHAT_TOOL_EXECUTION_CUSTOM_TYPE, {
    schemaVersion: CHAT_TOOL_EXECUTION_SCHEMA_VERSION,
    ...data,
  } satisfies ChatToolExecutionData);
}

/** Reads complete Tool execution facts without adding them to the model context. */
export function collectChatToolExecutions(entries: readonly unknown[]): ChatToolExecutionRecord[] {
  const records: ChatToolExecutionRecord[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)
      || entry.type !== "custom"
      || entry.customType !== CHAT_TOOL_EXECUTION_CUSTOM_TYPE
      || !nonEmptyString(entry.id)
      || !isRecord(entry.data)) continue;
    const data = entry.data;
    if (data.schemaVersion !== CHAT_TOOL_EXECUTION_SCHEMA_VERSION
      || !nonEmptyString(data.toolCallId)
      || !nonEmptyString(data.toolName)
      || !nonEmptyString(data.toolAddress)
      || !nonEmptyString(data.workflowId)
      || !nonEmptyString(data.workflowInvocationId)
      || !nonEmptyString(data.stageId)
      || !nonEmptyString(data.startedAt)
      || !nonEmptyString(data.completedAt)
      || (data.status !== "completed" && data.status !== "error")) continue;
    records.push({
      entryId: entry.id,
      schemaVersion: CHAT_TOOL_EXECUTION_SCHEMA_VERSION,
      toolCallId: data.toolCallId,
      toolName: data.toolName,
      toolAddress: data.toolAddress,
      ...(nonEmptyString(data.toolVersion) ? { toolVersion: data.toolVersion } : {}),
      ...(nonEmptyString(data.projectId) ? { projectId: data.projectId } : {}),
      workflowId: data.workflowId,
      workflowInvocationId: data.workflowInvocationId,
      stageId: data.stageId,
      ...(nonEmptyString(data.agentId) ? { agentId: data.agentId } : {}),
      startedAt: data.startedAt,
      completedAt: data.completedAt,
      status: data.status,
    });
  }
  return records;
}
