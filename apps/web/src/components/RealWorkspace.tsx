import { useEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  type MessageDto,
  type PlanDto,
  type RunDto,
  type SubmitMessagePayload,
} from "@chat/contracts/public";
import { ApiProblemError } from "../api/client.js";
import { readDraft, writeDraft } from "../drafts/draft-store.js";
import { pendingSendPayload } from "../real/real-storage.js";
import type { RealChainState } from "../real/use-real-chain.js";
import { ContextPicker } from "./ContextPicker.js";
import { ChatMessageItem } from "./ChatMessageItem.js";
import { useProjectChain } from "../real/use-project-chain.js";
import { ProjectPanel } from "./ProjectPanel.js";
import { WorkflowRunPanel } from "./workflow/WorkflowRunPanel.js";
import { RunConfigPanel, WorkflowPicker, WorkflowRunSummary } from "./WorkflowComposer.js";
import { useRunConfigDraft } from "../workflow/use-run-config-draft.js";
import { NotesPanel } from "./NotesPanel.js";
import { WorkflowDesigner } from "../workflow-designer/WorkflowDesigner.js";
import { RulesPanel } from "./RulesPanel.js";

type ProjectChain = ReturnType<typeof useProjectChain>;

type ComposerMode = "task" | "project" | "advance" | "manage";
type MobilePane = "chat" | "work";
type WorkSurface = "workflow" | "run" | "project" | "notes" | "rules" | "designer";
type DragTarget = "navigation" | "work" | null;

interface WorkbenchLayoutPreference {
  readonly navigationOpen: boolean;
  readonly conversationOpen: boolean;
  readonly workOpen: boolean;
  readonly navigationWidth: number;
  readonly conversationWidth: number;
}

type WorkbenchStyle = CSSProperties & {
  "--real-navigation-track": string;
  "--real-navigation-divider": string;
  "--real-conversation-track": string;
  "--real-work-divider": string;
  "--real-work-track": string;
};

const WORKBENCH_LAYOUT_KEY = "chat:workbench-layout:v1";
const DEFAULT_WORKBENCH_LAYOUT: WorkbenchLayoutPreference = {
  navigationOpen: true,
  conversationOpen: true,
  workOpen: true,
  navigationWidth: 228,
  conversationWidth: 560,
};

