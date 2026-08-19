import { useEffect, useState } from "react";
import { Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { HostObservable, InjectFace, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { DshContextInjectionItem, DshContextInjectionProjection } from "../contracts.ts";
import type { LifeosClientState } from "./controller.ts";

export interface ContextInjectionManagerInjected {
  hooks: { lifeos: HostObservable<LifeosClientState> };
  loadContextInjections: () => Promise<DshContextInjectionProjection | null>;
}

export type ContextInjectionManagerProps = PropsRuntime<"conversation.input.left"> &
  InjectFace<ContextInjectionManagerInjected>;

const FORM_LABEL: Record<NonNullable<DshContextInjectionItem["form"]>, string> = {
  instructions: "指令",
  catalog: "目录",
  snapshot: "快照",
  notice: "通知",
  relay: "转交",
  recall: "召回",
};

function sourceTitle(item: DshContextInjectionItem): string {
  if (item.sourceKind === "agent-instructions") return "工作区指令";
  if (item.sourceKind === "skill-catalog") return "Skill 目录";
  if (item.sourceKind === "skill-invocation") {
    return item.sourceName === null ? "Skill 指令" : `Skill：${item.sourceName}`;
  }
  if (item.sourceKind === "plugin" && item.sourceName === "@deepseek-ai/dsh-system-prompt") {
    return "运行时上下文";
  }
  return item.sourceName ?? item.sourceKind;
}

function characterCount(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function ContextIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <path
        d="M3.25 3.25h9.5v9.5h-9.5zM5.25 5.5h5.5M5.25 8h5.5M5.25 10.5h3.25"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * 只读管理面板展示 DSH Session surface 当前会送给模型的生产者上下文。
 * 它不编辑上游状态，也明确区分 DSH 模型输入与 Chat Workflow 的用户消息输入。
 */
export function ContextInjectionManager({
  useLifeos,
  useSession,
  loadContextInjections,
}: ContextInjectionManagerProps) {
  const state = useLifeos((value) => value);
  const sessionChange = useSession(
    (snapshot) => `${snapshot.nodes.length}:${snapshot.running ? 1 : 0}:${snapshot.blank ? 1 : 0}`,
  );
  const [open, setOpen] = useState(false);
  const projection = state.contextInjections;

  useEffect(() => {
    if (open) void loadContextInjections();
  }, [open, sessionChange, loadContextInjections]);

  const countLabel = projection === null ? null : projection.totalItems;
  const buttonLabel =
    countLabel === null ? "查看上下文注入" : `查看上下文注入，共 ${countLabel} 项`;

  return (
    <>
      <button
        type="button"
        className="lifeos-context-toggle"
        data-testid="lifeos-context-injections-open"
        aria-label={buttonLabel}
        title={buttonLabel}
        onClick={() => setOpen(true)}
      >
        <ContextIcon />
        <span>上下文</span>
        {countLabel === null ? null : (
          <span className="lifeos-context-count" aria-hidden="true">
            {countLabel}
          </span>
        )}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="上下文注入"
        closeLabel="关闭上下文注入"
        description="这里展示 DSH 下一次模型请求仍会携带的生产者上下文；LifeOS Workflow 接收最新用户输入和当前 Workspace 指令。"
        className="lifeos-context-modal"
        contentClassName="lifeos-context-modal-content"
        footer={
          <div className="lifeos-context-footer">
            <span>只读 · 仅 Workspace 指令进入 Chat 规划上下文</span>
            <button
              type="button"
              data-testid="lifeos-context-injections-refresh"
              disabled={state.contextInjectionsLoading}
              onClick={() => void loadContextInjections()}
            >
              {state.contextInjectionsLoading ? "正在刷新…" : "刷新"}
            </button>
          </div>
        }
      >
        <section className="lifeos-context-manager" data-testid="lifeos-context-injections">
          {projection === null && state.contextInjectionsLoading ? (
            <p className="lifeos-context-empty">正在读取 DSH 当前上下文…</p>
          ) : null}
          {state.contextInjectionsError === null ? null : (
            <p className="lifeos-error" role="alert" data-testid="lifeos-context-injections-error">
              {state.contextInjectionsError}
            </p>
          )}
          {projection?.status === "not_assembled" ? (
            <div className="lifeos-context-empty" data-testid="lifeos-context-not-assembled">
              <strong>尚未组装</strong>
              <p>
                首次发送消息时，DSH 才会按当时的工作区指令、权限和 Skill
                生成真实上下文快照。之后每个模型步骤都会重新检查变化。
              </p>
            </div>
          ) : null}
          {projection?.status === "ready" && projection.totalItems === 0 ? (
            <div className="lifeos-context-empty">
              <strong>当前没有生产者上下文</strong>
              <p>会话已经完成过上下文组装，但下一次模型请求目前没有额外注入项。</p>
            </div>
          ) : null}
          {projection !== null && projection.totalItems > 0 ? (
            <>
              <div className="lifeos-context-summary">
                <strong>{projection.totalItems} 项上下文</strong>
                <span>{characterCount(projection.totalContentCharacters)} 字符</span>
              </div>
              {projection.omittedItems > 0 ? (
                <p className="lifeos-warning">
                  当前响应为保护页面性能省略了较早的 {projection.omittedItems} 项。
                </p>
              ) : null}
              <div className="lifeos-context-list">
                {projection.items.map((item) => (
                  <details className="lifeos-context-item" key={item.messageId}>
                    <summary>
                      <span className="lifeos-context-item-title">{sourceTitle(item)}</span>
                      <span className="lifeos-context-item-meta">
                        {item.form === null ? "未声明类型" : FORM_LABEL[item.form]} ·{" "}
                        {characterCount(item.contentCharacters)} 字符
                      </span>
                    </summary>
                    <div className="lifeos-context-source">
                      <code>{item.sourceKind}</code>
                      {item.sourceDetails.map((detail) => (
                        <span key={detail}>{detail}</span>
                      ))}
                      {item.sourceDetailsTruncated ? <span>更多来源已省略</span> : null}
                    </div>
                    <pre>{item.text === "" ? "（没有可展示的文本块）" : item.text}</pre>
                    {item.truncated ? (
                      <p className="lifeos-warning">正文超过展示上限，当前只显示前部内容。</p>
                    ) : null}
                    {item.unsupportedContentBlockCount > 0 ? (
                      <p className="lifeos-warning">
                        另有 {item.unsupportedContentBlockCount} 个非文本内容块未在此面板展开。
                      </p>
                    ) : null}
                  </details>
                ))}
              </div>
            </>
          ) : null}
        </section>
      </Modal>
    </>
  );
}
