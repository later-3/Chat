import type { SessionManager } from "@earendil-works/pi-coding-agent";

export const CHAT_LONG_AGENT_TURN_CUSTOM_TYPE = "chat.long_agent_turn";
export const CHAT_LONG_AGENT_TURN_SCHEMA_VERSION = 2;

export type ChatLongAgentTurnStatus = "running" | "completed" | "failed";
export type ChatLongAgentTurnSource = "chat-web" | "channel" | "scheduled";

export interface ChatLongAgentTurnAgentGroupContext {
  readonly contextRevision: string;
  readonly agentGroupId: string;
  readonly agentGroupRevision: string;
  readonly indexRevision: string;
  readonly definitionRevision: string;
  readonly stale: boolean;
  readonly fetchedAt: string;
}

export interface ChatLongAgentTurnData {
  readonly schemaVersion: typeof CHAT_LONG_AGENT_TURN_SCHEMA_VERSION;
  readonly turnId: string;
  readonly longAgentId: string;
  readonly bindingId: string;
  readonly source: ChatLongAgentTurnSource;
  readonly channelType: string | null;
  readonly inboundEventId: string | null;
  readonly agentGroupContext: ChatLongAgentTurnAgentGroupContext | null;
  readonly status: ChatLongAgentTurnStatus;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly error: string | null;
}

export interface ChatLongAgentTurnMarker extends ChatLongAgentTurnData {
  readonly entryId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function nullableNonEmpty(value: unknown): value is string | null {
  return value === null || nonEmpty(value);
}

function isStatus(value: unknown): value is ChatLongAgentTurnStatus {
  return value === "running" || value === "completed" || value === "failed";
}

function isSource(value: unknown): value is ChatLongAgentTurnSource {
  return value === "chat-web" || value === "channel" || value === "scheduled";
}

function parseAgentGroupContext(value: unknown): ChatLongAgentTurnAgentGroupContext | undefined {
  if (!isRecord(value)
    || !/^sha256:[a-f0-9]{64}$/.test(typeof value.contextRevision === "string" ? value.contextRevision : "")
    || !nonEmpty(value.agentGroupId)
    || !/^sha256:[a-f0-9]{64}$/.test(typeof value.agentGroupRevision === "string" ? value.agentGroupRevision : "")
    || !/^sha256:[a-f0-9]{64}$/.test(typeof value.indexRevision === "string" ? value.indexRevision : "")
    || !/^sha256:[a-f0-9]{64}$/.test(typeof value.definitionRevision === "string" ? value.definitionRevision : "")
    || typeof value.stale !== "boolean"
    || !nonEmpty(value.fetchedAt)
    || Number.isNaN(Date.parse(value.fetchedAt))) return undefined;
  return {
    contextRevision: value.contextRevision as string,
    agentGroupId: value.agentGroupId,
    agentGroupRevision: value.agentGroupRevision as string,
    indexRevision: value.indexRevision as string,
    definitionRevision: value.definitionRevision as string,
    stale: value.stale,
    fetchedAt: value.fetchedAt,
  };
}

function parseTurnData(value: unknown): ChatLongAgentTurnData | undefined {
  if (!isRecord(value)
    || (value.schemaVersion !== 1 && value.schemaVersion !== CHAT_LONG_AGENT_TURN_SCHEMA_VERSION)
    || !nonEmpty(value.turnId)
    || !nonEmpty(value.longAgentId)
    || !nonEmpty(value.bindingId)
    || !isSource(value.source)
    || !nullableNonEmpty(value.channelType)
    || !nullableNonEmpty(value.inboundEventId)
    || !isStatus(value.status)
    || !nonEmpty(value.startedAt)
    || Number.isNaN(Date.parse(value.startedAt))
    || !nullableNonEmpty(value.completedAt)
    || !nullableNonEmpty(value.error)) {
    return undefined;
  }
  if (value.status === "running" && (value.completedAt !== null || value.error !== null)) return undefined;
  if (value.status !== "running" && (value.completedAt === null || Number.isNaN(Date.parse(value.completedAt)))) {
    return undefined;
  }
  if (value.status === "completed" && value.error !== null) return undefined;
  if (value.status === "failed" && value.error === null) return undefined;
  const agentGroupContext = value.schemaVersion === 1
    ? null
    : parseAgentGroupContext(value.agentGroupContext);
  if (value.schemaVersion === CHAT_LONG_AGENT_TURN_SCHEMA_VERSION && agentGroupContext === undefined) return undefined;
  return {
    schemaVersion: CHAT_LONG_AGENT_TURN_SCHEMA_VERSION,
    turnId: value.turnId,
    longAgentId: value.longAgentId,
    bindingId: value.bindingId,
    source: value.source,
    channelType: value.channelType,
    inboundEventId: value.inboundEventId,
    agentGroupContext: agentGroupContext ?? null,
    status: value.status,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    error: value.error,
  };
}

export function appendChatLongAgentTurn(
  sessionManager: SessionManager,
  data: Omit<ChatLongAgentTurnData, "schemaVersion">,
): string {
  const parsed = parseTurnData({ schemaVersion: CHAT_LONG_AGENT_TURN_SCHEMA_VERSION, ...data });
  if (parsed === undefined) throw new Error("Long Agent Turn记录无效");
  return sessionManager.appendCustomEntry(CHAT_LONG_AGENT_TURN_CUSTOM_TYPE, parsed);
}

export function collectChatLongAgentTurnMarkers(entries: readonly unknown[]): ChatLongAgentTurnMarker[] {
  const markers: ChatLongAgentTurnMarker[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)
      || entry.type !== "custom"
      || entry.customType !== CHAT_LONG_AGENT_TURN_CUSTOM_TYPE
      || !nonEmpty(entry.id)) continue;
    const data = parseTurnData(entry.data);
    if (data !== undefined) markers.push({ entryId: entry.id, ...data });
  }
  return markers;
}

