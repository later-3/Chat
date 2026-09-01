import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

export const CHAT_WORKFLOW_STAGE_CUSTOM_TYPE = "chat.workflow_stage";
export const CHAT_WORKFLOW_STAGE_SCHEMA_VERSION = 2;
export const CHAT_WORKFLOW_MESSAGE_CUSTOM_TYPE = "chat.workflow_message";
/** Legacy only: new Agent utterances are native Pi MessageEntry values. */
export const CHAT_WORKFLOW_MESSAGE_SCHEMA_VERSION = 1;
export const CHAT_WORKFLOW_AGENT_INPUT_CUSTOM_TYPE = "chat.workflow_agent_input";
export const CHAT_WORKFLOW_AGENT_INPUT_SCHEMA_VERSION = 2;

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
export type ChatWorkflowNodeKind = "agent" | "human" | "task" | "tool";

export interface ChatWorkflowStageData {
  readonly schemaVersion: typeof CHAT_WORKFLOW_STAGE_SCHEMA_VERSION;
  readonly invocationId: string;
  readonly workflowId: string;
  readonly stageId: string;
  readonly nodeKind: ChatWorkflowNodeKind;
  readonly agentId?: string;
}

export interface ChatWorkflowStageMarker extends ChatWorkflowStageData {
  readonly entryId: string;
}

/** Kept only so old Session files can be migrated and rendered during rollout. */
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
  /** Native MessageEntry IDs that form this Agent's persisted conversational input. */
  readonly inputEntryIds: readonly string[];
}

