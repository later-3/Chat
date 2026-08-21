import { useState } from "react";
import { Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { InjectFace, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import { SessionRecordsContent, type SessionRecordsInjected } from "./SessionRecordsView.tsx";

export type ChatSessionButtonProps = PropsRuntime<"conversation.session.header.utilities"> &
  InjectFace<SessionRecordsInjected>;

/**
 * Chat Session是DSH原生对话上的加法检查面。按钮不读取浏览器缓存拼接事实；
 * 弹窗与“会话记录”页签复用同一个Bridge双源Query和同一个controller。
 */
export function ChatSessionButton(props: ChatSessionButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="lifeos-chat-session-toggle"
        data-testid="lifeos-chat-session-open"
        aria-label="打开 Chat Session"
        title="打开 Chat Session"
        onClick={() => setOpen(true)}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
          <path
            d="M2.5 3.25h11v7.5h-6L4.25 13v-2.25H2.5z"
            stroke="currentColor"
            strokeWidth="1.35"
            strokeLinejoin="round"
          />
          <path d="M5 6h6M5 8.25h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
        <span>Chat Session</span>
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Chat Session 预览"
        closeLabel="关闭 Chat Session 预览"
        description="友好视图展示Chat正式会话、DSH原生来源以及它们之间的稳定身份关联。"
        className="lifeos-chat-session-modal"
        contentClassName="lifeos-chat-session-modal-content"
      >
        <SessionRecordsContent {...props} presentation="modal" />
      </Modal>
    </>
  );
}
