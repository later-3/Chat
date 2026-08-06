import { useState } from "react";
import type { ChatMessage } from "../viewmodel/chat-view-model.js";

interface ChatPanelProps {
  messages: readonly ChatMessage[];
  onSend: (text: string) => void;
}

/**
 * 对话区：消息列表/空态 + 输入发送。
 * 发送只做本地即时上屏，不代表服务端已保存（持久化属于P1.3）。
 */
export function ChatPanel({ messages, onSend }: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const canSend = draft.trim().length > 0;

  function send() {
    const text = draft.trim();
    if (!text) {
      return;
    }
    onSend(text);
    setDraft("");
  }

  return (
    <section className="chat-panel" aria-label="对话区">
      <div className="message-list">
        {messages.length === 0 ? (
          <div className="chat-empty">
            <div>
              <p className="chat-empty-title">开始一段对话</p>
              <p className="chat-empty-subtitle">输入消息，Chat 会持续跟进这件事</p>
            </div>
          </div>
        ) : (
          <ol className="message-list-inner">
            {messages.map((message) => (
              <li key={message.id} className="message" data-role={message.role}>
                <div className="message-bubble">{message.text}</div>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="composer">
        <div className="composer-inner">
          <textarea
            className="composer-input"
            aria-label="消息输入框"
            placeholder="发消息…"
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                send();
              }
            }}
          />
          <button
            type="button"
            className="send-button"
            aria-label="发送"
            disabled={!canSend}
            onClick={send}
          >
            <svg width="17" height="17" viewBox="0 0 17 17" fill="none" aria-hidden="true">
              <path
                d="M8.5 13.5v-10M4 8l4.5-4.5L13 8"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
    </section>
  );
}
