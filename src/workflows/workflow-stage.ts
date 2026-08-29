import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

export const CHAT_WORKFLOW_STAGE_CUSTOM_TYPE = "chat.workflow_stage";
export const CHAT_WORKFLOW_STAGE_SCHEMA_VERSION = 1;
export const CHAT_WORKFLOW_MESSAGE_CUSTOM_TYPE = "chat.workflow_message";
export const CHAT_WORKFLOW_MESSAGE_SCHEMA_VERSION = 1;
export const CHAT_WORKFLOW_AGENT_INPUT_CUSTOM_TYPE = "chat.workflow_agent_input";
export const CHAT_WORKFLOW_AGENT_INPUT_SCHEMA_VERSION = 1;

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

export interface ChatWorkflowStageData {
  readonly schemaVersion: typeof CHAT_WORKFLOW_STAGE_SCHEMA_VERSION;
  readonly invocationId: string;
  readonly workflowId: string;
  readonly stageId: string;
  readonly agentId: string;
}

export interface ChatWorkflowStageMarker extends ChatWorkflowStageData {
  readonly entryId: string;
}

export interface ChatWorkflowMessageData {
  readonly schemaVersion: typeof CHAT_WORKFLOW_MESSAGE_SCHEMA_VERSION;
  readonly invocationId: string;
  readonly workflowId: string;
  readonly stageId: string;
  readonly agentId: string;
  readonly message: AssistantMessage;
}

export interface ChatWorkflowMessageMarker extends ChatWorkflowMessageData {
  readonly entryId: string;
}

export interface ChatWorkflowAgentInputData {
  readonly schemaVersion: typeof CHAT_WORKFLOW_AGENT_INPUT_SCHEMA_VERSION;
  readonly invocationId: string;
  readonly workflowId: string;
  readonly stageId: string;
  readonly agentId: string;
  readonly userPrompt: string;
  readonly upstream?: {
    readonly stageId: string;
    readonly agentId: string;
    readonly output: string;
  };
}

export interface ChatWorkflowAgentInputMarker extends ChatWorkflowAgentInputData {
  readonly entryId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  return isRecord(value)
    && value.role === "assistant"
    && Array.isArray(value.content)
    && typeof value.timestamp === "number";
}

/** Persists display-only Workflow provenance through Pi's native CustomEntry. */
export function appendChatWorkflowStage(
  sessionManager: SessionManager,
  data: Omit<ChatWorkflowStageData, "schemaVersion">,
): string {
  return sessionManager.appendCustomEntry(CHAT_WORKFLOW_STAGE_CUSTOM_TYPE, {
    schemaVersion: CHAT_WORKFLOW_STAGE_SCHEMA_VERSION,
    ...data,
  } satisfies ChatWorkflowStageData);
}

/** Persists one internal Agent response for Chat history without adding it to LLM context. */
export function appendChatWorkflowMessage(
  sessionManager: SessionManager,
  data: Omit<ChatWorkflowMessageData, "schemaVersion">,
): string {
  return sessionManager.appendCustomEntry(CHAT_WORKFLOW_MESSAGE_CUSTOM_TYPE, {
    schemaVersion: CHAT_WORKFLOW_MESSAGE_SCHEMA_VERSION,
    ...data,
    message: structuredClone(data.message),
  } satisfies ChatWorkflowMessageData);
}

/** Persists the exact upstream information supplied to one Agent Stage. */
export function appendChatWorkflowAgentInput(
  sessionManager: SessionManager,
  data: Omit<ChatWorkflowAgentInputData, "schemaVersion">,
): string {
  return sessionManager.appendCustomEntry(CHAT_WORKFLOW_AGENT_INPUT_CUSTOM_TYPE, {
    schemaVersion: CHAT_WORKFLOW_AGENT_INPUT_SCHEMA_VERSION,
    ...data,
  } satisfies ChatWorkflowAgentInputData);
}

