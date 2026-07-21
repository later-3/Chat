import { HttpAgent } from "@ag-ui/client";
import type { Interrupt, Message } from "@ag-ui/core";
import { useCallback, useEffect, useRef, useState } from "react";

const DEFAULT_AGENT_URL = "http://127.0.0.1:8030/api/agent";
const DEFAULT_API_BASE_URL = "http://127.0.0.1:8030";

export type RunStatus = "idle" | "running" | "awaiting_approval" | "saving" | "error";

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
  onSessionSettled: (hydrateMessages: boolean) => void;
}

export function useChatAgent({
  sessionId,
  hydratedMessages,
  hydrationVersion,
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
  const [pendingReview, setPendingReview] = useState<ModelCallReviewCard | null>(null);
  const [dispatchRecovery, setDispatchRecovery] = useState<DispatchRecovery | null>(null);
  const mounted = useRef(true);
  const pendingUserMessageId = useRef<string | null>(null);
  const messagesBeforePendingRun = useRef<Message[] | null>(null);
  const lastApprovedReview = useRef<ModelCallReviewCard | null>(null);
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
    setError(null);
  }, [agent, hydrationVersion, sessionId]);

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
        }
      },
      onRunFinishedEvent(result) {
        if (!mounted.current) return;
        if (result.outcome === "interrupt") {
          const card = result.interrupts.map(reviewCardFromInterrupt).find(Boolean) ?? null;
          if (card) {
            setPendingReview(card);
            setStatus("awaiting_approval");
            onSessionSettledRef.current(false);
            return;
          }
          setStatus("error");
          setError("收到无法识别的模型调用审批请求");
          return;
        }
        setPendingReview(null);
        setDispatchRecovery(null);
        lastApprovedReview.current = null;
        setStatus("idle");
        pendingUserMessageId.current = null;
        messagesBeforePendingRun.current = null;
        onSessionSettledRef.current(true);
      },
      onRunErrorEvent({ event }) {
        if (mounted.current) {
          setStatus("error");
          setError(event.message);
          void inspectDispatchFailure(event.message);
          onSessionSettledRef.current(true);
        }
      },
      onRunFailed({ error: runError }) {
        if (mounted.current) {
          setStatus("error");
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
    async (content: string) => {
      const text = content.trim();
      if (!text || agent.isRunning || pendingReview) return;

      const messageId = crypto.randomUUID();
      messagesBeforePendingRun.current = cloneMessages(agent.messages);
      pendingUserMessageId.current = messageId;
      agent.addMessage({ id: messageId, role: "user", content: text });
      setMessages(cloneMessages(agent.messages));
      setStatus("running");
      setError(null);

      try {
        await agent.runAgent();
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
    if (!pendingReview || agent.isRunning) return;
    const approvalId = pendingReview.approval_id;
    lastApprovedReview.current = pendingReview;
    setPendingReview(null);
    setStatus("running");
    setError(null);
    try {
      await agent.runAgent({
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
    if (!pendingReview || agent.isRunning) return null;
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

  const stop = useCallback(() => {
    agent.abortRun();
    const review = lastApprovedReview.current;
    if (review) {
      setDispatchRecovery({
        draftId: review.draft_id,
        status: "outcome_unknown",
        errorCode: "client_cancelled_during_dispatch",
        message: "已停止等待，但请求可能已经到达Provider，系统不会自动重试。",
        originPrompt: review.origin_prompt,
      });
      setStatus("error");
      return;
    }
    setStatus("idle");
  }, [agent]);

  const returnDispatchPrompt = useCallback((): string | null => {
    if (!dispatchRecovery) return null;
    const baseline = messagesBeforePendingRun.current ?? [];
    agent.setMessages(baseline);
    setMessages(cloneMessages(baseline));
    const prompt = dispatchRecovery.originPrompt;
    pendingUserMessageId.current = null;
    messagesBeforePendingRun.current = null;
    lastApprovedReview.current = null;
    setDispatchRecovery(null);
    setError(null);
    setStatus("idle");
    return prompt;
  }, [agent, dispatchRecovery]);

  return {
    messages,
    status,
    error,
    pendingReview,
    dispatchRecovery,
    threadId: agent.threadId,
    send,
    approve,
    revise,
    abandon,
    stop,
    returnDispatchPrompt,
  };
}
