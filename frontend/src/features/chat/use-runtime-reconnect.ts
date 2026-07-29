/**
 * 活动Run重连Hook：把React重新挂到持久Runtime Journal上，不接管Product Run状态。
 *
 * 关闭本Hook只停止观察；Worker继续执行直到持久终态或显式取消命令。重放按游标进行，
 * Sequence/Hash校验缺口；Cursor过期（410）回退到Product水合而不是伪造连续。
 */
import type { HttpAgent } from "@ag-ui/client";
import type { Interrupt, Message } from "@ag-ui/core";
import { useEffect, useRef } from "react";

import { type RuntimeReplayState, replayRuntimeEvents } from "../../runtime-event-replay.js";
import { getRuntimeEvents, type RuntimeJob } from "../session/session-api.js";
import {
  type GovernedReviewCard,
  governedReviewFromInterrupt,
  type RunStatus,
  type RuntimeConnectionStatus,
} from "./chat-agent-contracts.js";

interface RuntimeReconnectOptions {
  agent: HttpAgent;
  sessionId: string | null;
  hydratedMessages: Message[];
  hydrationVersion: number;
  runtimeJob: RuntimeJob | null;
  onMessages: (messages: Message[]) => void;
  onStatus: (status: RunStatus) => void;
  onConnectionStatus: (status: RuntimeConnectionStatus) => void;
  onError: (message: string | null) => void;
  onPendingReview: (review: GovernedReviewCard | null) => void;
  onSessionSettled: (hydrateMessages: boolean) => void;
}

function cloneMessages(messages: ReadonlyArray<Readonly<Message>>): Message[] {
  return messages.map((message) => ({ ...message })) as Message[];
}

/** 重连退避：离线固定1秒，在线指数退避封顶5秒；不会取消服务端执行。 */
export function runtimeReconnectDelayMs(failureCount: number, browserOnline = true): number {
  if (!browserOnline) return 1_000;
  return Math.min(5_000, 400 * 2 ** Math.max(0, failureCount - 1));
}

function browserOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine;
}

/**
 * 把React重新挂到持久Runtime Journal，但不拥有Product Run状态。
 * 关闭本effect只停止观察；Worker继续运行直到持久终态或显式取消命令。
 */
export function useRuntimeReconnect({
  agent,
  sessionId,
  hydratedMessages,
  hydrationVersion,
  runtimeJob,
  onMessages,
  onStatus,
  onConnectionStatus,
  onError,
  onPendingReview,
  onSessionSettled,
}: RuntimeReconnectOptions): void {
  const onSessionSettledRef = useRef(onSessionSettled);

  useEffect(() => {
    onSessionSettledRef.current = onSessionSettled;
  }, [onSessionSettled]);

  useEffect(() => {
    if (!sessionId || !runtimeJob || agent.isRunning) return;
    if (
      !["queued", "leased", "running", "waiting_human", "waiting_recovery"].includes(
        runtimeJob.status,
      )
    ) {
      return;
    }
    let cancelled = false;
    const baseMessages = cloneMessages(hydratedMessages);
    let replay: RuntimeReplayState = {
      attemptId: runtimeJob.run_attempt_id,
      lastSequence: 0,
      hashes: new Map(),
      messages: baseMessages,
      lastTerminal: null,
    };
    let cursor: string | undefined;
    let reconnectFailures = 0;

    const reconnect = async () => {
      onStatus("running");
      onError(null);
      onConnectionStatus("reconnecting");
      while (!cancelled) {
        try {
          const response = await getRuntimeEvents(runtimeJob.id, cursor);
          if (cancelled) return;
          reconnectFailures = 0;
          onError(null);
          if (response.events.length > 0) {
            onConnectionStatus("replaying");
            replay = replayRuntimeEvents(replay, response.events);
            cursor = response.next_cursor;
            window.sessionStorage.setItem(`chat.runtime.cursor.${runtimeJob.id}`, cursor);
            agent.setMessages(cloneMessages(replay.messages));
            onMessages(cloneMessages(replay.messages));
          } else {
            onConnectionStatus("caught_up");
          }

          const terminal = replay.lastTerminal;
          if (terminal?.type === "RUN_FINISHED") {
            const outcome = terminal.outcome;
            if (outcome && typeof outcome === "object" && !Array.isArray(outcome)) {
              const typedOutcome = outcome as { type?: unknown; interrupts?: unknown };
              if (typedOutcome.type === "interrupt" && Array.isArray(typedOutcome.interrupts)) {
                // 恢复的Job可能短暂重放上一段的终态中断；只有waiting_human允许重新打开审批卡。
                if (response.job.status !== "waiting_human") {
                  await new Promise((resolve) => window.setTimeout(resolve, 180));
                  continue;
                }
                const interrupts = typedOutcome.interrupts as Interrupt[];
                agent.pendingInterrupts = structuredClone(interrupts);
                const card = interrupts.map(governedReviewFromInterrupt).find(Boolean) ?? null;
                if (card) {
                  onPendingReview(card);
                  onStatus("awaiting_approval");
                  onConnectionStatus("caught_up");
                  onSessionSettledRef.current(false);
                  return;
                }
              }
            }
            if (!["succeeded", "cancelled"].includes(response.job.status)) {
              await new Promise((resolve) => window.setTimeout(resolve, 180));
              continue;
            }
            onStatus("idle");
            onConnectionStatus("caught_up");
            onSessionSettledRef.current(true);
            return;
          }
          if (
            terminal?.type === "RUN_ERROR" ||
            ["failed", "cancelled", "outcome_unknown"].includes(response.job.status)
          ) {
            onStatus("error");
            onConnectionStatus("caught_up");
            onError(
              String(terminal?.message ?? response.job.failure_summary ?? "Runtime Run未完成"),
            );
            onSessionSettledRef.current(true);
            return;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 180));
        } catch (reconnectError) {
          if (cancelled) return;
          const message =
            reconnectError instanceof Error ? reconnectError.message : "Runtime重连失败";
          // Cursor被清理（410）：停止重放，回退到Product水合重建权威状态。
          if (message.includes("RUNTIME_CURSOR_EXPIRED") || message.includes("410")) {
            onConnectionStatus("cursor_expired");
            onSessionSettledRef.current(true);
            return;
          }
          reconnectFailures += 1;
          onConnectionStatus("reconnecting");
          if (reconnectFailures >= 2) {
            onError(
              browserOnline()
                ? "活动Run连接暂时中断，正在重试；这不会取消服务端执行。"
                : "设备当前离线，活动Run仍由服务端继续；联网后将自动补齐事件。",
            );
          }
          await new Promise((resolve) =>
            window.setTimeout(resolve, runtimeReconnectDelayMs(reconnectFailures, browserOnline())),
          );
        }
      }
    };

    void reconnect();
    return () => {
      cancelled = true;
    };
  }, [
    agent,
    hydratedMessages,
    hydrationVersion,
    onConnectionStatus,
    onError,
    onMessages,
    onPendingReview,
    onStatus,
    runtimeJob?.id,
    runtimeJob?.run_attempt_id,
    runtimeJob?.status,
    sessionId,
  ]);
}