/** Reads supported markers and ignores unrelated or future CustomEntry schemas. */
export function collectChatWorkflowStageMarkers(entries: readonly unknown[]): ChatWorkflowStageMarker[] {
  const markers: ChatWorkflowStageMarker[] = [];
  for (const entry of entries) {
    if (
      !isRecord(entry)
      || entry.type !== "custom"
      || entry.customType !== CHAT_WORKFLOW_STAGE_CUSTOM_TYPE
      || !isNonEmptyString(entry.id)
      || !isRecord(entry.data)
    ) {
      continue;
    }
    const data = entry.data;
    if (
      data.schemaVersion !== CHAT_WORKFLOW_STAGE_SCHEMA_VERSION
      || !isNonEmptyString(data.invocationId)
      || !isNonEmptyString(data.workflowId)
      || !isNonEmptyString(data.stageId)
      || !isNonEmptyString(data.agentId)
    ) {
      continue;
    }
    markers.push({
      entryId: entry.id,
      schemaVersion: CHAT_WORKFLOW_STAGE_SCHEMA_VERSION,
      invocationId: data.invocationId,
      workflowId: data.workflowId,
      stageId: data.stageId,
      agentId: data.agentId,
    });
  }
  return markers;
}

/** Finds every marker boundary, including schemas this Chat version cannot render. */
export function collectChatWorkflowStageEntryIds(entries: readonly unknown[]): string[] {
  return entries.flatMap((entry) => (
    isRecord(entry)
    && entry.type === "custom"
    && entry.customType === CHAT_WORKFLOW_STAGE_CUSTOM_TYPE
    && isNonEmptyString(entry.id)
      ? [entry.id]
      : []
  ));
}

/** Reads display-only internal Agent responses from supported CustomEntry schemas. */
export function collectChatWorkflowMessages(entries: readonly unknown[]): ChatWorkflowMessageMarker[] {
  const messages: ChatWorkflowMessageMarker[] = [];
  for (const entry of entries) {
    if (
      !isRecord(entry)
      || entry.type !== "custom"
      || entry.customType !== CHAT_WORKFLOW_MESSAGE_CUSTOM_TYPE
      || !isNonEmptyString(entry.id)
      || !isRecord(entry.data)
    ) {
      continue;
    }
    const data = entry.data;
    if (
      data.schemaVersion !== CHAT_WORKFLOW_MESSAGE_SCHEMA_VERSION
      || !isNonEmptyString(data.invocationId)
      || !isNonEmptyString(data.workflowId)
      || !isNonEmptyString(data.stageId)
      || !isNonEmptyString(data.agentId)
      || !isAssistantMessage(data.message)
    ) {
      continue;
    }
    messages.push({
      entryId: entry.id,
      schemaVersion: CHAT_WORKFLOW_MESSAGE_SCHEMA_VERSION,
      invocationId: data.invocationId,
      workflowId: data.workflowId,
      stageId: data.stageId,
      agentId: data.agentId,
      message: data.message,
    });
  }
  return messages;
}

/** Reads the persisted input chain for Agent Stages. */
export function collectChatWorkflowAgentInputs(entries: readonly unknown[]): ChatWorkflowAgentInputMarker[] {
  const inputs: ChatWorkflowAgentInputMarker[] = [];
  for (const entry of entries) {
    if (
      !isRecord(entry)
      || entry.type !== "custom"
      || entry.customType !== CHAT_WORKFLOW_AGENT_INPUT_CUSTOM_TYPE
      || !isNonEmptyString(entry.id)
      || !isRecord(entry.data)
    ) {
      continue;
    }
    const data = entry.data;
    if (
      data.schemaVersion !== CHAT_WORKFLOW_AGENT_INPUT_SCHEMA_VERSION
      || !isNonEmptyString(data.invocationId)
      || !isNonEmptyString(data.workflowId)
      || !isNonEmptyString(data.stageId)
      || !isNonEmptyString(data.agentId)
      || typeof data.userPrompt !== "string"
      || (
        data.upstream !== undefined
        && (
          !isRecord(data.upstream)
          || !isNonEmptyString(data.upstream.stageId)
          || !isNonEmptyString(data.upstream.agentId)
          || typeof data.upstream.output !== "string"
        )
      )
    ) {
      continue;
    }
    const upstream = data.upstream;
    inputs.push({
      entryId: entry.id,
      schemaVersion: CHAT_WORKFLOW_AGENT_INPUT_SCHEMA_VERSION,
      invocationId: data.invocationId,
      workflowId: data.workflowId,
      stageId: data.stageId,
      agentId: data.agentId,
      userPrompt: data.userPrompt,
      ...(upstream === undefined
        ? {}
        : {
            upstream: {
              stageId: upstream.stageId as string,
              agentId: upstream.agentId as string,
              output: upstream.output as string,
            },
          }),
    });
  }
  return inputs;
}
