import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { collectChatWorkflowCalls } from "./workflow-call-state.js";

export const MAX_ACTIVE_CHAT_WORKFLOW_CALLS_PER_PARENT = 8;

interface WorkflowCallCapacityState {
  readonly pendingStartsBySessionId: Map<string, number>;
}

const RUNTIME_KEY = Symbol.for("chat.workflow-call-capacity.v1");

function capacityState(): WorkflowCallCapacityState {
  const target = globalThis as typeof globalThis & { [RUNTIME_KEY]?: WorkflowCallCapacityState };
  target[RUNTIME_KEY] ??= { pendingStartsBySessionId: new Map() };
  return target[RUNTIME_KEY];
}

function activePersistedCallCount(manager: SessionManager): number {
  return collectChatWorkflowCalls(manager.getEntries())
    .filter((call) => call.status === "starting" || call.status === "running")
    .length;
}

/**
 * Reserves capacity synchronously before the first asynchronous start boundary.
 * The returned release function is idempotent and must run once the starting
 * state is durable or startup fails.
 */
export function reserveChatWorkflowCallCapacity(projectId: string, manager: SessionManager): () => void {
  const state = capacityState();
  const sessionId = manager.getSessionId();
  const capacityKey = `${projectId}\0${sessionId}`;
  const pending = state.pendingStartsBySessionId.get(capacityKey) ?? 0;
  const active = activePersistedCallCount(manager);
  if (active + pending >= MAX_ACTIVE_CHAT_WORKFLOW_CALLS_PER_PARENT) {
    throw new Error(
      `父Session同时运行的子Workflow不能超过${String(MAX_ACTIVE_CHAT_WORKFLOW_CALLS_PER_PARENT)}个`,
    );
  }
  state.pendingStartsBySessionId.set(capacityKey, pending + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = state.pendingStartsBySessionId.get(capacityKey) ?? 0;
    if (current <= 1) state.pendingStartsBySessionId.delete(capacityKey);
    else state.pendingStartsBySessionId.set(capacityKey, current - 1);
  };
}