export interface LegacyChatWorkflowAgentInputData {
  readonly schemaVersion: 1;
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

export type ChatWorkflowAgentInputMarker = (
  | ChatWorkflowAgentInputData
  | LegacyChatWorkflowAgentInputData
) & { readonly entryId: string };

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

function isNodeKind(value: unknown): value is ChatWorkflowNodeKind {
  return value === "agent" || value === "human" || value === "task" || value === "tool";
}

/** Persists Workflow provenance without replacing any conversational message. */
export function appendChatWorkflowStage(
  sessionManager: SessionManager,
  data: Omit<ChatWorkflowStageData, "schemaVersion" | "nodeKind"> & {
    readonly nodeKind?: ChatWorkflowNodeKind;
  },
): string {
  const nodeKind = data.nodeKind ?? "agent";
  if (nodeKind === "agent" && !isNonEmptyString(data.agentId)) {
    throw new Error("Agent节点必须提供agentId");
  }
  return sessionManager.appendCustomEntry(CHAT_WORKFLOW_STAGE_CUSTOM_TYPE, {
    schemaVersion: CHAT_WORKFLOW_STAGE_SCHEMA_VERSION,
    ...data,
    nodeKind,
  } satisfies ChatWorkflowStageData);
}

/**
 * Persists references to the native Pi messages supplied to an Agent Stage.
 * The words themselves must live in MessageEntry values, never only here.
 */
export function appendChatWorkflowAgentInput(
  sessionManager: SessionManager,
  data: Omit<ChatWorkflowAgentInputData, "schemaVersion">,
): string {
  if (data.inputEntryIds.length === 0 || data.inputEntryIds.some((id) => !isNonEmptyString(id))) {
    throw new Error("Agent输入必须引用至少一条原生Session消息");
  }
  return sessionManager.appendCustomEntry(CHAT_WORKFLOW_AGENT_INPUT_CUSTOM_TYPE, {
    schemaVersion: CHAT_WORKFLOW_AGENT_INPUT_SCHEMA_VERSION,
    ...data,
    inputEntryIds: [...data.inputEntryIds],
  } satisfies ChatWorkflowAgentInputData);
}

/** Reads supported markers and upgrades v1 Agent-only markers in memory. */
export function collectChatWorkflowStageMarkers(entries: readonly unknown[]): ChatWorkflowStageMarker[] {
  const markers: ChatWorkflowStageMarker[] = [];
  for (const entry of entries) {
    if (
      !isRecord(entry)
      || entry.type !== "custom"
      || entry.customType !== CHAT_WORKFLOW_STAGE_CUSTOM_TYPE
      || !isNonEmptyString(entry.id)
      || !isRecord(entry.data)
    ) continue;
    const data = entry.data;
    if (
      (data.schemaVersion !== 1 && data.schemaVersion !== CHAT_WORKFLOW_STAGE_SCHEMA_VERSION)
      || !isNonEmptyString(data.invocationId)
      || !isNonEmptyString(data.workflowId)
      || !isNonEmptyString(data.stageId)
    ) continue;
    const nodeKind = data.schemaVersion === 1 ? "agent" : data.nodeKind;
    if (!isNodeKind(nodeKind)) continue;
    if (nodeKind === "agent" && !isNonEmptyString(data.agentId)) continue;
    markers.push({
      entryId: entry.id,
      schemaVersion: CHAT_WORKFLOW_STAGE_SCHEMA_VERSION,
      invocationId: data.invocationId,
      workflowId: data.workflowId,
      stageId: data.stageId,
      nodeKind,
      ...(isNonEmptyString(data.agentId) ? { agentId: data.agentId } : {}),
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

/** Reads legacy display-only Agent responses so they can be migrated/rendered. */
export function collectChatWorkflowMessages(entries: readonly unknown[]): ChatWorkflowMessageMarker[] {
  const messages: ChatWorkflowMessageMarker[] = [];
  for (const entry of entries) {
    if (
      !isRecord(entry)
      || entry.type !== "custom"
      || entry.customType !== CHAT_WORKFLOW_MESSAGE_CUSTOM_TYPE
      || !isNonEmptyString(entry.id)
      || !isRecord(entry.data)
    ) continue;
    const data = entry.data;
    if (
      data.schemaVersion !== CHAT_WORKFLOW_MESSAGE_SCHEMA_VERSION
      || !isNonEmptyString(data.invocationId)
      || !isNonEmptyString(data.workflowId)
      || !isNonEmptyString(data.stageId)
      || !isNonEmptyString(data.agentId)
      || !isAssistantMessage(data.message)
    ) continue;
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

/** Reads reference-only v2 inputs and legacy value-copying v1 inputs. */
export function collectChatWorkflowAgentInputs(entries: readonly unknown[]): ChatWorkflowAgentInputMarker[] {
  const inputs: ChatWorkflowAgentInputMarker[] = [];
  for (const entry of entries) {
    if (
      !isRecord(entry)
      || entry.type !== "custom"
      || entry.customType !== CHAT_WORKFLOW_AGENT_INPUT_CUSTOM_TYPE
      || !isNonEmptyString(entry.id)
      || !isRecord(entry.data)
    ) continue;
    const data = entry.data;
    const commonValid = isNonEmptyString(data.invocationId)
      && isNonEmptyString(data.workflowId)
      && isNonEmptyString(data.stageId)
      && isNonEmptyString(data.agentId);
    if (!commonValid) continue;
    if (
      data.schemaVersion === CHAT_WORKFLOW_AGENT_INPUT_SCHEMA_VERSION
      && Array.isArray(data.inputEntryIds)
      && data.inputEntryIds.length > 0
      && data.inputEntryIds.every(isNonEmptyString)
    ) {
      inputs.push({
        entryId: entry.id,
        schemaVersion: CHAT_WORKFLOW_AGENT_INPUT_SCHEMA_VERSION,
        invocationId: data.invocationId as string,
        workflowId: data.workflowId as string,
        stageId: data.stageId as string,
        agentId: data.agentId as string,
        inputEntryIds: [...data.inputEntryIds] as string[],
      });
      continue;
    }
    if (data.schemaVersion !== 1 || typeof data.userPrompt !== "string") continue;
    if (data.upstream !== undefined && (
      !isRecord(data.upstream)
      || !isNonEmptyString(data.upstream.stageId)
      || !isNonEmptyString(data.upstream.agentId)
      || typeof data.upstream.output !== "string"
    )) continue;
    inputs.push({
      entryId: entry.id,
      schemaVersion: 1,
      invocationId: data.invocationId as string,
      workflowId: data.workflowId as string,
      stageId: data.stageId as string,
      agentId: data.agentId as string,
      userPrompt: data.userPrompt,
      ...(data.upstream === undefined
        ? {}
        : {
            upstream: {
              stageId: data.upstream.stageId as string,
              agentId: data.upstream.agentId as string,
              output: data.upstream.output as string,
            },
          }),
    });
  }
  return inputs;
}
