import { HttpAgent } from "@ag-ui/client";
import type { Interrupt, Message } from "@ag-ui/core";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  cancelSessionRun,
  getRuntimeEvents,
  sessionControlForwardedProps,
  type ProductRun,
  type RuntimeJob,
  type SessionRunControl,
} from "./session-api.js";
import {
  replayRuntimeEvents,
  type RuntimeReplayState,
} from "./runtime-event-replay.js";

const DEFAULT_AGENT_URL = "http://127.0.0.1:8030/api/agent";
const DEFAULT_API_BASE_URL = "http://127.0.0.1:8030";

export interface ChatWorkflowDispatch {
  endpointUrl: string;
  workflowId: string;
  workflowVersion: string;
}

export type RunStatus = "idle" | "running" | "awaiting_approval" | "saving" | "error";
export type RuntimeConnectionStatus = "idle" | "reconnecting" | "replaying" | "caught_up" | "cursor_expired";

export interface DispatchRecovery {
  draftId: string;
  status: "failed" | "outcome_unknown";
  errorCode: string | null;
  message: string;
  originPrompt: string;
}

export interface EffectiveContextView {
  instructions: unknown;
  messages: unknown[];
  history_and_knowledge: ContextSourceView[];
  knowledge_sources: unknown[];
  tools: unknown[];
  model_parameters: Record<string, unknown>;
  continuation: Record<string, unknown> | null;
  token_estimate: number;
  token_breakdown: {
    instructions: number;
    messages: number[];
    tools: number;
    parameters: number;
    total: number;
    method: string;
    exact: boolean;
  };
  model_capabilities: ModelCapabilities;
  adoption_reasons: Record<string, string>;
}

export interface ContextSourceView {
  input_index: number;
  source_type: string;
  source_label: string;
  adoption_reason: string;
  modified_in_review: boolean;
  token_estimate: number;
  content: unknown;
}

export interface ParameterCapability {
  key: string;
  label: string;
  value_type: "boolean" | "integer" | "number" | "enum" | "object_enum";
  default: unknown;
  choices: string[];
  minimum: number | null;
  maximum: number | null;
  child_key: string | null;
  locked: boolean;
}

export interface ModelCapabilities {
  roles: string[];
  content_types_by_role: Record<string, string[]>;
  parameters: ParameterCapability[];
  token_estimator: string;
  allow_unknown_parameters: boolean;
}

export interface ModelOption {
  id: string;
  label: string;
  capabilities: ModelCapabilities;
}

export interface ModelProviderOption {
  id: string;
  label: string;
  protocol: "openai_responses" | "openai_chat_completions";
  models: ModelOption[];
}

export interface ModelCallReviewCard {
  review_kind?: "model_call";
  message: string;
  draft_id: string;
  approval_id: string;
  thread_id: string;
  run_id: string;
  version: number;
  origin_prompt: string;
  binding_hash: string;
  body_sha256: string;
  provider_id: string;
  provider_protocol: "openai_responses" | "openai_chat_completions";
  status: string;
  execution_context: {
    workflow_id?: string;
    agent_id?: string;
    agent_name?: string;
    agent_revision?: number;
    call_position?: number;
    total_calls?: number;
    executor_id?: string;
    tool_id?: string;
    tool_name?: string;
    config_revision?: number;
    allowed_tool_names?: string[];
  };
  provider_catalog: ModelProviderOption[];
  effective_context: EffectiveContextView;
  provider_request: Record<string, unknown>;
  attempt?: {
    attempt_id: string;
    status: string;
    error_code: string | null;
  } | null;
}

export interface ToolExecutionReviewCard {
  review_kind: "tool_execution";
  message: string;
  approval_id: string;
  tool_call_id: string;
  tool_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  working_directory: string;
  risk: string;
  config_revision: number;
  execution_context: {
    workflow_id: string;
    executor_id: string;
    tool_id: string;
    wait_reason: string;
  };
}

