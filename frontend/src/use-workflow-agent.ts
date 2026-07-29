/**
 * Frontend driver for a user-selected Workflow (incl. the continuous-collaboration
 * main Workflow).
 *
 * Chain owned by this hook:
 *   chat input -> run() appends a user message and calls HttpAgent.runAgent()
 *     -> POST to the Workflow's AG-UI endpoint (see workflow-api.ts)
 *     -> backend durable endpoint enqueues a Runtime Job and streams SSE back
 *   ActivitySnapshot events -> progress projection (workflow-progress.ts)
 *   RunFinished(interrupt) -> governedReviewFromInterrupt -> pendingReview
 *   approve()/revise()/abandon()/decideProduct() -> runAgent({resume:[...]})
 *
 * HttpAgent is the single owner of the message projection; product review
 * data (draft edits, product facts) is fetched/changed through REST. This hook
 * never holds authoritative state -- it only projects AG-UI + REST onto React.
 */
import { HttpAgent } from "@ag-ui/client";
import type { Message } from "@ag-ui/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiErrorFromResponse } from "./api-client.js";
import { createClientId } from "./client-id.js";
import { apiUrl } from "./runtime-config";
import {
  type GovernedReviewCard,
  governedReviewFromInterrupt,
  type ModelCallReviewCard,
} from "./use-chat-agent";
import type { ProductTraceEvent, WorkflowDefinition } from "./workflow-api";
import { workflowEndpointUrl } from "./workflow-api";
import {
  applyExecutorActivity,
  emptyWorkflowProgress,
  progressFromTrace,
  type WorkflowProgress,
} from "./workflow-progress";

export type WorkflowRunStatus =
  | "idle"
  | "running"
  | "awaiting_approval"
  | "saving"
  | "succeeded"
  | "failed";

function cloneMessages(messages: ReadonlyArray<Readonly<Message>>): Message[] {
  return messages.map((message) => ({ ...message })) as Message[];
}

interface UseWorkflowAgentOptions {
  definition: WorkflowDefinition;
  sessionId: string | null;
  hydratedMessages: Message[];
  hydrationVersion: number;
  restoredTrace: ProductTraceEvent[];
  onSessionSettled: (hydrateMessages: boolean) => void;
  onRunningChange: (running: boolean) => void;
}

