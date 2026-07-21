import type { Message } from "@ag-ui/core";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowUp,
  Bot,
  CircleStop,
  Info,
  MessageSquarePlus,
  Sparkles,
  UserRound,
  X,
} from "lucide-react";
import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";

import { ModelCallReview } from "./model-call-review";
import { useChatAgent } from "./use-chat-agent";
import { useUiStore } from "./ui-store";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8030";

interface Health {
  status: string;
  service: string;
  version: string;
  agent_framework: string;
  protocol: string;
  runtime_mode: "bootstrap" | "model";
  model: string | null;
  model_call_approval: "every_call" | "not_applicable";
}

function getMessageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const text = getMessageText(message);
  if (!text || !["user", "assistant"].includes(message.role)) return null;

  return (
    <article className={`message-row ${isUser ? "message-row--user" : ""}`}>
      <div className={`avatar ${isUser ? "avatar--user" : "avatar--assistant"}`}>
        {isUser ? <UserRound size={16} /> : <Sparkles size={16} />}
      </div>
      <div className={`message ${isUser ? "message--user" : "message--assistant"}`}><p>{text}</p></div>
    </article>
  );
}

function App() {
  const {
    messages,
    status,
    error,
    pendingReview,
    dispatchRecovery,
    threadId,
    send,
    approve,
    revise,
    abandon,
    stop,
    returnDispatchPrompt,
    newConversation,
  } = useChatAgent();
  const [draft, setDraft] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const systemDialogOpen = useUiStore((state) => state.systemDialogOpen);
  const setSystemDialogOpen = useUiStore((state) => state.setSystemDialogOpen);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_BASE_URL}/api/health`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("health check failed");
        return response.json() as Promise<Health>;
      })
      .then((data) => {
        setHealth(data);
        setHealthError(false);
      })
      .catch((fetchError: unknown) => {
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") return;
        setHealthError(true);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!draft.trim() || status !== "idle") return;
    const text = draft;
    setDraft("");
    void send(text);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const runtimeLabel = health?.runtime_mode === "model" ? health.model : "确定性启动 Agent";
  const busy = status === "running" || status === "saving";

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><Bot size={19} /></span>
          <div><p className="brand-name">Chat</p><p className="brand-subtitle">AI 协作产品</p></div>
        </div>
        <div className="topbar-actions">
          <button className="icon-button labeled-on-wide" onClick={() => { newConversation(); setDraft(""); }} type="button">
            <MessageSquarePlus size={17} /><span>新对话</span>
          </button>
          <button aria-label="查看系统信息" className="icon-button" onClick={() => setSystemDialogOpen(true)} type="button"><Info size={18} /></button>
        </div>
      </header>

      <main className="chat-layout">
        <section className="conversation" aria-label="对话消息">
          {messages.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon"><Sparkles size={25} /></div>
              <p className="eyebrow">可持续推进的 AI 协作</p>
              <h1>从一句话开始，<br />把事情真正推进下去。</h1>
              <p className="empty-copy">
                {health?.runtime_mode === "model"
                  ? "每一次模型调用都会先暂停；你可以查看并修改完整请求，确认后才会发送。"
                  : "当前未配置模型，因此使用确定性启动Agent验证MAF与AG-UI链路。"}
              </p>
              <div className="runtime-pill"><span className={`status-dot ${healthError ? "status-dot--error" : ""}`} />{healthError ? "后端未连接" : health ? runtimeLabel : "正在检查后端"}</div>
            </div>
          ) : (
            <div className="message-list">
              {messages.map((message) => <MessageBubble key={message.id} message={message} />)}
              {busy && <div className="thinking" role="status"><span /><span /><span /><span className="sr-only">正在处理</span></div>}
              {error && !pendingReview && !dispatchRecovery && <div className="error-banner" role="alert">{error}</div>}
              {dispatchRecovery && (
                <div className={`dispatch-recovery dispatch-recovery--${dispatchRecovery.status}`} role="alert">
                  <strong>{dispatchRecovery.status === "outcome_unknown" ? "模型调用结果未知" : "模型调用已明确失败"}</strong>
                  <p>{dispatchRecovery.message}</p>
                  {dispatchRecovery.status === "outcome_unknown" && (
                    <p>重新发送可能产生重复调用或费用，请先确认Provider侧没有留下结果。</p>
                  )}
                  <small>错误代码：{dispatchRecovery.errorCode ?? "unavailable"}</small>
                  <button
                    onClick={() => {
                      const prompt = returnDispatchPrompt();
                      if (prompt !== null) setDraft(prompt);
                    }}
                    type="button"
                  >返回输入框，由我决定是否修改后重发</button>
                </div>
              )}
              <div ref={endRef} />
            </div>
          )}
        </section>

        <div className="composer-wrap">
          <form className="composer" onSubmit={submit}>
            <textarea
              aria-label="发送消息"
              autoFocus
              disabled={status !== "idle"}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={pendingReview ? "请先处理本次模型调用审批…" : "输入你想继续推进的事情…"}
              rows={1}
              value={draft}
            />
            {draft && status === "idle" && <button aria-label="清空输入" className="clear-draft-button" onClick={() => setDraft("")} type="button"><X size={17} /></button>}
            {status === "running"
              ? <button aria-label="停止生成" className="send-button send-button--stop" onClick={stop} type="button"><CircleStop size={19} /></button>
              : <button aria-label="发送" className="send-button" disabled={!draft.trim() || status !== "idle"} type="submit"><ArrowUp size={20} /></button>}
          </form>
          <p className="composer-note">Enter 发送 · Shift + Enter 换行 · 每次模型调用都在发送前确认</p>
        </div>
      </main>

      {pendingReview && (
        <ModelCallReview
          busy={busy}
          card={pendingReview}
          onAbandon={() => { void abandon().then((prompt) => { if (prompt !== null) setDraft(prompt); }); }}
          onApprove={() => void approve()}
          onRevise={(providerId, providerRequest) => void revise(providerId, providerRequest)}
          requestError={error}
        />
      )}

      <Dialog.Root open={systemDialogOpen} onOpenChange={setSystemDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            <Dialog.Title>系统信息</Dialog.Title>
            <Dialog.Description>AG-UI负责运行流；模型模式下由MAF Workflow在每次Provider请求前暂停审批。</Dialog.Description>
            <dl className="system-grid">
              <div><dt>后端</dt><dd>{healthError ? "未连接" : health?.status ?? "检查中"}</dd></div>
              <div><dt>运行模式</dt><dd>{health?.runtime_mode ?? "—"}</dd></div>
              <div><dt>Agent</dt><dd>{runtimeLabel ?? "—"}</dd></div>
              <div><dt>模型审批</dt><dd>{health?.model_call_approval === "every_call" ? "每次调用" : "不适用"}</dd></div>
              <div><dt>协议</dt><dd>{health?.protocol?.toUpperCase() ?? "AG-UI"}</dd></div>
              <div><dt>Thread</dt><dd className="mono">{threadId}</dd></div>
            </dl>
            <Dialog.Close asChild><button aria-label="关闭" className="dialog-close" type="button"><X size={18} /></button></Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

export default App;