export interface ProductDecisionEditableField {
  key: string;
  label: string;
  type: "text" | "text_optional" | "long_text" | "boolean" | "select" | "multi_select" | "execution_draft";
  value: unknown;
  options?: Array<{ value: string; label: string }>;
}

export interface ProductDecisionReviewCard {
  review_kind: "product_decision";
  message: string;
  approval_id: string;
  decision_request_id: string;
  decision_point_key: string;
  title: string;
  reason_summary: string;
  request_hash: string;
  row_version: number;
  subject_hash: string;
  subject_resource_id?: string;
  subject: unknown;
  facts: Record<string, unknown>;
  policy: {
    final_action: string;
    matched_rules: unknown[];
    reason_codes: string[];
  };
  allowed_actions: string[];
  editable_fields: ProductDecisionEditableField[];
  execution_context: {
    workflow_id: string;
    workflow_version: string;
    executor_id: string;
    wait_reason: "product_decision";
  };
}

export type GovernedReviewCard = ModelCallReviewCard | ToolExecutionReviewCard | ProductDecisionReviewCard;

interface RevisionResponseError {
  detail?: string | { message?: string; issues?: string[] };
}

function createThreadId(): string {
  // This remains an AG-UI correlation id until the reviewed Product Session
  // design supplies its server-owned identity and recovery boundary.
  return crypto.randomUUID();
}

export function reviewCardFromInterrupt(interrupt: Interrupt): ModelCallReviewCard | null {
  const metadata = interrupt.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const framework = metadata.agent_framework;
  if (!framework || typeof framework !== "object") return null;
  const data = framework.data;
  if (!data || typeof data !== "object") return null;
  const card = data as Partial<ModelCallReviewCard>;
  if (
    typeof card.draft_id !== "string" ||
    typeof card.approval_id !== "string" ||
    typeof card.binding_hash !== "string" ||
    typeof card.provider_id !== "string" ||
    !Array.isArray(card.provider_catalog) ||
    !card.provider_request ||
    typeof card.provider_request !== "object"
  ) {
    return null;
  }
  return data as ModelCallReviewCard;
}

export function governedReviewFromInterrupt(interrupt: Interrupt): GovernedReviewCard | null {
  const metadata = interrupt.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const framework = metadata.agent_framework;
  if (!framework || typeof framework !== "object") return null;
  const data = framework.data;
  if (!data || typeof data !== "object") return null;
  const value = data as Partial<ToolExecutionReviewCard>;
  const productDecision = data as Partial<ProductDecisionReviewCard>;
  if (productDecision.review_kind === "product_decision") {
    if (
      typeof productDecision.approval_id !== "string" ||
      typeof productDecision.decision_request_id !== "string" ||
      typeof productDecision.decision_point_key !== "string" ||
      !Array.isArray(productDecision.allowed_actions) ||
      !Array.isArray(productDecision.editable_fields)
    ) return null;
    return data as ProductDecisionReviewCard;
  }
  if (value.review_kind === "tool_execution") {
    if (
      typeof value.approval_id !== "string" ||
      typeof value.tool_call_id !== "string" ||
      typeof value.tool_name !== "string" ||
      !value.arguments ||
      typeof value.arguments !== "object" ||
      Array.isArray(value.arguments)
    ) return null;
    return data as ToolExecutionReviewCard;
  }
  return reviewCardFromInterrupt(interrupt);
}

function cloneMessages(messages: ReadonlyArray<Readonly<Message>>): Message[] {
  return messages.map((message) => ({ ...message })) as Message[];
}

export function revisionError(payload: RevisionResponseError, fallback: string): string {
  if (typeof payload.detail === "string") return payload.detail;
  if (payload.detail && typeof payload.detail === "object") {
    const issues = payload.detail.issues;
    if (Array.isArray(issues) && issues.length > 0) return issues.join("；");
    if (payload.detail.message) return payload.detail.message;
  }
  return fallback;
}

