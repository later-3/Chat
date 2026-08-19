import { useState } from "react";
import type { HostObservable, InjectFace } from "@deepseek-ai/dsh-client-ui-slots";
import type { ConvViewProps } from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { SessionRecordsMessageItem } from "../contracts.ts";
import type { SessionRecordsState } from "./session-records-controller.ts";

export interface SessionRecordsInjected {
  hooks: { sessionRecords: HostObservable<SessionRecordsState> };
  refresh: () => Promise<void>;
  loadMoreChat: () => Promise<void>;
  loadMoreDsh: () => Promise<void>;
}

export type SessionRecordsViewProps = ConvViewProps & InjectFace<SessionRecordsInjected>;

type SourceTab = "chat" | "dsh";

function dateTime(value: string | number | null): string {
  if (value === null) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN");
}

function isoDateTime(value: string | number): string | undefined {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function ChatMessageRecord({ item }: { item: SessionRecordsMessageItem }) {
  const message = item.message;
  return (
    <article
      className="lifeos-record-card"
      data-role={message.role}
      data-testid={`lifeos-product-message-${String(message.sessionSequence)}`}
    >
      <header className="lifeos-record-card-header">
        <div>
          <strong>{message.role === "user" ? "用户" : "Chat 正式回复"}</strong>
          <span>#{message.sessionSequence}</span>
        </div>
        <time dateTime={message.createdAt}>{dateTime(message.createdAt)}</time>
      </header>
      <div className="lifeos-record-content">{message.content.text}</div>
      <footer className="lifeos-record-identities">
        <code>{message.messageId}</code>
        {item.link.dshMessageId === undefined ? null : <code>DSH {item.link.dshMessageId}</code>}
        {item.link.productRunId === undefined ? null : <code>Run {item.link.productRunId}</code>}
      </footer>
    </article>
  );
}

function SourceState({
  status,
  error,
  empty,
}: {
  status: string;
  error: string | null;
  empty: boolean;
}) {
  if (status === "loading" && empty) {
    return <p className="lifeos-record-empty">正在读取…</p>;
  }
  if (status === "error" && empty) {
    return <p className="lifeos-record-error">{error ?? "读取失败"}</p>;
  }
  if (status === "ready" && empty) {
    return <p className="lifeos-record-empty">还没有记录。</p>;
  }
  return null;
}

/**
 * DSH原生Conversation View中的双源检查面。Chat页展示正式产品消息，DSH页
 * 展示完整原始事件；普通“对话”页和“轨迹”页仍分别拥有阅读与执行过程体验。
 */
export function SessionRecordsView({
  useSessionRecords,
  refresh,
  loadMoreChat,
  loadMoreDsh,
}: SessionRecordsViewProps) {
  const state = useSessionRecords((value) => value);
  const [tab, setTab] = useState<SourceTab>("chat");
  const overview = state.overview;
  const chat = overview?.chat;
  const dsh = overview?.dsh;

  return (
    <section className="lifeos-records" aria-label="会话记录" data-testid="lifeos-session-records">
      <header className="lifeos-records-toolbar">
        <div>
          <strong>会话记录</strong>
          <span>Product Session 与 DSH Session 分开持久化，在这里组合查看</span>
        </div>
        <button
          type="button"
          disabled={state.overviewStatus === "loading"}
          onClick={() => void refresh()}
        >
          刷新
        </button>
      </header>

      {state.overviewStatus === "error" && overview === null ? (
        <div className="lifeos-records-fatal" role="alert">
          {state.overviewError ?? "会话概况读取失败"}
        </div>
      ) : null}

      {overview === null ? null : (
        <div className="lifeos-records-overview">
          <section>
            <div className="lifeos-records-heading">
              <strong>DSH Session</strong>
              <span data-state={dsh?.archived ? "archived" : "active"}>
                {dsh?.archived ? "已归档" : dsh?.persisted ? "已持久化" : "实时"}
              </span>
            </div>
            <dl>
              <div>
                <dt>标题</dt>
                <dd>{dsh?.title ?? "新会话"}</dd>
              </div>
              <div>
                <dt>身份</dt>
                <dd>{dsh?.header.id}</dd>
              </div>
              <div>
                <dt>事件</dt>
                <dd>{dsh?.eventCount ?? 0} 条</dd>
              </div>
              <div>
                <dt>创建</dt>
                <dd>{dateTime(dsh?.header.createdAt ?? null)}</dd>
              </div>
            </dl>
          </section>
          <section>
            <div className="lifeos-records-heading">
              <strong>Product Session</strong>
              <span data-state={chat?.status ?? "draft"}>
                {chat === null || chat === undefined
                  ? "首条消息后创建"
                  : chat.status === "active"
                    ? "进行中"
                    : "已归档"}
              </span>
            </div>
            <dl>
              <div>
                <dt>标题</dt>
                <dd>{chat?.title ?? "尚未建立"}</dd>
              </div>
              <div>
                <dt>身份</dt>
                <dd>{chat?.sessionId ?? "—"}</dd>
              </div>
              <div>
                <dt>请求</dt>
                <dd>{overview.binding.requestCount} 轮</dd>
              </div>
              <div>
                <dt>更新</dt>
                <dd>{dateTime(chat?.updatedAt ?? null)}</dd>
              </div>
            </dl>
          </section>
          <p className="lifeos-records-policy">
            {overview.capabilities.continueConversation
              ? "该会话可从原生侧栏重新打开并继续对话。"
              : "该会话当前不可继续发送消息。"}
            归档由 DSH
            原生会话菜单负责，只隐藏列表项；两侧完整记录都会保留。当前固定版本不提供永久删除，因此这里不会把归档伪装成删除。
          </p>
        </div>
      )}

      <div className="lifeos-records-tabs" role="tablist" aria-label="记录来源">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "chat"}
          onClick={() => setTab("chat")}
        >
          Chat 正式消息
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "dsh"}
          onClick={() => setTab("dsh")}
        >
          DSH 原始日志
        </button>
      </div>

      {tab === "chat" ? (
        <div className="lifeos-records-list" role="tabpanel" aria-label="Chat 正式消息">
          <SourceState
            status={state.chat.status}
            error={state.chat.error}
            empty={state.chat.items.length === 0}
          />
          {state.chat.items.map((item) => (
            <ChatMessageRecord key={item.message.messageId} item={item} />
          ))}
          {state.chat.error !== null && state.chat.items.length > 0 ? (
            <p className="lifeos-record-error">{state.chat.error}</p>
          ) : null}
          {state.chat.hasMore ? (
            <button
              type="button"
              className="lifeos-record-load-more"
              disabled={state.chat.status === "loading"}
              onClick={() => void loadMoreChat()}
            >
              {state.chat.status === "loading" ? "读取中…" : "继续读取 Chat 消息"}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="lifeos-records-list" role="tabpanel" aria-label="DSH 原始日志">
          <SourceState
            status={state.dsh.status}
            error={state.dsh.error}
            empty={state.dsh.items.length === 0}
          />
          {state.dsh.items.map((event) => (
            <details className="lifeos-event-record" key={event.seq}>
              <summary>
                <span>
                  <code>#{event.seq}</code>
                  <strong>{event.type}</strong>
                </span>
                <time dateTime={isoDateTime(event.time)}>{dateTime(event.time)}</time>
              </summary>
              <pre>{JSON.stringify(event, undefined, 2)}</pre>
            </details>
          ))}
          {state.dsh.error !== null && state.dsh.items.length > 0 ? (
            <p className="lifeos-record-error">{state.dsh.error}</p>
          ) : null}
          {state.dsh.hasMore ? (
            <button
              type="button"
              className="lifeos-record-load-more"
              disabled={state.dsh.status === "loading"}
              onClick={() => void loadMoreDsh()}
            >
              {state.dsh.status === "loading" ? "读取中…" : "继续读取 DSH 事件"}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
