import { dirname, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export const CHAT_WORKFLOW_CALL_CUSTOM_TYPE = "chat.workflow_call";
export const CHAT_SESSION_RELATION_CUSTOM_TYPE = "chat.session_relation";
export const CHAT_WORKFLOW_DELEGATION_ORIGIN_CUSTOM_TYPE = "chat.workflow_delegation_origin";
export const CHAT_WORKFLOW_CALL_SCHEMA_VERSION = 1;

export type ChatWorkflowCallStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface ChatWorkflowCallEndpoint {
  readonly sessionId: string;
  readonly workflowId: string;
  readonly workflowInvocationId: string;
}

export interface ChatWorkflowCallParent extends ChatWorkflowCallEndpoint {
  readonly stageId: string;
  readonly agentId: string;
}

export interface ChatWorkflowCallChild extends ChatWorkflowCallEndpoint {
  readonly runId?: string;
}

export interface ChatWorkflowCall {
  readonly schemaVersion: typeof CHAT_WORKFLOW_CALL_SCHEMA_VERSION;
  readonly callId: string;
  readonly toolCallId: string;
  readonly parent: ChatWorkflowCallParent;
  readonly child: ChatWorkflowCallChild;
  readonly status: ChatWorkflowCallStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly finishedAt?: string;
  readonly durationMs?: number;
}

export interface ChatSubsessionRelation {
  readonly schemaVersion: typeof CHAT_WORKFLOW_CALL_SCHEMA_VERSION;
  readonly relation: "subsession";
  readonly callId: string;
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly depth: number;
  readonly createdAt: string;
}

/**
 * Chat-only authorship for the first native User message of a delegated
 * Workflow invocation. The task text remains solely in Pi's MessageEntry.
 */
export interface ChatWorkflowDelegationOrigin {
  readonly schemaVersion: typeof CHAT_WORKFLOW_CALL_SCHEMA_VERSION;
  readonly callId: string;
  readonly source: ChatWorkflowCallParent;
  readonly target: ChatWorkflowCallEndpoint;
}

type NewChatSubsessionRelation = Omit<ChatSubsessionRelation, "schemaVersion" | "relation">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function parseEndpoint(value: unknown): ChatWorkflowCallEndpoint | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.sessionId)
    || !isNonEmptyString(value.workflowId) || !isNonEmptyString(value.workflowInvocationId)) {
    return undefined;
  }
  return {
    sessionId: value.sessionId,
    workflowId: value.workflowId,
    workflowInvocationId: value.workflowInvocationId,
  };
}

function parseWorkflowCall(value: unknown): ChatWorkflowCall | undefined {
  if (!isRecord(value) || value.schemaVersion !== CHAT_WORKFLOW_CALL_SCHEMA_VERSION
    || !isNonEmptyString(value.callId) || !isNonEmptyString(value.toolCallId)
    || !isNonEmptyString(value.startedAt) || !isNonEmptyString(value.updatedAt)) {
    return undefined;
  }
  const statuses = new Set<ChatWorkflowCallStatus>([
    "starting", "running", "completed", "failed", "cancelled",
  ]);
  if (!statuses.has(value.status as ChatWorkflowCallStatus)) return undefined;
  const hasFinishedAt = value.finishedAt !== undefined;
  const hasDuration = value.durationMs !== undefined;
  if (hasFinishedAt !== hasDuration
    || (hasFinishedAt && !isNonEmptyString(value.finishedAt))
    || (hasDuration && (!Number.isSafeInteger(value.durationMs) || (value.durationMs as number) < 0))) {
    return undefined;
  }
  const parentEndpoint = parseEndpoint(value.parent);
  const childEndpoint = parseEndpoint(value.child);
  if (parentEndpoint === undefined || childEndpoint === undefined
    || !isRecord(value.parent) || !isNonEmptyString(value.parent.stageId)
    || !isNonEmptyString(value.parent.agentId) || !isRecord(value.child)
    || (value.child.runId !== undefined && !isNonEmptyString(value.child.runId))) {
    return undefined;
  }
  return {
    schemaVersion: CHAT_WORKFLOW_CALL_SCHEMA_VERSION,
    callId: value.callId,
    toolCallId: value.toolCallId,
    parent: {
      ...parentEndpoint,
      stageId: value.parent.stageId,
      agentId: value.parent.agentId,
    },
    child: {
      ...childEndpoint,
      ...(value.child.runId === undefined ? {} : { runId: value.child.runId }),
    },
    status: value.status as ChatWorkflowCallStatus,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    ...(hasFinishedAt ? { finishedAt: value.finishedAt as string } : {}),
    ...(hasDuration ? { durationMs: value.durationMs as number } : {}),
  };
}

function parseSubsessionRelation(value: unknown): ChatSubsessionRelation | undefined {
  if (!isRecord(value) || value.schemaVersion !== CHAT_WORKFLOW_CALL_SCHEMA_VERSION
    || value.relation !== "subsession" || !isNonEmptyString(value.callId)
    || !isNonEmptyString(value.parentSessionId) || !isNonEmptyString(value.childSessionId)
    || !Number.isSafeInteger(value.depth) || (value.depth as number) < 1
    || !isNonEmptyString(value.createdAt)) {
    return undefined;
  }
  return {
    schemaVersion: CHAT_WORKFLOW_CALL_SCHEMA_VERSION,
    relation: "subsession",
    callId: value.callId,
    parentSessionId: value.parentSessionId,
    childSessionId: value.childSessionId,
    depth: value.depth as number,
    createdAt: value.createdAt,
  };
}

