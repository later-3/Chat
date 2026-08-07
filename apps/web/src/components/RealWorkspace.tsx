import { useEffect, useRef, useState } from "react";
import type { MessageDto, PlanDto, RunDto } from "@chat/contracts/public";
import { ApiProblemError } from "../api/client.js";
import { readDraft, writeDraft } from "../drafts/draft-store.js";
import type { RealChainState } from "../real/use-real-chain.js";
import { PlanPanel } from "./PlanPanel.js";

/**
 * 真实规划—确认—执行工作区（M3最小真实前端闭环）。
 *
 * 规则：
 * - 桌面对话 + 工作双栏；375px“对话 / 工作”切换。
 * - 正式Assistant Message只来自Message Query；不从超时、动画、
 *   Workflow返回值或本地状态猜测成功。
 * - 模型标签固定显示真实“百炼 Qwen3.7 Plus”，不提供Provider/模型选择。
 * - 发送失败保留草稿；Decision失败保留修改意见并展示recoveryAction。
 */

type MobilePane = "chat" | "work";

const RUN_PHASE_LABEL: Record<string, string> = {
  queued: "已接收，排队中",
  planning: "正在规划",
  plan_review: "等待你确认计划",
  executing: "正在执行已批准计划",
  validating: "正在验证结果",
  completed: "已完成",
  rejected: "已拒绝并结束",
};

const RUN_STATUS_LABEL: Record<
  RunDto["status"],
  { label: string; tone: "success" | "warning" | "danger" }
> = {
  pending: { label: "已接收", tone: "warning" },
  running: { label: "进行中", tone: "warning" },
  waiting_human: { label: "等待你的决定", tone: "warning" },
  succeeded: { label: "已完成", tone: "success" },
  failed: { label: "失败", tone: "danger" },
  cancelled: { label: "已取消", tone: "danger" },
  outcome_unknown: { label: "结果未知，正在对账", tone: "danger" },
};

function problemText(error: ApiProblemError | null): string | null {
  if (error === null) return null;
  switch (error.recoveryAction) {
    case "retry_same_command":
      return "网络结果未知，请用同一命令重试（不会重复提交）。";
    case "rehydrate_and_retry":
      return "状态已变化，正在为你刷新，请确认后再试。";
    case "contact_support":
      return "服务暂时不可用，请稍后联系支持。";
    default:
      return `操作未完成（${error.code}）。`;
  }
}