export function useWorkflowAgent({
  definition,
  sessionId,
  hydratedMessages,
  hydrationVersion,
  restoredTrace,
  onSessionSettled,
  onRunningChange,
}: UseWorkflowAgentOptions) {
  // One HttpAgent per selected Workflow definition. The threadId is the
  // server-owned Product Session id once a session is open; before that it is
  // an ephemeral client id (see createThreadId in use-chat-agent).
  const [agent] = useState(
    () =>
      new HttpAgent({
        url: workflowEndpointUrl(definition.endpoint),
        threadId: createClientId(),
        description: definition.description,
      }),
  );
  const [status, setStatus] = useState<WorkflowRunStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<WorkflowProgress>(() =>
    emptyWorkflowProgress(definition),
  );
  const [runId, setRunId] = useState<string | null>(null);
  const [pendingReview, setPendingReview] = useState<GovernedReviewCard | null>(null);
  const messagesBeforeRun = useRef<Message[] | null>(null);
  const inputBeforeRun = useRef("");
  const sequence = useRef(0);
  const hydratedSessionId = useRef<string | null>(null);
  const mounted = useRef(true);
  const settledRef = useRef(onSessionSettled);
  const runningChangeRef = useRef(onRunningChange);

  useEffect(() => {
    settledRef.current = onSessionSettled;
    runningChangeRef.current = onRunningChange;
  }, [onRunningChange, onSessionSettled]);

  useEffect(() => {
    if (!sessionId || agent.isRunning) return;
    const sessionChanged = hydratedSessionId.current !== sessionId;
    hydratedSessionId.current = sessionId;
    agent.threadId = sessionId;
    agent.setMessages(cloneMessages(hydratedMessages));
    agent.setState({});
    agent.pendingInterrupts = [];
    if (sessionChanged) {
      setStatus("idle");
      setError(null);
      setRunId(null);
      setPendingReview(null);
    }
  }, [agent, hydrationVersion, sessionId]);

  useEffect(() => {
    if (agent.isRunning) return;
    sequence.current = restoredTrace.reduce((max, event) => Math.max(max, event.sequence), 0);
    setProgress(progressFromTrace(definition, restoredTrace));
  }, [agent, definition, restoredTrace]);

  useEffect(() => {
    mounted.current = true;
    const subscription = agent.subscribe({
      onRunStartedEvent({ event }) {
        if (!mounted.current) return;
        setRunId(event.runId);
        setStatus("running");
        setError(null);
        runningChangeRef.current(true);
      },
      onActivitySnapshotEvent({ event }) {
        if (!mounted.current || event.activityType !== "executor") return;
        sequence.current += 1;
        const content =
          event.content && typeof event.content === "object"
            ? (event.content as Record<string, unknown>)
            : {};
        setProgress((value) => applyExecutorActivity(value, content, sequence.current));
      },
      onRunFinishedEvent(result) {
        if (!mounted.current) return;
        if (result.outcome === "interrupt") {
          const card = result.interrupts.map(governedReviewFromInterrupt).find(Boolean) ?? null;
          if (card) {
            setPendingReview(card);
            setStatus("awaiting_approval");
            settledRef.current(false);
            return;
          }
          setStatus("failed");
          setError("收到无法识别的Workflow中断");
          runningChangeRef.current(false);
        } else {
          setPendingReview(null);
          setStatus("succeeded");
          runningChangeRef.current(false);
          settledRef.current(true);
        }
      },
      onRunErrorEvent({ event }) {
        if (!mounted.current) return;
        setStatus("failed");
        setError(event.message);
        runningChangeRef.current(false);
        settledRef.current(true);
      },
      onRunFailed({ error: runError }) {
        if (!mounted.current) return;
        setStatus("failed");
        setError(runError.message || "Workflow连接失败");
        runningChangeRef.current(false);
        settledRef.current(true);
      },
    });
    return () => {
      mounted.current = false;
      subscription.unsubscribe();
      agent.abortRun();
      runningChangeRef.current(false);
    };
  }, [agent]);

  /** Append the user prompt and start one AG-UI run on the selected Workflow. */
  const run = useCallback(
    async (input: string) => {
      const text = input.trim();
      if (!text || !sessionId) return;
      sequence.current = 0;
      messagesBeforeRun.current = cloneMessages(agent.messages);
      inputBeforeRun.current = text;
      setProgress(emptyWorkflowProgress(definition));
      setStatus("running");
      setError(null);
      runningChangeRef.current(true);
      try {
        agent.addMessage({ id: createClientId(), role: "user", content: text });
        await agent.runAgent();
      } catch (runError) {
        if (!mounted.current) return;
        setStatus("failed");
        setError(runError instanceof Error ? runError.message : "Workflow连接失败");
        runningChangeRef.current(false);
      }
    },
    [agent, definition, sessionId],
  );

  /** Resume after a model-call approval: send 'approve' and keep dispatching. */
  const approve = useCallback(
    async (argumentsValue?: Record<string, unknown>) => {
      if (!pendingReview || agent.isRunning) return;
      const approvalId = pendingReview.approval_id;
      setPendingReview(null);
      setStatus("running");
      setError(null);
      try {
        await agent.runAgent({
          resume: [
            {
              interruptId: approvalId,
              status: "resolved",
              payload: {
                decision: "approve",
                ...(pendingReview.review_kind === "tool_execution"
                  ? { arguments: argumentsValue ?? pendingReview.arguments }
                  : {}),
              },
            },
          ],
        });
      } catch (runError) {
        if (!mounted.current) return;
        setStatus("failed");
        setError(runError instanceof Error ? runError.message : "Agent模型调用失败");
        runningChangeRef.current(false);
        settledRef.current(true);
      }
    },
    [agent, pendingReview],
  );

  /** Revise a model-call draft: PUT a new revision via REST, then resume with it. */
  const revise = useCallback(
    async (providerId: string, providerRequest: Record<string, unknown>) => {
      if (
        !pendingReview ||
        pendingReview.review_kind === "tool_execution" ||
        pendingReview.review_kind === "product_decision" ||
        agent.isRunning
      )
        return;
      let recoverable = pendingReview;
      setStatus("saving");
      setError(null);
      try {
        const response = await fetch(apiUrl(`/api/model-call-drafts/${pendingReview.draft_id}`), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expected_hash: pendingReview.binding_hash,
            provider_id: providerId,
            provider_request: providerRequest,
          }),
        });
        if (!response.ok) {
          throw await apiErrorFromResponse(response, `保存修改失败：HTTP ${response.status}`);
        }
        const revised = (await response.json()) as ModelCallReviewCard;
        recoverable = revised;
        const approvalId = pendingReview.approval_id;
        setPendingReview(null);
        setStatus("running");
        await agent.runAgent({
          resume: [
            {
              interruptId: approvalId,
              status: "resolved",
              payload: { decision: "revise", revision_draft_id: revised.draft_id },
            },
          ],
        });
      } catch (revisionFailure) {
        if (!mounted.current) return;
        setPendingReview(recoverable);
        setStatus("awaiting_approval");
        setError(revisionFailure instanceof Error ? revisionFailure.message : "保存修改失败");
      }
    },
    [agent, pendingReview],
  );

  /** Abandon the pending model call: zero Provider sends, restore the prompt. */
  const abandon = useCallback(async (): Promise<string | null> => {
    if (!pendingReview || agent.isRunning) return null;
    const prompt =
      pendingReview.review_kind === "tool_execution" ||
      pendingReview.review_kind === "product_decision"
        ? inputBeforeRun.current
        : pendingReview.origin_prompt;
    const approvalId = pendingReview.approval_id;
    setPendingReview(null);
    setStatus("running");
    setError(null);
    try {
      await agent.runAgent({
        resume: [{ interruptId: approvalId, status: "resolved", payload: { decision: "abandon" } }],
      });
      if (messagesBeforeRun.current) agent.setMessages(messagesBeforeRun.current);
      setStatus("idle");
      runningChangeRef.current(false);
      settledRef.current(true);
      return prompt;
    } catch (runError) {
      if (!mounted.current) return null;
      setStatus("failed");
      setError(runError instanceof Error ? runError.message : "放弃Workflow失败");
      runningChangeRef.current(false);
      settledRef.current(true);
      return null;
    }
  }, [agent, pendingReview]);

  /** Submit a product-decision (accept/revise/skip/cancel) for a HITL interrupt. */
  const decideProduct = useCallback(
    async (decision: string, changes?: Record<string, unknown>) => {
      if (!pendingReview || pendingReview.review_kind !== "product_decision" || agent.isRunning)
        return;
      const review = pendingReview;
      setPendingReview(null);
      setStatus("running");
      setError(null);
      try {
        await agent.runAgent({
          resume: [
            {
              interruptId: review.approval_id,
              status: "resolved",
              payload: { decision, ...(changes ? { changes } : {}) },
            },
          ],
        });
      } catch (runError) {
        if (!mounted.current) return;
        setPendingReview(review);
        setStatus("awaiting_approval");
        setError(runError instanceof Error ? runError.message : "提交人工决定失败");
      }
    },
    [agent, pendingReview],
  );

  return {
    status,
    error,
    progress,
    runId,
    pendingReview,
    run,
    approve,
    revise,
    abandon,
    decideProduct,
  };
}
