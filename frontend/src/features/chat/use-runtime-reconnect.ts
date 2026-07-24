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

/**
 * Reattaches React to the durable Runtime Journal without taking ownership of
 * Product Run state. Closing this effect only stops observation; the Worker
 * keeps running until a persisted terminal event or explicit cancel command.
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

    const reconnect = async () => {
      onStatus("running");
      onError(null);
      onConnectionStatus("reconnecting");
      while (!cancelled) {
        try {
          const response = await getRuntimeEvents(runtimeJob.id, cursor);
          if (cancelled) return;
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
                // A resumed Job may briefly replay the previous segment's
                // terminal interrupt. Only waiting_human is allowed to reopen it.
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
          if (message.includes("RUNTIME_CURSOR_EXPIRED") || message.includes("410")) {
            onConnectionStatus("cursor_expired");
            onSessionSettledRef.current(true);
            return;
          }
          onStatus("error");
          onConnectionStatus("idle");
          onError(message);
          return;
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
