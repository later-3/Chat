import { resolveProjectContext } from "../projects/registry.js";
import { dirname } from "node:path";
import {
  SessionManager,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { MAX_ACTIVE_CHAT_WORKFLOW_CALLS_PER_PARENT } from "./workflow-call-capacity.js";
import {
  collectChatWorkflowCalls,
  type ChatWorkflowCall,
  type ChatWorkflowCallStatus,
} from "./workflow-call-state.js";

import { findActiveSessionFile } from "../session-files.js";
export interface ChatWorkflowCallCounts {
  readonly total: number;
  readonly active: number;
  readonly starting: number;
  readonly running: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly totalDurationMs: number;
}

export interface ChatWorkflowCallStatistics {
  readonly capacity: {
    readonly active: number;
    readonly limit: number;
  };
  readonly direct: ChatWorkflowCallCounts;
  readonly tree: ChatWorkflowCallCounts & {
    readonly subsessionCount: number;
    readonly maxDepth: number;
  };
}

export interface ChatWorkflowCallTreeNode {
  readonly depth: number;
  readonly parentCallId?: string;
  readonly call: ChatWorkflowCall;
}

export interface ChatWorkflowCallProjection {
  readonly workflowCallStatistics: ChatWorkflowCallStatistics;
  readonly workflowCallTree: readonly ChatWorkflowCallTreeNode[];
}

function emptyCounts(): ChatWorkflowCallCounts {
  return {
    total: 0,
    active: 0,
    starting: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    totalDurationMs: 0,
  };
}

function addCall(counts: ChatWorkflowCallCounts, call: ChatWorkflowCall): ChatWorkflowCallCounts {
  const status = call.status as ChatWorkflowCallStatus;
  return {
    ...counts,
    total: counts.total + 1,
    active: counts.active + (status === "starting" || status === "running" ? 1 : 0),
    [status]: counts[status] + 1,
    totalDurationMs: counts.totalDurationMs + (call.durationMs ?? 0),
  };
}

/** Projects one root and all reachable child Sessions from persisted call edges. */
export function projectChatWorkflowCallTree(
  rootSessionId: string,
  callsBySessionId: ReadonlyMap<string, readonly ChatWorkflowCall[]>,
): ChatWorkflowCallProjection {
  let direct = emptyCounts();
  let tree = emptyCounts();
  let maxDepth = 0;
  const subsessionIds = new Set<string>();
  const visited = new Set<string>();
  const workflowCallTree: ChatWorkflowCallTreeNode[] = [];

  const visit = (sessionId: string, depth: number, parentCallId?: string): void => {
    if (visited.has(sessionId)) return;
    visited.add(sessionId);
    for (const call of callsBySessionId.get(sessionId) ?? []) {
      const callDepth = depth + 1;
      workflowCallTree.push({
        depth: callDepth,
        ...(parentCallId === undefined ? {} : { parentCallId }),
        call,
      });
      if (depth === 0) direct = addCall(direct, call);
      tree = addCall(tree, call);
      maxDepth = Math.max(maxDepth, callDepth);
      if (call.child.sessionId !== rootSessionId) subsessionIds.add(call.child.sessionId);
      visit(call.child.sessionId, callDepth, call.callId);
    }
  };
  visit(rootSessionId, 0);

  return {
    workflowCallStatistics: {
      capacity: {
        active: direct.active,
        limit: MAX_ACTIVE_CHAT_WORKFLOW_CALLS_PER_PARENT,
      },
      direct,
      tree: {
        ...tree,
        subsessionCount: subsessionIds.size,
        maxDepth,
      },
    },
    workflowCallTree,
  };
}

/** Aggregates Workflow calls without exposing their tree nodes. */
export function summarizeChatWorkflowCallTree(
  rootSessionId: string,
  callsBySessionId: ReadonlyMap<string, readonly ChatWorkflowCall[]>,
): ChatWorkflowCallStatistics {
  return projectChatWorkflowCallTree(rootSessionId, callsBySessionId).workflowCallStatistics;
}

/** Loads only Sessions reachable from the requested root; removed descendants remain ID evidence. */
export async function collectChatWorkflowCallProjection(input: {
  readonly rootSessionId: string;
  readonly rootEntries: readonly SessionEntry[];
  readonly sessionDir: string;
  readonly chatHome?: string;
}): Promise<ChatWorkflowCallProjection> {
  const rootCalls = collectChatWorkflowCalls(input.rootEntries);
  // No delegated call in the root Session means there is no tree to walk. Pi's listAll reads every
  // Session body, so the empty case must not pay for it (opening a session is the hot path).
  if (rootCalls.length === 0) return projectChatWorkflowCallTree(input.rootSessionId, new Map([[input.rootSessionId, rootCalls]]));
  // With calls, ONLY the reachable children are resolved — and each by the identity the call recorded,
  // never by scanning a directory: a Session that once delegated would otherwise read every unrelated
  // Session body on every open, in its own project and in the child's.
  const paths = new Map<string, string>();
  const resolveChild = async (sessionId: string, projectId: string | undefined): Promise<string | undefined> => {
    const key = `${projectId ?? ""}:${sessionId}`;
    const cached = paths.get(key);
    if (cached !== undefined) return cached;
    const project = projectId === undefined || input.chatHome === undefined
      ? { sessionDir: input.sessionDir }
      : await resolveProjectContext(projectId, input.chatHome);
    const info = await findActiveSessionFile(project, sessionId);
    if (info === undefined) return undefined;
    paths.set(key, info.path);
    return info.path;
  };
  const callsBySessionId = new Map<string, readonly ChatWorkflowCall[]>([[input.rootSessionId, rootCalls]]);
  const queue: { readonly sessionId: string; readonly projectId: string | undefined }[] = [{ sessionId: input.rootSessionId, projectId: undefined }];
  const visited = new Set<string>();
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current === undefined) continue;
    const key = `${current.projectId ?? ""}:${current.sessionId}`;
    if (visited.has(key)) continue;
    visited.add(key);
    let calls = callsBySessionId.get(current.sessionId);
    if (calls === undefined) {
      const path = await resolveChild(current.sessionId, current.projectId);
      if (path === undefined) continue;
      calls = collectChatWorkflowCalls(SessionManager.open(path, dirname(path)).getEntries());
      callsBySessionId.set(current.sessionId, calls);
    }
    for (const call of calls) queue.push({ sessionId: call.child.sessionId, projectId: call.child.projectId });
  }
  return projectChatWorkflowCallTree(input.rootSessionId, callsBySessionId);
}

/** Loads only Sessions reachable from the requested root and returns aggregate counts. */
export async function collectChatWorkflowCallStatistics(input: {
  readonly rootSessionId: string;
  readonly rootEntries: readonly SessionEntry[];
  readonly sessionDir: string;
  readonly chatHome?: string;
}): Promise<ChatWorkflowCallStatistics> {
  return (await collectChatWorkflowCallProjection(input)).workflowCallStatistics;
}
