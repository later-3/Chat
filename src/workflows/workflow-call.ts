import { randomUUID } from "node:crypto";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { getRun } from "workflow/api";
import type { ChatWorkflowHttpInput } from "../run-request.js";
import { reserveChatSession } from "../chat-session.js";
import { getChatWorkflowDefinition, type ChatWorkflowId } from "./registry.js";
import { startChatWorkflow } from "./start-chat-workflow.js";
import type { ChatWorkflowResult } from "./types.js";
import {
  forwardWorkflowCallProgress,
  type WorkflowCallProgressForwarder,
} from "./workflow-call-progress.js";
import {
  DEFAULT_CHAT_WORKFLOW_CALL_WAIT_TIMEOUT_MS,
  MAX_CHAT_WORKFLOW_CALL_WAIT_TIMEOUT_MS,
  type CallChatWorkflowInput,
  type ChatWorkflowCallCancelledResult,
  type ChatWorkflowCallCompletedResult,
  type ChatWorkflowCallResult,
  type ChatWorkflowCallRunningResult,
  type ChatWorkflowCallRuntime,
  type ControlChatWorkflowCallInput,
} from "./workflow-call-contract.js";
import {
  appendChatSubsessionRelation,
  appendChatWorkflowDelegationOrigin,
  appendChatWorkflowCall,
  collectChatSubsessionRelation,
  collectChatWorkflowCalls,
  type ChatWorkflowCall,
  type ChatWorkflowCallStatus,
} from "./workflow-call-state.js";
import { reserveChatWorkflowCallCapacity } from "./workflow-call-capacity.js";
import {
  describeChatWorkflowCapabilities,
  resolveWorkflowCallAgentConfigs,
} from "./workflow-call-capabilities.js";

export const MAX_CHAT_SUBWORKFLOW_DEPTH = 4;

export type {
  CallChatWorkflowInput,
  ChatWorkflowCallResult,
  ControlChatWorkflowCallInput,
} from "./workflow-call-contract.js";

const WAIT_TIMED_OUT = Symbol("workflow-call-wait-timed-out");

type CallBase = Omit<ChatWorkflowCall, "status" | "updatedAt">;

function appendState(
  manager: SessionManager,
  base: CallBase,
  status: ChatWorkflowCallStatus,
  runId?: string,
  timing?: { readonly finishedAt: string; readonly durationMs: number },
): void {
  appendChatWorkflowCall(manager, {
    ...base,
    child: {
      ...base.child,
      ...(runId === undefined ? {} : { runId }),
    },
    status,
    updatedAt: new Date().toISOString(),
    ...(timing === undefined ? {} : timing),
  });
  manager.flush();
}

function isTerminalStatus(status: ChatWorkflowCallStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function appendTerminalState(
  manager: SessionManager,
  base: CallBase,
  status: Extract<ChatWorkflowCallStatus, "completed" | "failed" | "cancelled">,
  runId: string | undefined,
  finishedAt: string,
): ChatWorkflowCall {
  const current = collectChatWorkflowCalls(manager.getEntries())
    .find((call) => call.callId === base.callId);
  if (current !== undefined && isTerminalStatus(current.status)) return current;
  appendState(manager, base, status, runId, {
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(base.startedAt)),
  });
  const appended = collectChatWorkflowCalls(manager.getEntries())
    .find((call) => call.callId === base.callId);
  if (appended === undefined) throw new Error(`Workflow调用状态写入失败: ${base.callId}`);
  return appended;
}

function callBase(call: ChatWorkflowCall): CallBase {
  return {
    schemaVersion: call.schemaVersion,
    callId: call.callId,
    toolCallId: call.toolCallId,
    parent: call.parent,
    child: call.child,
    startedAt: call.startedAt,
    ...(call.finishedAt === undefined ? {} : { finishedAt: call.finishedAt }),
    ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
  };
}

function normalizeWaitTimeout(waitTimeoutMs: number | undefined): number {
  const timeout = waitTimeoutMs ?? DEFAULT_CHAT_WORKFLOW_CALL_WAIT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 0
    || timeout > MAX_CHAT_WORKFLOW_CALL_WAIT_TIMEOUT_MS) {
    throw new Error(
      `Workflow等待超时必须是0到${String(MAX_CHAT_WORKFLOW_CALL_WAIT_TIMEOUT_MS)}毫秒的整数`,
    );
  }
  return timeout;
}

