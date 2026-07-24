import type { Message } from "@ag-ui/core";
import { Check, Copy, PanelRightOpen, RotateCcw, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { BrowserNetworkStatus } from "../mobile/use-network-status";
import type { ProductRun, ProductSession } from "../session/session-api";
import { copyProductSessionId, productSessionLocator } from "../session/session-identifier";
import type { WorkflowDefinition } from "../workflow/workflow-api";
import type {
  DispatchRecovery,
  GovernedReviewCard,
  RunStatus,
  RuntimeConnectionStatus,
} from "./chat-agent-contracts";
import { ChatComposer } from "./chat-composer";
import { MessageBubble } from "./message-bubble";

interface RetrySource {
  forceRestart?: boolean;
  prompt: string;
  runId: string;
}

export interface ConversationPaneProps {
  activeSession: ProductSession | null;
  busy: boolean;
  connectionStatus: RuntimeConnectionStatus;
  dispatchRecovery: DispatchRecovery | null;
  draft: string;
  error: string | null;
  healthError: boolean;
  latestRun: ProductRun | null;
  messages: Message[];
  networkStatus: BrowserNetworkStatus;
  onCancelRetry: () => void;
  onChangeDraft: (value: string) => void;
  onEditAndRestart: (run: ProductRun) => void;
  onOpenWorkbench: () => void;
  onRetry: (run: ProductRun) => void;
  onReturnDispatchPrompt: () => void;
  onStop: () => void;
  onSubmit: () => void;
  onWorkflowChange: (workflowId: string) => void;
  pendingReview: GovernedReviewCard | null;
  retrySource: RetrySource | null;
  retryableLatestRun: ProductRun | null;
  runtimeLabel: string | null;
  runtimeMode: "bootstrap" | "model" | null;
  selectableWorkflows: WorkflowDefinition[];
  selectedWorkflow: WorkflowDefinition;
  sessionError: string | null;
  sessionLoading: boolean;
  status: RunStatus;
  workbenchOpen: boolean;
}

export function runLabel(status: string): string {
  const labels: Record<string, string> = {
    accepted: "已接纳",
    running: "运行中",
    waiting_approval: "等待模型请求审批",
    succeeded: "已完成",
    failed: "已失败",
    cancelled: "已取消",
    outcome_unknown: "结果未知，需要确认",
    abandoned: "已放弃",
    interrupted: "已中断",
  };
  return labels[status] ?? status;
}

/**
 * Render the Product Session conversation projection.
 *
 * This component owns only scroll and presentation state. Product history,
 * Run recovery and Workflow selection remain server-owned facts coordinated by
 * the App container.
 */
export function ConversationPane({
  activeSession,
  busy,
  connectionStatus,
  dispatchRecovery,
  draft,
  error,
  healthError,
  latestRun,
  messages,
  networkStatus,
  onCancelRetry,
  onChangeDraft,
  onEditAndRestart,
  onOpenWorkbench,
  onRetry,
  onReturnDispatchPrompt,
  onStop,
  onSubmit,
  onWorkflowChange,
  pendingReview,
  retrySource,
  retryableLatestRun,
  runtimeLabel,
  runtimeMode,
  selectableWorkflows,
  selectedWorkflow,
  sessionError,
  sessionLoading,
  status,
  workbenchOpen,
}: ConversationPaneProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const [sessionIdCopied, setSessionIdCopied] = useState(false);

  async function copySessionId(): Promise<void> {
    if (!activeSession) return;
    await copyProductSessionId(activeSession.id);
    setSessionIdCopied(true);
    window.setTimeout(() => setSessionIdCopied(false), 1800);
  }

  // The ref itself is stable; message and Run status changes intentionally
  // schedule scrolling after the corresponding projection is rendered.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the dependency values are the scroll triggers
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  return (
    <main className="chat-layout">
      <div className="conversation-header">
        <div>
          <strong>{activeSession?.title ?? "正在加载会话"}</strong>
          <span>
            {activeSession
              ? `${productSessionLocator(activeSession.id)} · 会话版本 ${activeSession.revision} · ${activeSession.channel.toUpperCase()}`
              : "Product Store"}
          </span>
        </div>
        <div className="conversation-header-actions">
          {activeSession && (
            <button
              aria-label={`复制完整 Product Session ID ${activeSession.id}`}
              className="session-id-copy"
              onClick={() => void copySessionId()}
              title={activeSession.id}
              type="button"
            >
              {sessionIdCopied ? <Check size={15} /> : <Copy size={15} />}
              {sessionIdCopied ? "已复制会话ID" : productSessionLocator(activeSession.id)}
            </button>
          )}
          {latestRun && (
            <span className={`run-badge run-badge--${latestRun.status}`}>
              {runLabel(latestRun.status)}
            </span>
          )}
          {!workbenchOpen && (
            <button
              aria-label="打开 Workflow Run 工作台"
              id="conversation-workbench-trigger"
              onClick={onOpenWorkbench}
              type="button"
            >
              <PanelRightOpen size={16} />
              工作台
            </button>
          )}
        </div>
      </div>

      {networkStatus === "offline" && (
        <div className="network-banner" role="status">
          当前设备离线。你可以保留输入，但恢复网络并由服务端接纳后才能发送或审批。
        </div>
      )}

      <section className="conversation" aria-label="对话消息">
        {sessionLoading ? (
          <div className="empty-state">
            <div className="thinking" role="status">
              <span />
              <span />
              <span />
              <span className="sr-only">正在恢复会话</span>
            </div>
          </div>
        ) : messages.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">
              <Sparkles size={25} />
            </div>
            <p className="eyebrow">可持续推进的 AI 协作</p>
            <h1>
              从一句话开始，
              <br />
              把事情真正推进下去。
            </h1>
            <p className="empty-copy">
              {runtimeMode === "model"
                ? "输入会先保存到Product Session；每一次模型调用都会暂停，确认完整请求后才发送。"
                : "当前未配置模型，因此使用确定性启动Agent验证MAF、AG-UI与Product Session链路。"}
            </p>
            <div className="runtime-pill">
              <span className={`status-dot ${healthError ? "status-dot--error" : ""}`} />
              {healthError ? "后端未连接" : (runtimeLabel ?? "正在检查后端")}
            </div>
          </div>
        ) : (
          <div className="message-list">
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
            {busy && (
              <div className="thinking" role="status">
                <span />
                <span />
                <span />
                <span className="sr-only">正在处理</span>
              </div>
            )}
            {error && !pendingReview && !dispatchRecovery && (
              <div className="error-banner" role="alert">
                {error}
              </div>
            )}
            {sessionError && (
              <div className="error-banner" role="alert">
                {sessionError}
              </div>
            )}
            {dispatchRecovery && (
              <div
                className={`dispatch-recovery dispatch-recovery--${dispatchRecovery.status}`}
                role="alert"
              >
                <strong>
                  {dispatchRecovery.status === "outcome_unknown"
                    ? "模型调用结果未知"
                    : "模型调用已明确失败"}
                </strong>
                <p>{dispatchRecovery.message}</p>
                {dispatchRecovery.status === "outcome_unknown" && (
                  <p>重新发送可能产生重复调用或费用，请先确认Provider侧没有留下结果。</p>
                )}
                <small>错误代码：{dispatchRecovery.errorCode ?? "unavailable"}</small>
                <button onClick={onReturnDispatchPrompt} type="button">
                  返回输入框，由我确认 Provider 结果后决定
                </button>
              </div>
            )}
            {!dispatchRecovery && !pendingReview && retryableLatestRun?.input_text && (
              <section className="run-recovery" aria-label="失败Run恢复操作">
                <div>
                  <strong>
                    {retryableLatestRun.failure_code === "context_source_stale"
                      ? "仓库上下文已变化，旧请求没有发送"
                      : `${runLabel(retryableLatestRun.status)}的Run可以显式处理`}
                  </strong>
                  <p>
                    {retryableLatestRun.failure_code === "context_source_stale"
                      ? "系统已停止旧Run。重新准备会读取最新Snapshot、重新组装Context并生成新的发送前审批。"
                      : "旧Run和Attempt会保留；再次执行会创建有血缘的新Run，并重新进入发送前审批。"}
                  </p>
                </div>
                <div>
                  <button onClick={() => onRetry(retryableLatestRun)} type="button">
                    <RotateCcw size={14} />
                    {retryableLatestRun.failure_code === "context_source_stale"
                      ? "按最新仓库重新准备"
                      : "原样重试"}
                  </button>
                  <button onClick={() => onEditAndRestart(retryableLatestRun)} type="button">
                    修改后重新运行
                  </button>
                </div>
              </section>
            )}
            <div ref={endRef} />
          </div>
        )}
      </section>

      <ChatComposer
        activeSessionAvailable={activeSession !== null}
        browserOnline={networkStatus === "online"}
        connectionStatus={connectionStatus}
        draft={draft}
        onCancelRetry={onCancelRetry}
        onChangeDraft={onChangeDraft}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
          }
        }}
        onStop={onStop}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        onWorkflowChange={onWorkflowChange}
        pendingReview={Boolean(pendingReview)}
        retrySource={retrySource}
        selectableWorkflows={selectableWorkflows}
        selectedWorkflow={selectedWorkflow}
        sessionLoading={sessionLoading}
        status={status}
      />
    </main>
  );
}