/**
 * Projects one AG-UI HttpAgent into React without creating a second Agent store.
 * Product review data is fetched/changed through REST; AG-UI remains the only
 * run/interrupt stream and HttpAgent remains the message projection owner.
 */
interface UseChatAgentOptions {
  sessionId: string | null;
  hydratedMessages: Message[];
  hydrationVersion: number;
  runtimeJob: RuntimeJob | null;
  onSessionSettled: (hydrateMessages: boolean) => void;
}

export function useChatAgent({
  sessionId,
  hydratedMessages,
  hydrationVersion,
  runtimeJob,
  onSessionSettled,
}: UseChatAgentOptions) {
  const [agent] = useState(
    () =>
      new HttpAgent({
        url: import.meta.env.VITE_AG_UI_URL ?? DEFAULT_AGENT_URL,
        threadId: createThreadId(),
        description: "独立 AI 协作 Chat 产品",
      }),
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<RunStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<RuntimeConnectionStatus>("idle");
  const [pendingReview, setPendingReview] = useState<GovernedReviewCard | null>(null);
  const [dispatchRecovery, setDispatchRecovery] = useState<DispatchRecovery | null>(null);
  const mounted = useRef(true);
  const pendingUserMessageId = useRef<string | null>(null);
  const messagesBeforePendingRun = useRef<Message[] | null>(null);
  const lastApprovedReview = useRef<ModelCallReviewCard | null>(null);
  const activeAguiRunId = useRef<string | null>(null);
  const onSessionSettledRef = useRef(onSessionSettled);

  useEffect(() => {
    onSessionSettledRef.current = onSessionSettled;
  }, [onSessionSettled]);

  useEffect(() => {
    if (!sessionId || agent.isRunning) return;
    agent.threadId = sessionId;
    agent.setMessages(cloneMessages(hydratedMessages));
    agent.setState({});
    agent.pendingInterrupts = [];
    setMessages(cloneMessages(hydratedMessages));
    setPendingReview(null);
    setDispatchRecovery(null);
    lastApprovedReview.current = null;
    pendingUserMessageId.current = null;
    messagesBeforePendingRun.current = null;
    setStatus("idle");
    setConnectionStatus("idle");
    setError(null);
  }, [agent, hydrationVersion, sessionId]);

  useEffect(() => {
    if (!sessionId || !runtimeJob || agent.isRunning) return;
    if (!["queued", "leased", "running", "waiting_human", "waiting_recovery"].includes(runtimeJob.status)) {
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
      setStatus("running");
      setError(null);
      setConnectionStatus("reconnecting");
      while (!cancelled) {
        try {
          const response = await getRuntimeEvents(runtimeJob.id, cursor);
          if (cancelled) return;
          if (response.events.length > 0) {
            setConnectionStatus("replaying");
            replay = replayRuntimeEvents(replay, response.events);
            cursor = response.next_cursor;
            window.sessionStorage.setItem(`chat.runtime.cursor.${runtimeJob.id}`, cursor);
            agent.setMessages(cloneMessages(replay.messages));
            setMessages(cloneMessages(replay.messages));
          } else {
            setConnectionStatus("caught_up");
          }

          const terminal = replay.lastTerminal;
          if (terminal?.type === "RUN_FINISHED") {
            const outcome = terminal.outcome;
            if (outcome && typeof outcome === "object" && !Array.isArray(outcome)) {
              const typedOutcome = outcome as { type?: unknown; interrupts?: unknown };
              if (typedOutcome.type === "interrupt" && Array.isArray(typedOutcome.interrupts)) {
                // A queued/running resume may still have the previous segment's
                // interrupt as its latest persisted frame. Wait for the next
                // RUN_STARTED instead of reopening an already-resolved review.
                if (response.job.status !== "waiting_human") {
                  await new Promise((resolve) => window.setTimeout(resolve, 180));
                  continue;
                }
                const interrupts = typedOutcome.interrupts as Interrupt[];
                agent.pendingInterrupts = structuredClone(interrupts);
                const card = interrupts.map(governedReviewFromInterrupt).find(Boolean) ?? null;
                if (card) {
                  setPendingReview(card);
                  setStatus("awaiting_approval");
                  setConnectionStatus("caught_up");
                  onSessionSettledRef.current(false);
                  return;
                }
              }
            }
            if (!["succeeded", "cancelled"].includes(response.job.status)) {
              await new Promise((resolve) => window.setTimeout(resolve, 180));
              continue;
            }
            setStatus("idle");
            setConnectionStatus("caught_up");
            onSessionSettledRef.current(true);
            return;
          }
          if (terminal?.type === "RUN_ERROR" || ["failed", "cancelled", "outcome_unknown"].includes(response.job.status)) {
            setStatus("error");
            setConnectionStatus("caught_up");
            setError(String(terminal?.message ?? response.job.failure_summary ?? "Runtime Run未完成"));
            onSessionSettledRef.current(true);
            return;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 180));
        } catch (reconnectError) {
          if (cancelled) return;
          const message = reconnectError instanceof Error ? reconnectError.message : "Runtime重连失败";
          if (message.includes("RUNTIME_CURSOR_EXPIRED") || message.includes("410")) {
            setConnectionStatus("cursor_expired");
            onSessionSettledRef.current(true);
            return;
          }
          setStatus("error");
          setConnectionStatus("idle");
          setError(message);
          return;
        }
      }
    };
    void reconnect();
    return () => {
      cancelled = true;
    };
  }, [agent, hydratedMessages, hydrationVersion, runtimeJob?.id, runtimeJob?.run_attempt_id, runtimeJob?.status, sessionId]);

  const inspectDispatchFailure = useCallback(async (message: string) => {
    const review = lastApprovedReview.current;
    if (!review) return;
    let status: DispatchRecovery["status"] = "outcome_unknown";
    let errorCode: string | null = null;
    try {
      const response = await fetch(
        `${import.meta.env.VITE_API_BASE_URL ?? DEFAULT_API_BASE_URL}/api/model-call-drafts/${review.draft_id}`,
      );
      if (response.ok) {
        const card = (await response.json()) as ModelCallReviewCard;
        status = card.attempt?.status === "failed" ? "failed" : "outcome_unknown";
        errorCode = card.attempt?.error_code ?? null;
      }
    } catch {
      status = "outcome_unknown";
    }
    if (!mounted.current) return;
    setDispatchRecovery({
      draftId: review.draft_id,
      status,
      errorCode,
      message,
      originPrompt: review.origin_prompt,
    });
  }, []);

  useEffect(() => {
    mounted.current = true;
    const subscription = agent.subscribe({
      onMessagesChanged({ messages: nextMessages }) {
        if (mounted.current) setMessages(cloneMessages(nextMessages));
      },
      onRunStartedEvent() {
        if (mounted.current) {
          setStatus("running");
          setError(null);
          setConnectionStatus("caught_up");
        }
      },
      onRunFinishedEvent(result) {
        if (!mounted.current) return;
        if (result.outcome === "interrupt") {
          const card = result.interrupts.map(governedReviewFromInterrupt).find(Boolean) ?? null;
          if (card) {
            setPendingReview(card);
            setStatus("awaiting_approval");
            onSessionSettledRef.current(false);
            return;
          }
          setStatus("error");
          setError("收到无法识别的人工介入请求");
          return;
        }
        setPendingReview(null);
        setDispatchRecovery(null);
        lastApprovedReview.current = null;
        setStatus("idle");
        setConnectionStatus("caught_up");
        activeAguiRunId.current = null;
        pendingUserMessageId.current = null;
        messagesBeforePendingRun.current = null;
        onSessionSettledRef.current(true);
      },
      onRunErrorEvent({ event }) {
        if (mounted.current) {
          setStatus("error");
          setConnectionStatus("reconnecting");
          setError(event.message);
          void inspectDispatchFailure(event.message);
          onSessionSettledRef.current(true);
        }
      },
      onRunFailed({ error: runError }) {
        if (mounted.current) {
          setStatus("error");
          setConnectionStatus("reconnecting");
          setError(runError.message || "Agent连接失败");
          void inspectDispatchFailure(runError.message || "Agent连接失败");
          onSessionSettledRef.current(true);
        }
      },
    });

    return () => {
      mounted.current = false;
      subscription.unsubscribe();
      agent.abortRun();
    };
  }, [agent, inspectDispatchFailure]);

  const send = useCallback(
    async (
      content: string,
      control?: SessionRunControl,
      workflow?: ChatWorkflowDispatch,
    ) => {
      const text = content.trim();
      if (!text || agent.isRunning || pendingReview) return;

      const messageId = crypto.randomUUID();
      const runId = crypto.randomUUID();
      activeAguiRunId.current = runId;
      messagesBeforePendingRun.current = cloneMessages(agent.messages);
      pendingUserMessageId.current = messageId;
      if (workflow) agent.url = workflow.endpointUrl;
      agent.addMessage({ id: messageId, role: "user", content: text });
      setMessages(cloneMessages(agent.messages));
      setStatus("running");
      setError(null);

      try {
        await agent.runAgent(
          {
            runId,
            ...((control || workflow) ? {
              forwardedProps: {
                ...(control ? sessionControlForwardedProps(control) : {}),
                ...(workflow ? {
                  workflow: { id: workflow.workflowId, version: workflow.workflowVersion },
                } : {}),
              },
            } : {}),
          },
        );
      } catch (runError) {
        if (mounted.current) {
          setStatus("error");
          setError(runError instanceof Error ? runError.message : "Agent连接失败");
        }
      }
    },
    [agent, pendingReview],
  );

  const approve = useCallback(async () => {
    if (!pendingReview || agent.isRunning || pendingReview.review_kind === "product_decision" || pendingReview.review_kind === "tool_execution") return;
    const approvalId = pendingReview.approval_id;
    const resumeRunId = crypto.randomUUID();
    activeAguiRunId.current = resumeRunId;
    lastApprovedReview.current = pendingReview;
    setPendingReview(null);
    setStatus("running");
    setError(null);
    try {
      await agent.runAgent({
        runId: resumeRunId,
        resume: [{ interruptId: approvalId, status: "resolved", payload: { decision: "approve" } }],
      });
    } catch (runError) {
        if (mounted.current) {
          setStatus("error");
          const message = runError instanceof Error ? runError.message : "模型调用发送失败";
          setError(message);
          void inspectDispatchFailure(message);
        }
      }
  }, [agent, inspectDispatchFailure, pendingReview]);

  const revise = useCallback(
    async (providerId: string, providerRequest: Record<string, unknown>) => {
      if (!pendingReview || agent.isRunning) return;
      if (pendingReview.review_kind === "product_decision" || pendingReview.review_kind === "tool_execution") return;
      let recoverableReview = pendingReview;
      setStatus("saving");
      setError(null);
      try {
        const response = await fetch(
          `${import.meta.env.VITE_API_BASE_URL ?? DEFAULT_API_BASE_URL}/api/model-call-drafts/${pendingReview.draft_id}`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              expected_hash: pendingReview.binding_hash,
              provider_id: providerId,
              provider_request: providerRequest,
            }),
          },
        );
        if (!response.ok) {
          const payload = (await response.json()) as RevisionResponseError;
          throw new Error(revisionError(payload, `保存修改失败：HTTP ${response.status}`));
        }
        const revised = (await response.json()) as ModelCallReviewCard;
        recoverableReview = revised;
        const oldApprovalId = pendingReview.approval_id;
        setPendingReview(null);
        setStatus("running");
        await agent.runAgent({
          resume: [
            {
              interruptId: oldApprovalId,
              status: "resolved",
              payload: { decision: "revise", revision_draft_id: revised.draft_id },
            },
          ],
        });
      } catch (revisionFailure) {
        if (mounted.current) {
          setPendingReview(recoverableReview);
          setStatus("awaiting_approval");
          setError(revisionFailure instanceof Error ? revisionFailure.message : "保存修改失败");
        }
      }
    },
    [agent, pendingReview],
  );

  const abandon = useCallback(async (): Promise<string | null> => {
    if (!pendingReview || agent.isRunning || pendingReview.review_kind === "product_decision" || pendingReview.review_kind === "tool_execution") return null;
    const prompt = pendingReview.origin_prompt;
    const approvalId = pendingReview.approval_id;
    const baseline = messagesBeforePendingRun.current ?? [];
    setPendingReview(null);
    setStatus("running");
    setError(null);
    try {
      await agent.runAgent({
        resume: [{ interruptId: approvalId, status: "resolved", payload: { decision: "abandon" } }],
      });
      agent.setMessages(baseline);
      setMessages(cloneMessages(baseline));
      pendingUserMessageId.current = null;
      messagesBeforePendingRun.current = null;
      if (mounted.current) setStatus("idle");
      return prompt;
    } catch (runError) {
      if (mounted.current) {
        setStatus("error");
        setError(runError instanceof Error ? runError.message : "放弃模型调用失败");
      }
      return null;
    }
  }, [agent, pendingReview]);

  const decideProduct = useCallback(async (
    decision: string,
    changes?: Record<string, unknown>,
  ) => {
    if (!pendingReview || pendingReview.review_kind !== "product_decision" || agent.isRunning) return;
    const review = pendingReview;
    setPendingReview(null);
    setStatus("running");
    setError(null);
    try {
      await agent.runAgent({
        runId: crypto.randomUUID(),
        resume: [{
          interruptId: review.approval_id,
          status: "resolved",
          payload: { decision, ...(changes ? { changes } : {}) },
        }],
      });
    } catch (runError) {
      if (mounted.current) {
        setPendingReview(review);
        setStatus("awaiting_approval");
        setError(runError instanceof Error ? runError.message : "提交人工决定失败");
      }
    }
  }, [agent, pendingReview]);

  const stop = useCallback(async () => {
    const aguiRunId = activeAguiRunId.current;
    const review = lastApprovedReview.current;
    let cancelledStatus: ProductRun["status"] | null = null;
    if (sessionId && aguiRunId) {
      try {
        const cancelled = await cancelSessionRun(sessionId, aguiRunId);
        cancelledStatus = cancelled.status;
      } catch (cancelFailure) {
        agent.abortRun();
        setStatus("error");
        setError(cancelFailure instanceof Error ? cancelFailure.message : "取消Run失败");
        onSessionSettledRef.current(true);
        return;
      }
    }
    agent.abortRun();
    activeAguiRunId.current = null;
    if (cancelledStatus === "outcome_unknown" || review) {
      setDispatchRecovery({
        draftId: review?.draft_id ?? "",
        status: "outcome_unknown",
        errorCode: "client_cancelled_during_dispatch",
        message: "已停止等待，但请求可能已经到达Provider，系统不会自动重试。",
        originPrompt: review?.origin_prompt ?? "",
      });
      setStatus("error");
      onSessionSettledRef.current(true);
      return;
    }
    setStatus("idle");
    setError(null);
    onSessionSettledRef.current(true);
  }, [agent, sessionId]);

  const returnDispatchPrompt = useCallback((): string | null => {
    if (!dispatchRecovery) return null;
    const prompt = dispatchRecovery.originPrompt;
    lastApprovedReview.current = null;
    setDispatchRecovery(null);
    setError(null);
    setStatus("idle");
    return prompt;
  }, [dispatchRecovery]);

  const recoverFromError = useCallback(() => {
    setDispatchRecovery(null);
    setError(null);
    setStatus("idle");
  }, []);

  return {
    messages,
    status,
    connectionStatus,
    error,
    pendingReview,
    dispatchRecovery,
    threadId: agent.threadId,
    send,
    approve,
    revise,
    abandon,
    decideProduct,
    stop,
    returnDispatchPrompt,
    recoverFromError,
  };
}