function RealChatPane({
  chain,
  sessionId,
  connected,
  onOpenWork,
}: {
  chain: RealChainState;
  sessionId: string;
  connected: boolean;
  onOpenWork: () => void;
}) {
  const [draft, setDraft] = useState(() => readDraft(window.localStorage, sessionId));
  const [awaitingOutcome, setAwaitingOutcome] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const messages: readonly MessageDto[] = chain.messages.data?.items ?? [];
  const sending = chain.sending;
  const canSend = connected && draft.trim().length > 0 && !sending && chain.canStartNewRun;

  useEffect(() => {
    if (listRef.current !== null) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages.length]);

  // 发送成功后才清空草稿；失败时草稿与commandId都保留供手动重试
  useEffect(() => {
    if (!awaitingOutcome) return;
    if (chain.sendError !== null) {
      setAwaitingOutcome(false);
      return;
    }
    if (chain.pendingSend === null && !chain.sending) {
      setAwaitingOutcome(false);
      setDraft("");
      writeDraft(window.localStorage, sessionId, "");
    }
  }, [awaitingOutcome, chain.pendingSend, chain.sendError, chain.sending, sessionId]);

  function updateDraft(text: string) {
    setDraft(text);
    writeDraft(window.localStorage, sessionId, text);
  }

  function send() {
    if (!canSend) return;
    setAwaitingOutcome(true);
    chain.sendMessage(draft.trim());
  }

  function retrySend() {
    if (sending) return;
    setAwaitingOutcome(true);
    chain.retryPendingSend();
  }

  return (
    <section className="pane chat-pane" aria-label="持续对话">
      <header className="pane-header">
        <div>
          <h2>真实规划会话</h2>
          <p>规划—确认—执行闭环 · 状态来自服务端</p>
        </div>
        <button className="pane-button" onClick={onOpenWork}>
          查看当前工作
        </button>
      </header>
      <div className="chat-stream">
        {chain.messages.isError && (
          <p className="error-note" role="alert">
            消息读取失败。
            <button className="small-button" onClick={() => void chain.messages.refetch()}>
              重新读取
            </button>
          </p>
        )}
        <ol className="chat-message-list" ref={listRef}>
          {messages.length === 0 && (
            <li className="chat-empty">
              还没有正式消息。发送你的目标后，系统会先规划，再请你确认，最后交付正式结果。
            </li>
          )}
          {messages.map((message) => (
            <li className="chat-message" data-role={message.role} key={message.messageId}>
              {message.role === "assistant" && <span className="message-author">Assistant</span>}
              <div className="message-bubble">
                <pre className="message-markdown">{message.content.text}</pre>
              </div>
            </li>
          ))}
        </ol>
      </div>
      <div className="composer">
        <div className="composer-inner">
          <div className="model-fixed-label" aria-label="当前模型">
            百炼 Qwen3.7 Plus
          </div>
          <div className="composer-row">
            <textarea
              className="composer-input"
              aria-label="消息输入框"
              placeholder="描述你要推进的事…"
              rows={2}
              value={draft}
              onChange={(event) => updateDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <button className="send-button" aria-label="发送" disabled={!canSend} onClick={send}>
              {sending ? "发送中…" : "发送"}
            </button>
          </div>
          {chain.pendingSend !== null && chain.sendError !== null && (
            <p className="composer-offline-note" role="alert">
              {problemText(chain.sendError)}
              <button className="small-button" onClick={retrySend} disabled={sending}>
                用同一命令重试
              </button>
            </p>
          )}
          {!connected && (
            <p className="composer-offline-note">
              当前离线，草稿已保存在此设备，联网后请手动发送。
            </p>
          )}
          {!chain.canStartNewRun && chain.pendingSend === null && !sending && (
            <p className="composer-offline-note">
              当前工作尚未结束；请先在工作区完成计划审核，结束后再发送下一条消息。
            </p>
          )}
          <div aria-live="polite" className="sr-status">
            {sending ? "正在提交到服务端…" : ""}
          </div>
        </div>
      </div>
    </section>
  );
}

function RunStatusBanner({ run }: { run: RunDto }) {
  const status = RUN_STATUS_LABEL[run.status];
  return (
    <div className="run-status-banner" data-tone={status.tone} role="status">
      <span className="status-dot" aria-hidden="true" />
      <strong>{status.label}</strong>
      <span>{RUN_PHASE_LABEL[run.phase] ?? run.phase}</span>
      {run.failure !== undefined && <span className="run-failure">{run.failure.summary}</span>}
    </div>
  );
}

export function RealWorkspace({ chain, connected }: { chain: RealChainState; connected: boolean }) {
  const [mobilePane, setMobilePane] = useState<MobilePane>("chat");
  const sessionId = chain.sessionId;
  const run = chain.run.data ?? null;
  const plans: readonly PlanDto[] = chain.plans.data ?? [];
  const approval = chain.approval.data ?? null;
  const runProblem = chain.run.error instanceof ApiProblemError ? chain.run.error : null;

  if (chain.bootstrapping) {
    return (
      <main className="workspace-view active" aria-label="真实规划会话">
        <p className="loading-note">正在创建真实会话…</p>
      </main>
    );
  }
  if (chain.bootstrapError !== null || sessionId === null) {
    return (
      <main className="workspace-view active" aria-label="真实规划会话">
        <p className="error-note" role="alert">
          无法连接 Chat 服务创建真实会话。请确认服务已启动后刷新重试。
        </p>
      </main>
    );
  }

  return (
    <main className="workspace-view active session-view" aria-label="真实规划会话">
      <div className="mobile-pane-tabs" role="tablist" aria-label="会话区域">
        <button
          role="tab"
          aria-selected={mobilePane === "chat"}
          className={mobilePane === "chat" ? "active" : ""}
          onClick={() => setMobilePane("chat")}
        >
          对话
        </button>
        <button
          role="tab"
          aria-selected={mobilePane === "work"}
          className={mobilePane === "work" ? "active" : ""}
          onClick={() => setMobilePane("work")}
        >
          工作
        </button>
      </div>
      <div className="session-grid layout-split real-grid" data-mobile-pane={mobilePane}>
        <RealChatPane
          chain={chain}
          sessionId={sessionId}
          connected={connected}
          onOpenWork={() => setMobilePane("work")}
        />
        <section className="pane work-pane" aria-label="工作窗口">
          <div className="work-body real-work-body">
            {chain.run.isError ? (
              <p className="error-note" role="alert">
                当前工作读取失败（{runProblem?.code ?? "network_unknown"}）。
                <button className="small-button" onClick={() => void chain.run.refetch()}>
                  重新读取
                </button>
                {runProblem?.code === "not_found" && (
                  <button className="small-button" onClick={chain.clearStaleActiveRun}>
                    移除失效的本地定位
                  </button>
                )}
              </p>
            ) : run === null ? (
              <div className="work-empty">
                <h3>当前没有进行中的工作</h3>
                <p>发送一条消息后，这里会显示规划、确认与执行的真实状态。</p>
              </div>
            ) : (
              <>
                <RunStatusBanner run={run} />
                {(chain.plans.isError || chain.approval.isError) && (
                  <p className="error-note" role="alert">
                    计划或审批读取失败，请重新读取后再决定。
                    <button
                      className="small-button"
                      onClick={() => {
                        void chain.plans.refetch();
                        void chain.approval.refetch();
                      }}
                    >
                      重新读取
                    </button>
                  </p>
                )}
                <PlanPanel chain={chain} run={run} plans={plans} approval={approval} />
              </>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
