/**
 * 默认Chat Agent的前端驱动（单AG-UI Thread）——发送链的React入口。
 *
 * 链路：用户点击发送 -> send()追加消息并调HttpAgent.runAgent() -> AG-UI POST
 * -> 后端接纳为持久Runtime Job -> ProductAwareWorkflow -> 39节点主Workflow
 * -> GovernedSemanticAgentExecutor构造ModelCallDraft、中断等审批、批准后发送精确字节。
 *
 * 中断经governedReviewFromInterrupt转成三类审批卡（模型调用/产品决定/Tool执行）；
 * 修改走REST（/api/model-call-drafts/:id），保证可编辑请求与发送字节同源。
 * 停止走Product Session取消端点；可能已到达Provider的派发只呈现outcome_unknown，绝不自动重试。
 */
import { HttpAgent } from "@ag-ui/client";
import type { Message } from "@ag-ui/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiErrorFromResponse } from "./api-client.js";
import { authenticatedFetch } from "./authentication-recovery.js";
import { createClientId } from "./client-id.js";
import {
  type ChatWorkflowDispatch,
  type DispatchRecovery,
  type GovernedReviewCard,
  governedReviewFromInterrupt,
  type ModelCallReviewCard,
  type RunStatus,
  type RuntimeConnectionStatus,
} from "./features/chat/chat-agent-contracts.js";
import { useRuntimeReconnect } from "./features/chat/use-runtime-reconnect.js";
import { AG_UI_URL, apiUrl } from "./runtime-config.js";
import {
  cancelSessionRun,
  type ProductRun,
  type RuntimeJob,
  type SessionRunControl,
  sessionControlForwardedProps,
} from "./session-api.js";

function createThreadId(): string {
  // 这只是AG-UI关联ID；服务端Product Session身份与恢复边界由后端拥有。
  return createClientId();
}

function cloneMessages(messages: ReadonlyArray<Readonly<Message>>): Message[] {
  // 每次投影都复制一份，防止AG-UI内部数组被React引用后意外共享突变。
  return messages.map((message) => ({ ...message })) as Message[];
}

export type {
  ChatWorkflowDispatch,
  ContextSourceView,
  DispatchRecovery,
  EffectiveContextView,
  GovernedReviewCard,
  ModelCallReviewCard,
  ModelCapabilities,
  ModelOption,
  ModelProviderOption,
  ParameterCapability,
  ProductDecisionEditableField,
  ProductDecisionReviewCard,
  RunStatus,
  RuntimeConnectionStatus,
  ToolExecutionReviewCard,
} from "./features/chat/chat-agent-contracts.js";
export {
  governedReviewFromInterrupt,
  reviewCardFromInterrupt,
} from "./features/chat/chat-agent-contracts.js";