const COMPOSER_MODE_LABEL: Record<ComposerMode, string> = {
  task: "推进任务",
  project: "建立项目",
  advance: "推进项目",
  manage: "管理项目",
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** 三栏开合和宽度只是本机界面偏好，不能写入Product Store或冒充产品事实。 */
function readWorkbenchLayout(storage: Storage): WorkbenchLayoutPreference {
  try {
    const raw = storage.getItem(WORKBENCH_LAYOUT_KEY);
    if (raw === null) return DEFAULT_WORKBENCH_LAYOUT;
    const value = JSON.parse(raw) as Partial<WorkbenchLayoutPreference>;
    return {
      navigationOpen:
        typeof value.navigationOpen === "boolean"
          ? value.navigationOpen
          : DEFAULT_WORKBENCH_LAYOUT.navigationOpen,
      conversationOpen:
        typeof value.conversationOpen === "boolean"
          ? value.conversationOpen
          : DEFAULT_WORKBENCH_LAYOUT.conversationOpen,
      workOpen:
        typeof value.workOpen === "boolean" ? value.workOpen : DEFAULT_WORKBENCH_LAYOUT.workOpen,
      navigationWidth:
        typeof value.navigationWidth === "number"
          ? clamp(value.navigationWidth, 200, 360)
          : DEFAULT_WORKBENCH_LAYOUT.navigationWidth,
      conversationWidth:
        typeof value.conversationWidth === "number"
          ? clamp(value.conversationWidth, 320, 760)
          : DEFAULT_WORKBENCH_LAYOUT.conversationWidth,
    };
  } catch {
    return DEFAULT_WORKBENCH_LAYOUT;
  }
}

function writeWorkbenchLayout(storage: Storage, value: WorkbenchLayoutPreference): void {
  try {
    storage.setItem(WORKBENCH_LAYOUT_KEY, JSON.stringify(value));
  } catch {
    // 浏览器偏好不可写时只影响本次页面，不改变任何正式状态。
  }
}

/**
 * 真实规划—确认—执行工作区（M3最小真实前端闭环）。
 *
 * 规则：
 * - 桌面使用会话导航 + 对话 + 多标签工作区三栏；每栏可以独立折叠。
 * - 760px以下使用导航抽屉 + “对话 / 工作”单表面切换。
 * - 正式Assistant Message只来自Message Query；不从超时、动画、
 *   Workflow返回值或本地状态猜测成功。
 * - Provider/模型由服务端Profile配置，浏览器不选择也不绑定具体实现。
 * - 发送失败保留草稿；Decision失败保留修改意见并展示recoveryAction。
 */

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

function useRealComposer(
  chain: RealChainState,
  sessionId: string,
  connected: boolean,
  projects: ProjectChain,
  onOpenWork: (surface: WorkSurface) => void,
) {
  const [draft, setDraft] = useState(() => readDraft(window.localStorage, sessionId));
  const [draftSelection, setDraftSelection] = useState<{
    readonly startUtf16: number;
    readonly endUtf16: number;
  } | null>(null);
  const [context, setContext] = useState<SubmitMessagePayload["context"]>(() =>
    chain.pendingSend === null ? undefined : pendingSendPayload(chain.pendingSend).context,
  );
  const [contextEditorOpen, setContextEditorOpen] = useState(false);
  const workflowDraft = useRunConfigDraft(window.localStorage, sessionId);
  const [workflowConfigBlocked, setWorkflowConfigBlocked] = useState(false);
  const [awaitingOutcome, setAwaitingOutcome] = useState(false);
  const [composerMode, setComposerMode] = useState<ComposerMode>("task");
  const [managementKind, setManagementKind] = useState<"action" | "decision" | "contribution">(
    "decision",
  );
  const [rootId, setRootId] = useState("");
  const sending = chain.sending;
  const projectRootId = rootId || projects.roots.data?.[0]?.rootId || "";
  const frozenPendingContext =
    chain.pendingSend === null ? undefined : pendingSendPayload(chain.pendingSend).context;
  const canSend =
    connected &&
    draft.trim().length > 0 &&
    !sending &&
    !projects.beginning &&
    !projects.beginningManagement &&
    !projects.beginningAdvancement &&
    chain.canStartNewRun &&
    !workflowConfigBlocked &&
    (composerMode === "task" ||
      (composerMode === "project" && projectRootId !== "") ||
      (composerMode === "advance" && projects.activeProjectId !== null) ||
      (composerMode === "manage" && projects.activeProjectId !== null));

  useEffect(() => {
    if (frozenPendingContext !== undefined) setContext(frozenPendingContext);
  }, [frozenPendingContext]);

  // 发送成功后才清空草稿；失败时草稿与commandId都保留供手动重试。
  useEffect(() => {
    if (!awaitingOutcome) return;
    if (chain.sendError !== null) {
      setAwaitingOutcome(false);
      return;
    }
    if (chain.pendingSend === null && !chain.sending) {
      setAwaitingOutcome(false);
      setDraft("");
      setDraftSelection(null);
      setContext(undefined);
      workflowDraft.clearDraft();
      writeDraft(window.localStorage, sessionId, "");
    }
  }, [
    awaitingOutcome,
    chain.pendingSend,
    chain.sendError,
    chain.sending,
    sessionId,
    workflowDraft,
  ]);

  function updateDraft(text: string) {
    setDraft(text);
    setDraftSelection(null);
    writeDraft(window.localStorage, sessionId, text);
  }

  function send() {
    if (!canSend) return;
    setContextEditorOpen(false);
    if (composerMode === "project") {
      projects.begin({ text: draft.trim(), rootId: projectRootId });
      updateDraft("");
      onOpenWork("project");
      return;
    }
    if (composerMode === "manage") {
      projects.beginManagement({ text: draft.trim(), kind: managementKind });
      updateDraft("");
      onOpenWork("project");
      return;
    }
    if (composerMode === "advance") {
      projects.beginAdvancement(draft.trim());
      updateDraft("");
      onOpenWork("project");
      return;
    }
    setAwaitingOutcome(true);
    chain.sendMessage(draft.trim(), context, workflowDraft.workflowSelection);
    onOpenWork("run");
  }

  function retrySend() {
    if (sending) return;
    setAwaitingOutcome(true);
    chain.retryPendingSend();
  }

  return {
    draft,
    draftSelection,
    setDraftSelection,
    context,
    setContext,
    contextEditorOpen,
    setContextEditorOpen,
    workflowDraft,
    workflowConfigBlocked,
    setWorkflowConfigBlocked,
    composerMode,
    setComposerMode,
    managementKind,
    setManagementKind,
    projectRootId,
    setRootId,
    sending,
    frozenPendingContext,
    canSend,
    updateDraft,
    send,
    retrySend,
  } as const;
}

type RealComposer = ReturnType<typeof useRealComposer>;

function RealChatPane({
  chain,
  connected,
  onOpenWork,
  navigationOpen,
  onOpenNavigation,
  onCloseConversation,
  projects,
  composer,
}: {
  chain: RealChainState;
  connected: boolean;
  onOpenWork: (surface: WorkSurface) => void;
  navigationOpen: boolean;
  onOpenNavigation: () => void;
  onCloseConversation: () => void;
  projects: ProjectChain;
  composer: RealComposer;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  const messages: readonly MessageDto[] = chain.messages.data?.items ?? [];
  const {
    draft,
    setDraftSelection,
    setContextEditorOpen,
    composerMode,
    sending,
    canSend,
    updateDraft,
    send,
    retrySend,
  } = composer;

  useEffect(() => {
    if (listRef.current !== null) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages.length]);

  return (
    <section className="pane chat-pane" aria-label="持续对话">
      <header className="pane-header">
        <div className="conversation-title-group">
          {!navigationOpen && (
            <button
              className="real-pane-inline-action"
              type="button"
              aria-expanded={false}
              aria-controls="real-session-navigation"
              onClick={onOpenNavigation}
            >
              打开导航
            </button>
          )}
          <div className="conversation-title-copy">
            <h2>规划</h2>
            <p>今天</p>
          </div>
        </div>
        <div className="conversation-header-actions">
          <button className="pane-button" aria-label="打开工作区" onClick={() => onOpenWork("run")}>
            打开工作
          </button>
          <button
            className="real-pane-inline-action"
            type="button"
            aria-label="收起对话区域"
            aria-expanded={true}
            onClick={onCloseConversation}
          >
            收起对话
          </button>
        </div>
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
              <h3>今天想推进什么？</h3>
              <p>说清目标或卡点，我会先给出计划，再和你一起推进。</p>
            </li>
          )}
          {messages.map((message) => (
            <ChatMessageItem
              key={message.messageId}
              message={message}
              chain={chain}
              backends={chain.memoryBackends.data ?? []}
            />
          ))}
        </ol>
      </div>
      <div className="composer">
        <div className="composer-inner">
          <button
            className="composer-configuration-trigger"
            type="button"
            aria-label={`打开工作配置，当前为${COMPOSER_MODE_LABEL[composerMode]}`}
            onClick={() => onOpenWork("workflow")}
          >
            <span>{COMPOSER_MODE_LABEL[composerMode]}</span>
            <span>工作配置</span>
          </button>
          <div className="composer-row">
            <textarea
              className="composer-input"
              aria-label="消息输入框"
              placeholder={
                composerMode === "project"
                  ? "描述项目目标、范围和当前诉求…"
                  : composerMode === "manage"
                    ? "用自然语言说明要记录的决定、待办或贡献…"
                    : composerMode === "advance"
                      ? "说清当前阶段目标、关键结果、健康判断和下一步…"
                      : "描述你要推进的事…"
              }
              rows={2}
              value={draft}
              onFocus={() => setContextEditorOpen(false)}
              onChange={(event) => updateDraft(event.target.value)}
              onSelect={(event) => {
                const { selectionStart, selectionEnd } = event.currentTarget;
                setDraftSelection(
                  selectionStart < selectionEnd
                    ? { startUtf16: selectionStart, endUtf16: selectionEnd }
                    : null,
                );
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <button className="send-button" aria-label="发送" disabled={!canSend} onClick={send}>
              {sending ||
              projects.beginning ||
              projects.beginningManagement ||
              projects.beginningAdvancement
                ? "发送中…"
                : composerMode === "project"
                  ? "生成建项方案"
                  : composerMode === "manage"
                    ? "生成管理方案"
                    : composerMode === "advance"
                      ? "生成推进方案"
                      : "发送"}
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

function WorkflowConfigurationPanel({
  chain,
  projects,
  composer,
}: {
  chain: RealChainState;
  projects: ProjectChain;
  composer: RealComposer;
}) {
  const {
    draft,
    draftSelection,
    context,
    setContext,
    contextEditorOpen,
    setContextEditorOpen,
    workflowDraft,
    workflowConfigBlocked,
    setWorkflowConfigBlocked,
    composerMode,
    setComposerMode,
    managementKind,
    setManagementKind,
    projectRootId,
    setRootId,
    sending,
    frozenPendingContext,
  } = composer;
  const disabled = sending || chain.pendingSend !== null || !chain.canStartNewRun;

  return (
    <section className="workflow-configuration-surface" aria-label="工作配置">
      <header>
        <div>
          <h3>开始工作</h3>
          <p>选择要推进的内容；其余设置沿用已发布工作流。</p>
        </div>
        <span className="model-fixed-label" aria-label="模型配置">
          自动模型
        </span>
      </header>
      <div className="composer-mode" role="group" aria-label="消息用途">
        {(Object.keys(COMPOSER_MODE_LABEL) as ComposerMode[]).map((mode) => (
          <button
            key={mode}
            className={composerMode === mode ? "small-button active" : "small-button"}
            onClick={() => setComposerMode(mode)}
            type="button"
            disabled={
              (mode === "advance" || mode === "manage") && projects.activeProjectId === null
            }
          >
            {COMPOSER_MODE_LABEL[mode]}
          </button>
        ))}
      </div>
      {composerMode === "task" ? (
        <>
          <WorkflowPicker
            value={workflowDraft.draft}
            disabled={disabled}
            onChange={workflowDraft.setDraft}
          />
          <details className="workflow-advanced-settings">
            <summary>
              <span>
                <strong>工作流步骤</strong>
                <small>节点、资源与审核方式</small>
              </span>
              <span>高级设置</span>
            </summary>
            <RunConfigPanel
              selection={workflowDraft.draft}
              messageText={draft}
              messageSelection={draftSelection}
              disabled={disabled}
              stale={
                String(chain.sendError?.code) === "definition_stale" ||
                String(chain.sendError?.code) === "resource_stale"
              }
              onChange={workflowDraft.setDraft}
              onBlockedChange={setWorkflowConfigBlocked}
            />
          </details>
          <ContextPicker
            backends={chain.memoryBackends.data ?? []}
            loading={chain.memoryBackends.isPending}
            disabled={disabled || workflowConfigBlocked}
            value={frozenPendingContext ?? context}
            onChange={setContext}
            expanded={contextEditorOpen}
            onExpandedChange={setContextEditorOpen}
          />
        </>
      ) : composerMode === "project" ? (
        <label className="project-root-picker">
          <span>真实项目资源</span>
          <select
            aria-label="项目资源"
            value={projectRootId}
            onChange={(event) => setRootId(event.target.value)}
          >
            {(projects.roots.data ?? []).map((root) => (
              <option key={root.rootId} value={root.rootId}>
                {root.displayName}
              </option>
            ))}
          </select>
        </label>
      ) : composerMode === "manage" ? (
        <label className="project-root-picker">
          <span>项目管理动作</span>
          <select
            aria-label="项目管理动作"
            value={managementKind}
            onChange={(event) =>
              setManagementKind(event.target.value as "action" | "decision" | "contribution")
            }
          >
            <option value="decision">记录决定</option>
            <option value="action">新增待办</option>
            <option value="contribution">记录贡献</option>
          </select>
        </label>
      ) : (
        <div className="model-fixed-label" aria-label="当前推进项目">
          当前项目：
          {(projects.projects.data ?? []).find(
            (item) => item.projectId === projects.activeProjectId,
          )?.name ?? "未选择"}
        </div>
      )}
      <p className="workflow-configuration-note">这些选择只用于下一条消息，发送前都可以更改。</p>
    </section>
  );
}

function RealSessionNavigation({
  projects,
  connected,
  onClose,
  onOpenWork,
}: {
  projects: ProjectChain;
  connected: boolean;
  onClose: () => void;
  onOpenWork: (surface: WorkSurface) => void;
}) {
  const activeProject = (projects.projects.data ?? []).find(
    (project) => project.projectId === projects.activeProjectId,
  );
  return (
    <aside className="real-session-navigation" id="real-session-navigation" aria-label="会话导航">
      <header>
        <div>
          <strong>Chat</strong>
          <span>{connected ? "随时可以开始" : "等待连接"}</span>
        </div>
        <button className="small-button" type="button" onClick={onClose} aria-label="收起会话导航">
          收起
        </button>
      </header>
      <nav aria-label="会话列表">
        <p className="real-navigation-label">今天</p>
        <button className="real-session-row active" type="button" aria-current="page">
          <strong>规划</strong>
          <span>刚刚</span>
        </button>
      </nav>
      <nav aria-label="项目列表">
        <p className="real-navigation-label">项目</p>
        {(projects.projects.data ?? []).length === 0 ? (
          <p className="real-navigation-empty">尚未建立项目</p>
        ) : (
          (projects.projects.data ?? []).map((project) => (
            <button
              key={project.projectId}
              className={
                project.projectId === projects.activeProjectId
                  ? "real-session-row active"
                  : "real-session-row"
              }
              type="button"
              onClick={() => {
                projects.chooseProject(project.projectId);
                onOpenWork("project");
              }}
            >
              <strong>{project.name}</strong>
              <span>
                {project.status === "active"
                  ? "进行中"
                  : project.status === "paused"
                    ? "已暂停"
                    : project.status === "completed"
                      ? "已完成"
                      : "已归档"}
              </span>
            </button>
          ))
        )}
      </nav>
      <div className="real-navigation-spacer" />
      <button
        className="real-navigation-shortcut"
        type="button"
        onClick={() => onOpenWork("workflow")}
      >
        <span>工作区</span>
        <small>流程、项目、笔记与规则</small>
      </button>
      {activeProject !== undefined && (
        <p className="real-navigation-current">当前项目：{activeProject.name}</p>
      )}
    </aside>
  );
}

function WorkSurfaceTabs({
  active,
  onSelect,
  onClose,
  conversationOpen,
  onOpenConversation,
}: {
  active: WorkSurface;
  onSelect: (surface: WorkSurface) => void;
  onClose: () => void;
  conversationOpen: boolean;
  onOpenConversation: () => void;
}) {
  const tabs: readonly { id: WorkSurface; label: string }[] = [
    { id: "workflow", label: "工作配置" },
    { id: "run", label: "运行" },
    { id: "project", label: "项目" },
    { id: "notes", label: "笔记" },
    { id: "rules", label: "规则" },
    { id: "designer", label: "设计器" },
  ];
  return (
    <div className="work-surface-tabbar">
      {!conversationOpen && (
        <button
          className="real-pane-inline-action work-open-conversation"
          type="button"
          onClick={onOpenConversation}
        >
          打开对话
        </button>
      )}
      <div className="work-surface-tabs" role="tablist" aria-label="工作区标签页">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={active === tab.id}
            className={active === tab.id ? "active" : ""}
            onClick={() => onSelect(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <button
        className="work-surface-close"
        type="button"
        aria-label="收起工作区"
        onClick={onClose}
      >
        收起
      </button>
    </div>
  );
}

export function RealWorkspace({ chain, connected }: { chain: RealChainState; connected: boolean }) {
  if (chain.bootstrapping) {
    return (
      <main className="workspace-view active" aria-label="规划工作台">
        <p className="loading-note">正在准备会话…</p>
      </main>
    );
  }
  if (chain.bootstrapError !== null || chain.sessionId === null) {
    return (
      <main className="workspace-view active" aria-label="规划工作台">
        <p className="error-note" role="alert">
          无法连接 Chat 服务创建真实会话。请确认服务已启动后刷新重试。
        </p>
      </main>
    );
  }

  return <RealWorkbench chain={chain} connected={connected} sessionId={chain.sessionId} />;
}

function RealWorkbench({
  chain,
  connected,
  sessionId,
}: {
  chain: RealChainState;
  connected: boolean;
  sessionId: string;
}) {
  const projects = useProjectChain(window.localStorage, sessionId);
  const [mobilePane, setMobilePane] = useState<MobilePane>("chat");
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [workSurface, setWorkSurface] = useState<WorkSurface>(() =>
    chain.activeRunId === null ? "workflow" : "run",
  );
  const [layout, setLayout] = useState<WorkbenchLayoutPreference>(() =>
    readWorkbenchLayout(window.localStorage),
  );
  const [dragTarget, setDragTarget] = useState<DragTarget>(null);
  const workbenchRef = useRef<HTMLDivElement>(null);
  const run = chain.run.data ?? null;
  const plans: readonly PlanDto[] = chain.plans.data ?? [];
  const approval = chain.approval.data ?? null;
  const runProblem = chain.run.error instanceof ApiProblemError ? chain.run.error : null;

  function openWork(surface: WorkSurface) {
    setWorkSurface(surface);
    setLayout((current) => ({ ...current, workOpen: true }));
    setMobilePane("work");
  }

  const composer = useRealComposer(chain, sessionId, connected, projects, openWork);

  useEffect(() => {
    writeWorkbenchLayout(window.localStorage, layout);
  }, [layout]);

  function closeConversation() {
    setLayout((current) => ({
      ...current,
      conversationOpen: false,
      workOpen: true,
    }));
  }

  function closeWork() {
    setLayout((current) => ({
      ...current,
      conversationOpen: true,
      workOpen: false,
    }));
    setMobilePane("chat");
  }

  function updateNavigationWidth(next: number) {
    setLayout((current) => ({ ...current, navigationWidth: clamp(next, 200, 360) }));
  }

  function updateConversationWidth(next: number) {
    const bounds = workbenchRef.current?.getBoundingClientRect();
    const usableWidth = bounds !== undefined && bounds.width > 0 ? bounds.width : 1_440;
    const maximum = Math.max(
      320,
      usableWidth - (layout.navigationOpen ? layout.navigationWidth + 7 : 0) - 360 - 7,
    );
    setLayout((current) => ({
      ...current,
      conversationWidth: clamp(next, 320, Math.min(760, maximum)),
    }));
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragTarget === null || workbenchRef.current === null) return;
    const bounds = workbenchRef.current.getBoundingClientRect();
    if (dragTarget === "navigation") {
      updateNavigationWidth(event.clientX - bounds.left);
      return;
    }
    updateConversationWidth(
      event.clientX - bounds.left - (layout.navigationOpen ? layout.navigationWidth + 7 : 0),
    );
  }

  function handleNavigationSplitterKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    updateNavigationWidth(layout.navigationWidth + (event.key === "ArrowLeft" ? -16 : 16));
  }

  function handleWorkSplitterKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    updateConversationWidth(layout.conversationWidth + (event.key === "ArrowLeft" ? -24 : 24));
  }

  const workbenchStyle: WorkbenchStyle = {
    "--real-navigation-track": layout.navigationOpen ? `${layout.navigationWidth}px` : "0px",
    "--real-navigation-divider": layout.navigationOpen ? "7px" : "0px",
    "--real-conversation-track": layout.conversationOpen
      ? layout.workOpen
        ? `${layout.conversationWidth}px`
        : "minmax(0, 1fr)"
      : "0px",
    "--real-work-divider": layout.conversationOpen && layout.workOpen ? "7px" : "0px",
    "--real-work-track": layout.workOpen ? "minmax(360px, 1fr)" : "0px",
  };

  return (
    <main className="workspace-view active session-view" aria-label="规划工作台">
      <div className="mobile-pane-tabs" role="tablist" aria-label="会话区域">
        <button
          className="mobile-navigation-trigger"
          type="button"
          aria-expanded={mobileNavigationOpen}
          aria-controls="real-session-navigation"
          onClick={() => setMobileNavigationOpen((current) => !current)}
        >
          导航
        </button>
        <button
          role="tab"
          aria-selected={mobilePane === "chat"}
          className={mobilePane === "chat" ? "active" : ""}
          onClick={() => {
            setLayout((current) => ({ ...current, conversationOpen: true }));
            setMobilePane("chat");
          }}
        >
          对话
        </button>
        <button
          role="tab"
          aria-selected={mobilePane === "work"}
          className={mobilePane === "work" ? "active" : ""}
          onClick={() => {
            setLayout((current) => ({ ...current, workOpen: true }));
            setMobilePane("work");
          }}
        >
          工作
        </button>
      </div>
      <div
        ref={workbenchRef}
        className="real-workbench-grid"
        style={workbenchStyle}
        data-mobile-pane={mobilePane}
        data-work-surface={workSurface}
        data-navigation-open={layout.navigationOpen}
        data-conversation-open={layout.conversationOpen}
        data-work-open={layout.workOpen}
        data-mobile-navigation-open={mobileNavigationOpen}
        onPointerMove={handlePointerMove}
        onPointerUp={() => setDragTarget(null)}
        onPointerCancel={() => setDragTarget(null)}
      >
        {(layout.navigationOpen || mobileNavigationOpen) && (
          <RealSessionNavigation
            connected={connected}
            projects={projects}
            onOpenWork={(surface) => {
              openWork(surface);
              setMobileNavigationOpen(false);
            }}
            onClose={() => {
              setLayout((current) => ({ ...current, navigationOpen: false }));
              setMobileNavigationOpen(false);
            }}
          />
        )}
        {layout.navigationOpen && (
          <div
            className="real-workbench-splitter navigation-splitter"
            role="separator"
            aria-label="调整会话导航宽度"
            aria-orientation="vertical"
            aria-valuemin={200}
            aria-valuemax={360}
            aria-valuenow={Math.round(layout.navigationWidth)}
            tabIndex={0}
            onKeyDown={handleNavigationSplitterKey}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              setDragTarget("navigation");
            }}
          />
        )}
        {layout.conversationOpen && (
          <div className="real-conversation-column">
            <RealChatPane
              chain={chain}
              connected={connected}
              onOpenWork={openWork}
              navigationOpen={layout.navigationOpen}
              onOpenNavigation={() =>
                setLayout((current) => ({ ...current, navigationOpen: true }))
              }
              onCloseConversation={closeConversation}
              projects={projects}
              composer={composer}
            />
          </div>
        )}
        {layout.conversationOpen && layout.workOpen && (
          <div
            className="real-workbench-splitter work-splitter"
            role="separator"
            aria-label="调整对话与工作区大小"
            aria-orientation="vertical"
            aria-valuemin={320}
            aria-valuemax={760}
            aria-valuenow={Math.round(layout.conversationWidth)}
            tabIndex={0}
            onKeyDown={handleWorkSplitterKey}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              setDragTarget("work");
            }}
          />
        )}
        {layout.workOpen && (
          <section className="pane work-pane" aria-label="工作窗口">
            <WorkSurfaceTabs
              active={workSurface}
              onSelect={openWork}
              onClose={closeWork}
              conversationOpen={layout.conversationOpen}
              onOpenConversation={() =>
                setLayout((current) => ({ ...current, conversationOpen: true }))
              }
            />
            <div
              className={`work-body real-work-body${workSurface === "designer" ? " designer-work-body" : ""}`}
            >
              {workSurface === "workflow" ? (
                <WorkflowConfigurationPanel chain={chain} projects={projects} composer={composer} />
              ) : workSurface === "designer" ? (
                <WorkflowDesigner />
              ) : workSurface === "rules" ? (
                <RulesPanel />
              ) : workSurface === "notes" ? (
                <NotesPanel sessionId={sessionId} />
              ) : workSurface === "project" ? (
                <ProjectPanel projects={projects} />
              ) : (
                <>
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
                      <WorkflowRunSummary productRunId={run.productRunId} />
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
                      <WorkflowRunPanel chain={chain} run={run} plans={plans} approval={approval} />
                    </>
                  )}
                </>
              )}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
