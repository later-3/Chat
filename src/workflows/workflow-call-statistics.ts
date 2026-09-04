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
}): Promise<ChatWorkflowCallProjection> {
  const infos = await SessionManager.listAll(input.sessionDir);
  const infoById = new Map(infos.map((info) => [info.id, info]));
  const callsBySessionId = new Map<string, readonly ChatWorkflowCall[]>([
    [input.rootSessionId, collectChatWorkflowCalls(input.rootEntries)],
  ]);
  const visited = new Set<string>();
  const queue = [input.rootSessionId];
  for (let index = 0; index < queue.length; index += 1) {
    const sessionId = queue[index];
    if (sessionId === undefined || visited.has(sessionId)) continue;
    visited.add(sessionId);
    let calls = callsBySessionId.get(sessionId);
    if (calls === undefined) {
      const info = infoById.get(sessionId);
      if (info === undefined) continue;
      calls = collectChatWorkflowCalls(
        SessionManager.open(info.path, dirname(info.path)).getEntries(),
      );
      callsBySessionId.set(sessionId, calls);
    }
    for (const call of calls) queue.push(call.child.sessionId);
  }
  return projectChatWorkflowCallTree(input.rootSessionId, callsBySessionId);
}

/** Loads only Sessions reachable from the requested root and returns aggregate counts. */
export async function collectChatWorkflowCallStatistics(input: {
  readonly rootSessionId: string;
  readonly rootEntries: readonly SessionEntry[];
  readonly sessionDir: string;
}): Promise<ChatWorkflowCallStatistics> {
  return (await collectChatWorkflowCallProjection(input)).workflowCallStatistics;
}