export function latestChatLongAgentTurn(
  entries: readonly unknown[],
  turnId: string,
): ChatLongAgentTurnMarker | undefined {
  return collectChatLongAgentTurnMarkers(entries).findLast((marker) => marker.turnId === turnId);
}

/**
 * Finds the last native Pi message from which a failed Long Agent attempt can
 * be resumed without appending the same user message again. A tool result is
 * preferred over the original user message so already-completed tool calls are
 * not repeated merely because the following model call failed.
 */
export function findChatLongAgentTurnResumeEntryId(
  entries: readonly unknown[],
  startEntryId: string,
  endEntryId: string,
): string | undefined {
  const start = entries.findIndex((entry) => (
    isRecord(entry) && entry.id === startEntryId
  ));
  const end = entries.findIndex((entry) => (
    isRecord(entry) && entry.id === endEntryId
  ));
  if (start < 0 || end <= start) return undefined;

  for (let index = end - 1; index > start; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry)
      || entry.type !== "message"
      || !isRecord(entry.message)
      || (entry.message.role !== "user" && entry.message.role !== "toolResult")
      || !nonEmpty(entry.id)) continue;
    return entry.id;
  }

  // A retry marker is appended as a child of the persisted resume message.
  // On a second failure that message therefore sits immediately before (and
  // outside) this attempt's marker range; follow the marker's parent so any
  // number of transient retries still share the same native user message.
  const startEntry = entries[start];
  if (!isRecord(startEntry) || !nonEmpty(startEntry.parentId)) return undefined;
  const parent = entries.find((entry) => isRecord(entry) && entry.id === startEntry.parentId);
  if (!isRecord(parent)
    || parent.type !== "message"
    || !isRecord(parent.message)
    || (parent.message.role !== "user" && parent.message.role !== "toolResult")
    || !nonEmpty(parent.id)) return undefined;
  return parent.id;
}