function parseWorkflowDelegationOrigin(value: unknown): ChatWorkflowDelegationOrigin | undefined {
  if (!isRecord(value) || value.schemaVersion !== CHAT_WORKFLOW_CALL_SCHEMA_VERSION
    || !isNonEmptyString(value.callId) || !isRecord(value.source)) {
    return undefined;
  }
  const sourceEndpoint = parseEndpoint(value.source);
  const targetEndpoint = parseEndpoint(value.target);
  if (sourceEndpoint === undefined || targetEndpoint === undefined
    || !isNonEmptyString(value.source.stageId) || !isNonEmptyString(value.source.agentId)) {
    return undefined;
  }
  return {
    schemaVersion: CHAT_WORKFLOW_CALL_SCHEMA_VERSION,
    callId: value.callId,
    source: {
      ...sourceEndpoint,
      stageId: value.source.stageId,
      agentId: value.source.agentId,
    },
    target: targetEndpoint,
  };
}

/** Appends one state transition without duplicating task or result prose. */
export function appendChatWorkflowCall(
  sessionManager: SessionManager,
  call: ChatWorkflowCall,
): string {
  const parsed = parseWorkflowCall(call);
  if (parsed === undefined) throw new Error("Workflow Call状态无效");
  return sessionManager.appendCustomEntry(CHAT_WORKFLOW_CALL_CUSTOM_TYPE, parsed);
}

/** Returns the latest valid state for each call in first-call order. */
export function collectChatWorkflowCalls(entries: readonly unknown[]): ChatWorkflowCall[] {
  const calls = new Map<string, ChatWorkflowCall>();
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom"
      || entry.customType !== CHAT_WORKFLOW_CALL_CUSTOM_TYPE || !isRecord(entry.data)) continue;
    const call = parseWorkflowCall(entry.data);
    if (call !== undefined) calls.set(call.callId, call);
  }
  return [...calls.values()];
}

export function appendChatSubsessionRelation(
  sessionManager: SessionManager,
  relation: NewChatSubsessionRelation,
): string {
  const parsed = parseSubsessionRelation({
    schemaVersion: CHAT_WORKFLOW_CALL_SCHEMA_VERSION,
    relation: "subsession",
    ...relation,
  });
  if (parsed === undefined) throw new Error("Subsession关系无效");
  return sessionManager.appendCustomEntry(CHAT_SESSION_RELATION_CUSTOM_TYPE, parsed);
}

export function collectChatSubsessionRelation(
  entries: readonly unknown[],
): ChatSubsessionRelation | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "custom"
      || entry.customType !== CHAT_SESSION_RELATION_CUSTOM_TYPE || !isRecord(entry.data)) continue;
    const relation = parseSubsessionRelation(entry.data);
    if (relation !== undefined) return relation;
  }
  return undefined;
}

/** Persists Agent authorship without changing the native User message role. */
export function appendChatWorkflowDelegationOrigin(
  sessionManager: SessionManager,
  origin: ChatWorkflowDelegationOrigin,
): string {
  const parsed = parseWorkflowDelegationOrigin(origin);
  if (parsed === undefined) throw new Error("Workflow委派来源无效");
  return sessionManager.appendCustomEntry(CHAT_WORKFLOW_DELEGATION_ORIGIN_CUSTOM_TYPE, parsed);
}

/** Returns every valid delegation origin in Session order. */
export function collectChatWorkflowDelegationOrigins(
  entries: readonly unknown[],
): ChatWorkflowDelegationOrigin[] {
  const origins: ChatWorkflowDelegationOrigin[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom"
      || entry.customType !== CHAT_WORKFLOW_DELEGATION_ORIGIN_CUSTOM_TYPE || !isRecord(entry.data)) continue;
    const origin = parseWorkflowDelegationOrigin(entry.data);
    if (origin !== undefined) origins.push(origin);
  }
  return origins;
}

/**
 * Reads current metadata first, then reconstructs pre-schema origins from the
 * Pi parent Session and the already-persisted callId. It never rewrites either
 * Session and never uses task text as an identity key.
 */
export async function resolveChatWorkflowDelegationOrigins(
  childSessionManager: SessionManager,
): Promise<ChatWorkflowDelegationOrigin[]> {
  const ownOrigins = collectChatWorkflowDelegationOrigins(childSessionManager.getEntries());
  if (ownOrigins.length > 0) return ownOrigins;

  const relation = collectChatSubsessionRelation(childSessionManager.getEntries());
  if (relation === undefined || relation.childSessionId !== childSessionManager.getSessionId()) {
    return [];
  }

  try {
    const sessionDir = childSessionManager.getSessionDir();
    const nativeParentSessionFile = childSessionManager.getHeader()?.parentSession;
    const parentSessionFile = nativeParentSessionFile !== undefined
      && resolve(dirname(nativeParentSessionFile)) === resolve(sessionDir)
      ? nativeParentSessionFile
      : (await SessionManager.listAll(sessionDir))
        .find((session) => session.id === relation.parentSessionId)?.path;
    if (parentSessionFile === undefined) return [];
    const parent = SessionManager.open(parentSessionFile, childSessionManager.getSessionDir());
    if (parent.getSessionId() !== relation.parentSessionId) return [];
    const call = collectChatWorkflowCalls(parent.getEntries()).find((candidate) => (
      candidate.callId === relation.callId
      && candidate.parent.sessionId === relation.parentSessionId
      && candidate.child.sessionId === relation.childSessionId
    ));
    if (call === undefined) return [];
    return [{
      schemaVersion: CHAT_WORKFLOW_CALL_SCHEMA_VERSION,
      callId: call.callId,
      source: call.parent,
      target: {
        sessionId: call.child.sessionId,
        workflowId: call.child.workflowId,
        workflowInvocationId: call.child.workflowInvocationId,
      },
    }];
  } catch {
    return [];
  }
}