/**
 * 把一个AG-UI HttpAgent投影进React，不创建第二个Agent Store。
 * 产品审批数据走REST读取/修改；AG-UI仍是唯一的Run/Interrupt流，HttpAgent仍是消息投影所有者。
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
        url: AG_UI_URL,
        threadId: createThreadId(),
        description: "独立 AI 协作 Chat 产品",
        fetch: authenticatedFetch,
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

  // 会话切换/刷新后的水合：用服务端权威历史重置Agent与本地状态；运行中不打断。
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

  useRuntimeReconnect({
    agent,
    sessionId,
    hydratedMessages,
    hydrationVersion,
    runtimeJob,
    onMessages: setMessages,
    onStatus: setStatus,
    onConnectionStatus: setConnectionStatus,
    onError: setError,
    onPendingReview: setPendingReview,
    onSessionSettled,
  });

  // 派发失败后的结果探查：读Draft的Attempt状态，只区分failed/outcome_unknown，绝不重试。
  const inspectDispatchFailure = useCallback(async (message: string) => {
    const review = lastApprovedReview.current;
    if (!review) return;
    let status: DispatchRecovery["status"] = "outcome_unknown";
    let errorCode: string | null = null;
    try {
      const response = await authenticatedFetch(
        apiUrl(`/api/model-call-drafts/${review.draft_id}`),
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

  // 订阅AG-UI事件：消息增量、Run开始/结束/错误；interrupt在此转成审批卡。
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
        debugger; // DEBUG-BREAKPOINT: BP-29
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

  /** 发送Prompt：追加User消息并启动一次AG-UI Run；Workflow选择与控制字段随forwardedProps固化。 */
  const send = useCallback(
    async (content: string, control?: SessionRunControl, workflow?: ChatWorkflowDispatch) => {
      debugger; // DEBUG-BREAKPOINT: BP-28
      const text = content.trim();
      if (!text || agent.isRunning || pendingReview) return;

      const messageId = createClientId();
      const runId = createClientId();
      activeAguiRunId.current = runId;
      messagesBeforePendingRun.current = cloneMessages(agent.messages);
      pendingUserMessageId.current = messageId;
      if (workflow) agent.url = workflow.endpointUrl;
      agent.addMessage({ id: messageId, role: "user", content: text });
      setMessages(cloneMessages(agent.messages));
      setStatus("running");
      setError(null);

      try {
        await agent.runAgent({
          runId,
          ...(control || workflow
            ? {
                forwardedProps: {
                  ...(control ? sessionControlForwardedProps(control) : {}),
                  ...(workflow
                    ? {
                        workflow: { id: workflow.workflowId, version: workflow.workflowVersion },
                      }
                    : {}),
                },
              }
            : {}),
        });
      } catch (runError) {
        if (mounted.current) {
          setStatus("error");
          setError(runError instanceof Error ? runError.message : "Agent连接失败");
        }
      }
    },
    [agent, pendingReview],
  );

  /** 原样批准当前模型调用草稿并Resume；发送的字节就是审批时看到的字节。 */
  const approve = useCallback(async () => {
    if (
      !pendingReview ||
      agent.isRunning ||
      pendingReview.review_kind === "product_decision" ||
      pendingReview.review_kind === "tool_execution"
    )
      return;
    const approvalId = pendingReview.approval_id;
    const resumeRunId = createClientId();
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

  /** 先经REST保存修改（新revision+新Hash），再带新revision Resume；失败时恢复审批卡。 */
  const revise = useCallback(
    async (providerId: string, providerRequest: Record<string, unknown>) => {
      if (!pendingReview || agent.isRunning) return;
      if (
        pendingReview.review_kind === "product_decision" ||
        pendingReview.review_kind === "tool_execution"
      )
        return;
      let recoverableReview = pendingReview;
      setStatus("saving");
      setError(null);
      try {
        const response = await authenticatedFetch(
          apiUrl(`/api/model-call-drafts/${pendingReview.draft_id}`),
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
          throw await apiErrorFromResponse(response, `保存修改失败：HTTP ${response.status}`);
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

  /** 放弃当前模型调用：零Provider发送，恢复原Prompt与发送前消息快照。 */
  const abandon = useCallback(async (): Promise<string | null> => {
    if (
      !pendingReview ||
      agent.isRunning ||
      pendingReview.review_kind === "product_decision" ||
      pendingReview.review_kind === "tool_execution"
    )
      return null;
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

  /** 提交产品决定（accept/revise/skip/cancel）并Resume；失败时恢复审批卡不丢现场。 */
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
          runId: createClientId(),
          resume: [
            {
              interruptId: review.approval_id,
              status: "resolved",
              payload: { decision, ...(changes ? { changes } : {}) },
            },
          ],
        });
      } catch (runError) {
        if (mounted.current) {
          setPendingReview(review);
          setStatus("awaiting_approval");
          setError(runError instanceof Error ? runError.message : "提交人工决定失败");
        }
      }
    },
    [agent, pendingReview],
  );

  /** 经Product Session取消活动AG-UI Run；可能已到达Provider时只呈现outcome_unknown。 */
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

  // 结果未知恢复：把原Prompt取回输入框，清除恢复现场，等待用户决定下一步。
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
