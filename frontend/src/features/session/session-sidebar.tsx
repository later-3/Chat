import { Bot, Check, ChevronLeft, ChevronRight, MessageSquarePlus } from "lucide-react";
import type { ProductSession } from "./session-api";
import { productSessionLocator } from "./session-identifier";
import "./session-sidebar.css";

interface SessionSidebarProps {
  activeSessionId: string | null;
  healthError: boolean;
  interactionBusy: boolean;
  onCloseMobile: () => void;
  onCollapse: () => void;
  onCreate: () => void;
  onExpand: () => void;
  onOpen: (sessionId: string) => void;
  sessions: ProductSession[];
  sidebarCollapsed: boolean;
  sidebarOpen: boolean;
}

export function SessionSidebar({
  activeSessionId,
  healthError,
  interactionBusy,
  onCloseMobile,
  onCollapse,
  onCreate,
  onExpand,
  onOpen,
  sessions,
  sidebarCollapsed,
  sidebarOpen,
}: SessionSidebarProps) {
  return (
    <>
      {sidebarOpen && (
        <button
          aria-label="关闭会话列表"
          className="session-sidebar-backdrop"
          onClick={onCloseMobile}
          type="button"
        />
      )}
      <aside
        aria-label="会话列表"
        className={`session-sidebar ${sidebarOpen ? "session-sidebar--open" : ""}`}
      >
        <div className="session-sidebar-heading">
          <div>
            <span>PRODUCT SESSIONS</span>
            <strong>会话</strong>
          </div>
          <div>
            <button
              aria-label="创建会话"
              disabled={interactionBusy}
              onClick={onCreate}
              type="button"
            >
              <MessageSquarePlus size={16} />
            </button>
            <button
              aria-label="收起会话列表"
              className="sidebar-collapse-button"
              onClick={onCollapse}
              type="button"
            >
              <ChevronLeft size={16} />
            </button>
          </div>
        </div>
        <div className="session-list">
          {sessions.map((session) => (
            <button
              className={`session-item ${session.id === activeSessionId ? "session-item--active" : ""}`}
              disabled={interactionBusy && session.id !== activeSessionId}
              key={session.id}
              onClick={() => onOpen(session.id)}
              type="button"
            >
              <span className="session-item-icon">
                <Bot size={14} />
              </span>
              <span className="session-item-copy">
                <strong>{session.title}</strong>
                <small>
                  {productSessionLocator(session.id)} · 版本 {session.revision} ·{" "}
                  {session.active_run_id ? "运行中" : "历史可打开"}
                </small>
              </span>
              {session.id === activeSessionId && <Check size={14} />}
            </button>
          ))}
        </div>
        <div className="session-sidebar-foot">
          <span className={`status-dot ${healthError ? "status-dot--error" : ""}`} />
          <span>{healthError ? "后端未连接" : `${sessions.length} 个活动会话`}</span>
        </div>
      </aside>
      {sidebarCollapsed && (
        <button
          aria-label="展开会话列表"
          className="session-rail-toggle"
          onClick={onExpand}
          type="button"
        >
          <ChevronRight size={16} />
          <span>会话</span>
        </button>
      )}
    </>
  );
}
