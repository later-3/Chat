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
      <div className={`message ${isUser ? "message--user" : "message--assistant"}`}>
        <p>{text}</p>
      </div>
    </article>
  );
}

function App() {
  const { messages, status, error, threadId, send, stop, newConversation } = useChatAgent();
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
    if (!draft.trim() || status === "running") return;
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

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><Bot size={19} /></span>
          <div>
            <p className="brand-name">Chat</p>
            <p className="brand-subtitle">AI 协作产品</p>
          </div>
        </div>

        <div className="topbar-actions">
          <button className="icon-button labeled-on-wide" type="button" onClick={newConversation}>
            <MessageSquarePlus size={17} />
            <span>新对话</span>
          </button>
          <button
            aria-label="查看系统信息"
            className="icon-button"
            type="button"
            onClick={() => setSystemDialogOpen(true)}
          >
            <Info size={18} />
          </button>
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
                当前骨架已接通 MAF 与 AG-UI。先发送一条消息，验证完整的流式事件链路。
              </p>
              <div className="runtime-pill">
                <span className={`status-dot ${healthError ? "status-dot--error" : ""}`} />
                {healthError ? "后端未连接" : health ? runtimeLabel : "正在检查后端"}
              </div>
            </div>
          ) : (
            <div className="message-list">
              {messages.map((message) => <MessageBubble key={message.id} message={message} />)}
              {status === "running" && (
                <div className="thinking" role="status">
                  <span /><span /><span />
                  <span className="sr-only">Agent正在回复</span>
                </div>
              )}
              {error && <div className="error-banner" role="alert">{error}</div>}
              <div ref={endRef} />
            </div>
          )}
        </section>

        <div className="composer-wrap">
          <form className="composer" onSubmit={submit}>
            <textarea
              aria-label="发送消息"
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="输入你想继续推进的事情…"
              rows={1}
              value={draft}
            />
            {status === "running" ? (
              <button aria-label="停止生成" className="send-button send-button--stop" type="button" onClick={stop}>
                <CircleStop size={19} />
              </button>
            ) : (
              <button aria-label="发送" className="send-button" disabled={!draft.trim()} type="submit">
                <ArrowUp size={20} />
              </button>
            )}
          </form>
          <p className="composer-note">Enter 发送 · Shift + Enter 换行 · 重要操作将在执行前确认</p>
        </div>
      </main>

      <Dialog.Root open={systemDialogOpen} onOpenChange={setSystemDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            <Dialog.Title>系统信息</Dialog.Title>
            <Dialog.Description>
              当前页面直接通过 AG-UI Client 连接 Microsoft Agent Framework。
            </Dialog.Description>
            <dl className="system-grid">
              <div><dt>后端</dt><dd>{healthError ? "未连接" : health?.status ?? "检查中"}</dd></div>
              <div><dt>运行模式</dt><dd>{health?.runtime_mode ?? "—"}</dd></div>
              <div><dt>Agent</dt><dd>{runtimeLabel ?? "—"}</dd></div>
              <div><dt>协议</dt><dd>{health?.protocol?.toUpperCase() ?? "AG-UI"}</dd></div>
              <div><dt>Thread</dt><dd className="mono">{threadId}</dd></div>
            </dl>
            <Dialog.Close asChild>
              <button aria-label="关闭" className="dialog-close" type="button"><X size={18} /></button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

export default App;