async function waitWithinWindow<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof WAIT_TIMED_OUT> {
  if (timeoutMs === 0) return WAIT_TIMED_OUT;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof WAIT_TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(WAIT_TIMED_OUT), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function requireOwnedCall(manager: SessionManager, callId: string): ChatWorkflowCall {
  if (callId.trim() === "") throw new Error("Workflow调用ID不能为空");
  const call = collectChatWorkflowCalls(manager.getEntries())
    .find((candidate) => candidate.callId === callId);
  if (call === undefined || call.parent.sessionId !== manager.getSessionId()) {
    throw new Error(`当前父Session不存在Workflow调用: ${callId}`);
  }
  return call;
}

function completedResult(
  call: ChatWorkflowCall,
  result: ChatWorkflowResult,
): ChatWorkflowCallCompletedResult {
  if (call.child.runId === undefined || call.finishedAt === undefined || call.durationMs === undefined) {
    throw new Error(`Workflow调用完成状态不完整: ${call.callId}`);
  }
  return {
    status: "completed",
    callId: call.callId,
    workflowId: call.child.workflowId,
    runId: call.child.runId,
    workflowInvocationId: call.child.workflowInvocationId,
    sessionId: call.child.sessionId,
    startedAt: call.startedAt,
    completedAt: call.finishedAt,
    durationMs: call.durationMs,
    text: result.text,
    model: result.model,
  };
}

function cancelledResult(call: ChatWorkflowCall): ChatWorkflowCallCancelledResult {
  if (call.child.runId === undefined || call.finishedAt === undefined || call.durationMs === undefined) {
    throw new Error(`Workflow调用取消状态不完整: ${call.callId}`);
  }
  return {
    status: "cancelled",
    callId: call.callId,
    workflowId: call.child.workflowId,
    runId: call.child.runId,
    workflowInvocationId: call.child.workflowInvocationId,
    sessionId: call.child.sessionId,
    startedAt: call.startedAt,
    cancelledAt: call.finishedAt,
    durationMs: call.durationMs,
  };
}

function runningResult(call: ChatWorkflowCall, waitTimeoutMs: number): ChatWorkflowCallRunningResult {
  if (call.child.runId === undefined) throw new Error(`Workflow调用尚未绑定Run: ${call.callId}`);
  const observedAt = new Date().toISOString();
  return {
    status: "running",
    callId: call.callId,
    workflowId: call.child.workflowId,
    runId: call.child.runId,
    workflowInvocationId: call.child.workflowInvocationId,
    sessionId: call.child.sessionId,
    startedAt: call.startedAt,
    observedAt,
    elapsedMs: Math.max(0, Date.parse(observedAt) - Date.parse(call.startedAt)),
    waitTimeoutMs,
  };
}

async function settleRun(
  manager: SessionManager,
  base: CallBase,
  runId: string,
): Promise<ChatWorkflowCallCompletedResult | ChatWorkflowCallCancelledResult> {
  const run = getRun<ChatWorkflowResult>(runId);
  try {
    const result = await run.returnValue;
    const terminal = appendTerminalState(manager, base, "completed", runId, new Date().toISOString());
    return completedResult(terminal, result);
  } catch (error) {
    const status = await run.status.catch(() => "failed");
    const terminal = appendTerminalState(
      manager,
      base,
      status === "cancelled" ? "cancelled" : "failed",
      runId,
      new Date().toISOString(),
    );
    if (terminal.status === "cancelled") return cancelledResult(terminal);
    throw error;
  }
}

function cancelOnParentAbort(
  signal: AbortSignal | undefined,
  cancel: () => Promise<void>,
): () => void {
  if (signal === undefined) return () => undefined;
  const onAbort = () => {
    void cancel().catch((error: unknown) => {
      console.error(
        `[workflow-call] parent cancellation failed error=${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  return () => signal.removeEventListener("abort", onAbort);
}

async function waitForSettlement(
  input: ControlChatWorkflowCallInput,
  call: ChatWorkflowCall,
): Promise<ChatWorkflowCallResult> {
  const waitTimeoutMs = normalizeWaitTimeout(input.waitTimeoutMs);
  if (call.status === "cancelled") return cancelledResult(call);
  if (call.status === "failed") throw new Error(`子Workflow调用已失败: ${call.callId}`);
  if (call.child.runId === undefined) throw new Error(`Workflow调用尚未绑定Run: ${call.callId}`);

  const run = getRun<ChatWorkflowResult>(call.child.runId);
  if (call.status === "completed") return completedResult(call, await run.returnValue);

  const updatedAt = new Date().toISOString();
  input.onProgress?.({
    callId: call.callId,
    workflowId: call.child.workflowId,
    workflowInvocationId: call.child.workflowInvocationId,
    sessionId: call.child.sessionId,
    runId: call.child.runId,
    status: "running",
    phase: "workflow_stage",
    startedAt: call.startedAt,
    updatedAt,
    elapsedMs: Math.max(0, Date.parse(updatedAt) - Date.parse(call.startedAt)),
  });
  const settlement = settleRun(input.parentSessionManager, callBase(call), call.child.runId);
  const removeAbortListener = cancelOnParentAbort(input.signal, () => run.cancel());
  void settlement.finally(removeAbortListener).catch(() => undefined);
  const result = await waitWithinWindow(settlement, waitTimeoutMs);
  return result === WAIT_TIMED_OUT
    ? runningResult(requireOwnedCall(input.parentSessionManager, call.callId), waitTimeoutMs)
    : result;
}

/**
 * Starts one registry-approved Workflow in its own Chat Subsession. The Tool
 * waits for one bounded window; a timeout returns a resumable running handle.
 */
export async function callChatWorkflow(
  input: CallChatWorkflowInput,
): Promise<ChatWorkflowCallResult> {
  const waitTimeoutMs = normalizeWaitTimeout(input.waitTimeoutMs);
  const target = getChatWorkflowDefinition(input.targetWorkflowId);
  if (target === undefined) throw new Error(`找不到目标Workflow: ${input.targetWorkflowId}`);
  if (!target.agentCallable) throw new Error(`Workflow不允许由Agent调用: ${target.id}`);
  if (input.prompt.trim() === "") throw new Error("子Workflow任务书不能为空");

  const parentRelation = collectChatSubsessionRelation(input.parentSessionManager.getEntries());
  const depth = (parentRelation?.depth ?? 0) + 1;
  if (depth > MAX_CHAT_SUBWORKFLOW_DEPTH) {
    throw new Error(`子Workflow调用深度不能超过${String(MAX_CHAT_SUBWORKFLOW_DEPTH)}`);
  }

  const callId = randomUUID();
  const workflowInvocationId = randomUUID();
  const startedAt = new Date().toISOString();
  input.onProgress?.({
    callId,
    workflowId: target.id,
    workflowInvocationId,
    status: "starting",
    phase: "reserving_session",
    startedAt,
    updatedAt: startedAt,
    elapsedMs: 0,
  });
  const releaseCapacity = reserveChatWorkflowCallCapacity(input.projectId, input.parentSessionManager);
  let agentConfigs: Awaited<ReturnType<typeof resolveWorkflowCallAgentConfigs>>;
  let childSession: Awaited<ReturnType<typeof reserveChatSession>>;
  try {
    agentConfigs = await resolveWorkflowCallAgentConfigs({
      projectId: input.projectId,
      chatHome: input.chatHome,
      cwd: input.cwd,
      targetWorkflowId: target.id,
    }, input.agents);
    childSession = await reserveChatSession({
      projectId: input.projectId,
      chatHome: input.chatHome,
      cwd: input.cwd,
    }, input.prompt, { parentSessionManager: input.parentSessionManager });
  } catch (error) {
    releaseCapacity();
    throw error;
  }
  const childSessionId = childSession.manager.getSessionId();
  const base: CallBase = {
    schemaVersion: 1,
    callId,
    toolCallId: input.toolCallId,
    parent: {
      sessionId: input.parentSessionManager.getSessionId(),
      workflowId: input.parentWorkflowId,
      workflowInvocationId: input.parentWorkflowInvocationId,
      stageId: input.parentStageId,
      agentId: input.parentAgentId,
    },
    child: {
      sessionId: childSessionId,
      workflowId: target.id,
      workflowInvocationId,
    },
    startedAt,
  };
  try {
    appendChatSubsessionRelation(childSession.manager, {
      callId,
      parentSessionId: input.parentSessionManager.getSessionId(),
      childSessionId,
      depth,
      createdAt: startedAt,
    });
    appendChatWorkflowDelegationOrigin(childSession.manager, {
      schemaVersion: 1,
      callId,
      source: base.parent,
      target: base.child,
    });
    childSession.manager.flush();
    const sessionReservedAt = new Date().toISOString();
    input.onProgress?.({
      callId,
      workflowId: target.id,
      workflowInvocationId,
      sessionId: childSessionId,
      status: "starting",
      phase: "starting_run",
      startedAt,
      updatedAt: sessionReservedAt,
      elapsedMs: Math.max(0, Date.parse(sessionReservedAt) - Date.parse(startedAt)),
    });
    appendState(input.parentSessionManager, base, "starting");
  } finally {
    releaseCapacity();
  }

  if (input.signal?.aborted) {
    appendTerminalState(input.parentSessionManager, base, "cancelled", undefined, new Date().toISOString());
    throw new DOMException("父Agent已取消子Workflow调用", "AbortError");
  }

  const workflowInput: ChatWorkflowHttpInput = {
    projectId: input.projectId,
    chatHome: input.chatHome,
    cwd: input.cwd,
    prompt: input.prompt,
    sessionId: childSessionId,
    workflow: target.id as ChatWorkflowId,
    agentConfigs,
    delegatedByAgentId: input.parentAgentId,
  };

  let progressForwarder: WorkflowCallProgressForwarder | undefined;
  try {
    const started = await startChatWorkflow(workflowInput, { workflowInvocationId });
    const runId = started.run.runId;
    appendState(input.parentSessionManager, base, "running", runId);
    const runningCall = requireOwnedCall(input.parentSessionManager, callId);
    const runStartedAt = new Date().toISOString();
    input.onProgress?.({
      callId,
      workflowId: target.id,
      workflowInvocationId,
      sessionId: childSessionId,
      runId,
      status: "running",
      phase: "workflow_stage",
      startedAt,
      updatedAt: runStartedAt,
      elapsedMs: Math.max(0, Date.parse(runStartedAt) - Date.parse(startedAt)),
    });
    if (input.onProgress !== undefined) {
      try {
        progressForwarder = forwardWorkflowCallProgress({
          readable: started.run.getReadable<string>({ startIndex: 0 }),
          base: {
            callId,
            workflowId: target.id,
            workflowInvocationId,
            sessionId: childSessionId,
            runId,
            startedAt,
          },
          onProgress: input.onProgress,
          onError: (error) => {
            console.error(
              `[workflow-call] progress stream failed callId=${callId} error=${error instanceof Error ? error.message : String(error)}`,
            );
          },
        });
      } catch (error) {
        console.error(
          `[workflow-call] progress stream unavailable callId=${callId} error=${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const settlement = settleRun(input.parentSessionManager, callBase(runningCall), runId);
    const removeAbortListener = cancelOnParentAbort(input.signal, () => started.run.cancel());
    void settlement.finally(removeAbortListener).catch(() => undefined);
    const result = await waitWithinWindow(settlement, waitTimeoutMs);
    return result === WAIT_TIMED_OUT
      ? runningResult(requireOwnedCall(input.parentSessionManager, callId), waitTimeoutMs)
      : result;
  } catch (error) {
    const current = requireOwnedCall(input.parentSessionManager, callId);
    if (!isTerminalStatus(current.status)) {
      appendTerminalState(
        input.parentSessionManager,
        base,
        input.signal?.aborted ? "cancelled" : "failed",
        current.child.runId,
        new Date().toISOString(),
      );
    }
    throw error;
  } finally {
    await progressForwarder?.stop();
  }
}

/** Waits for one existing child without creating another Session or Run. */
export async function waitForChatWorkflowCall(
  input: ControlChatWorkflowCallInput,
): Promise<ChatWorkflowCallResult> {
  return waitForSettlement(input, requireOwnedCall(input.parentSessionManager, input.callId));
}

/** Cancels one non-terminal child owned by the current parent Session. */
export async function cancelActiveChatWorkflowCall(
  input: ControlChatWorkflowCallInput,
): Promise<ChatWorkflowCallResult> {
  const call = requireOwnedCall(input.parentSessionManager, input.callId);
  if (call.status === "completed") {
    if (call.child.runId === undefined) throw new Error(`Workflow调用完成状态不完整: ${call.callId}`);
    return completedResult(call, await getRun<ChatWorkflowResult>(call.child.runId).returnValue);
  }
  if (call.status === "cancelled") return cancelledResult(call);
  if (call.status === "failed") throw new Error(`子Workflow调用已失败: ${call.callId}`);
  if (call.child.runId === undefined) throw new Error(`Workflow调用尚未绑定Run: ${call.callId}`);

  await getRun<ChatWorkflowResult>(call.child.runId).cancel();
  const terminal = appendTerminalState(
    input.parentSessionManager,
    callBase(call),
    "cancelled",
    call.child.runId,
    new Date().toISOString(),
  );
  return cancelledResult(terminal);
}

export const CHAT_WORKFLOW_CALL_RUNTIME: ChatWorkflowCallRuntime = {
  describe: describeChatWorkflowCapabilities,
  start: callChatWorkflow,
  wait: waitForChatWorkflowCall,
  cancel: cancelActiveChatWorkflowCall,
};
