import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { Theme } from "../theme.js";
import type { ChatMessage, ModelOption } from "../viewmodel/chat-view-model.js";
import {
  SESSION_BY_ID,
  SESSION_FIXTURES,
  SESSION_GROUPS,
  WORKFLOW_NODES,
  type SessionFixture,
  type SessionId,
  type StatusTone,
  type WorkPanelId,
  type WorkflowNodeFixture,
} from "../viewmodel/workspace-view-model.js";
import { ModelSelector } from "./ModelSelector.js";

export type ConnectionState = "connecting" | "online" | "offline";
type WorkspaceId = "today" | SessionId;
type LayoutMode = "split" | "chat-only" | "work-only";
type MobilePane = "chat" | "work";

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: "连接中",
  online: "已连接",
  offline: "未连接",
};

const DEFAULT_CHAT_WIDTH: Record<SessionId, number> = {
  okr: 46,
  ppt: 46,
  code: 46,
  canvas: 46,
};

const DEFAULT_LAYOUT: Record<SessionId, LayoutMode> = {
  okr: "split",
  ppt: "split",
  code: "split",
  canvas: "split",
};

const DEFAULT_WORK_PANEL: Record<SessionId, WorkPanelId> = Object.fromEntries(
  SESSION_FIXTURES.map((session) => [session.id, session.initialWorkPanel]),
) as Record<SessionId, WorkPanelId>;

interface WorkspaceShellProps {
  connection: ConnectionState;
  theme: Theme;
  onToggleTheme: () => void;
  models: readonly ModelOption[];
  modelId: string;
  onModelChange: (modelId: string) => void;
  messagesBySession: Readonly<Record<SessionId, readonly ChatMessage[]>>;
  onSend: (sessionId: SessionId, text: string) => void;
}

function StatusBadge({ tone, children }: { tone: StatusTone; children: React.ReactNode }) {
  return (
    <span className="status-badge" data-tone={tone}>
      {children}
    </span>
  );
}

function GlobalRail({
  active,
  onToday,
  onSessions,
  onWork,
  onCalendar,
  onHide,
}: {
  active: WorkspaceId;
  onToday: () => void;
  onSessions: () => void;
  onWork: () => void;
  onCalendar: () => void;
  onHide: () => void;
}) {
  return (
    <nav className="global-rail" aria-label="全局导航">
      <div className="brand">Chat</div>
      <button
        className={active === "today" ? "global-nav-item active" : "global-nav-item"}
        onClick={onToday}
      >
        今日
      </button>
      <button
        className={active !== "today" ? "global-nav-item active" : "global-nav-item"}
        onClick={onSessions}
      >
        会话
      </button>
      <button className="global-nav-item" onClick={onWork}>
        工作
      </button>
      <button className="global-nav-item" onClick={onCalendar}>
        日历
      </button>
      <button className="global-nav-item" title="后续任务开放更多工作空间" onClick={onSessions}>
        更多
      </button>
      <div className="rail-spacer" />
      <button className="global-nav-item" onClick={onHide}>
        收起
      </button>
    </nav>
  );
}

function SessionRail({
  active,
  onOpen,
  onOpenSplit,
  onHide,
  onNew,
}: {
  active: WorkspaceId;
  onOpen: (id: SessionId) => void;
  onOpenSplit: (id: SessionId) => void;
  onHide: () => void;
  onNew: () => void;
}) {
  return (
    <aside className="session-rail" aria-label="会话列表">
      <header className="session-rail-header">
        <span className="session-rail-title">
          会话 <small>本地示例</small>
        </span>
        <div className="session-header-actions">
          <button className="small-button" onClick={onNew}>
            新建
          </button>
          <button className="small-button" onClick={onHide}>
            收起
          </button>
        </div>
      </header>
      <div className="session-list">
        {SESSION_GROUPS.map((group) => (
          <section className="session-section" key={group} aria-label={group}>
            <p className="session-section-label">{group}</p>
            {SESSION_FIXTURES.filter((session) => session.group === group).map((session) => (
              <div
                className={active === session.id ? "session-row active" : "session-row"}
                key={session.id}
              >
                <button
                  className="session-open"
                  aria-label={`打开会话 ${session.title}`}
                  onClick={() => onOpen(session.id)}
                >
                  <span className="session-title">{session.title}</span>
                  <span className="session-meta">{session.status}</span>
                </button>
                <button
                  className="session-open-side"
                  aria-label={`以默认并排布局打开 ${session.title}`}
                  onClick={() => onOpenSplit(session.id)}
                >
                  并排
                </button>
              </div>
            ))}
          </section>
        ))}
      </div>
    </aside>
  );
}

function TodayWorkspace({
  openSessions,
  onOpenSession,
}: {
  openSessions: readonly SessionId[];
  onOpenSession: (id: SessionId) => void;
}) {
  return (
    <main className="workspace-view active" aria-label="今日">
      <div className="today-scroll">
        <div className="today-content">
          <span className="eyebrow">工作空间 0 · 今日</span>
          <h1>从今日总览进入不同会话，每个会话恢复自己的工作台。</h1>
          <p className="today-lead">
            对话负责持续协作，工作流、PPT、代码和白板在对应会话中并排打开；切回来时继续原来的布局和工作窗口。
          </p>

          <div className="section-head">
            <h2>需要处理</h2>
            <span>1 项</span>
          </div>
          <button className="attention-card" onClick={() => onOpenSession("okr")}>
            <span>
              <span className="eyebrow">OKR整理 · 本地示例 · 17.5 秒前更新</span>
              <span className="attention-title">指标计算没有完成</span>
              <span className="attention-copy">
                进入会话后，可以一边继续对话，一边查看右侧运行图和失败节点。
              </span>
            </span>
            <StatusBadge tone="danger">失败 · 需要查看</StatusBadge>
          </button>

          <div className="today-grid">
            <article className="today-card">
              <h3>打开的工作空间</h3>
              <p>像窗口管理器一样快速切换，但不会把会话和底层运行混在一起。</p>
              <div className="mini-list">
                {openSessions.length === 0 ? (
                  <p>选择一个会话，它会出现在顶部工作空间条中。</p>
                ) : (
                  openSessions.map((id, index) => (
                    <button key={id} onClick={() => onOpenSession(id)}>
                      <span>
                        <strong>{SESSION_BY_ID[id].title}</strong>
                        <small>{SESSION_BY_ID[id].status}</small>
                      </span>
                      <span>空间 {index + 1}</span>
                    </button>
                  ))
                )}
              </div>
            </article>

            <article className="today-card">
              <h3>不同会话，不同工作台</h3>
              <p>同一套布局规则，右侧工作窗口按任务变化。</p>
              <div className="mini-list">
                {SESSION_FIXTURES.filter((session) => session.id !== "okr").map((session) => (
                  <button key={session.id} onClick={() => onOpenSession(session.id)}>
                    <span>
                      <strong>{session.title}</strong>
                      <small>对话 + {session.workTabs[0]?.label ?? "工作"}</small>
                    </span>
                    <span>打开</span>
                  </button>
                ))}
              </div>
            </article>

            <article className="today-card" id="today-calendar">
              <h3>今日日程</h3>
              <p>日历是跨会话入口，打开后仍进入关联会话的工作台。</p>
              <div className="schedule-list">
                <button onClick={() => onOpenSession("ppt")}>
                  <span>
                    <strong>产品周会</strong>
                    <small>15:00–16:00</small>
                  </span>
                  <span>关联 PPT 会话</span>
                </button>
                <button onClick={() => onOpenSession("okr")}>
                  <span>
                    <strong>复盘本季度 KR</strong>
                    <small>17:30</small>
                  </span>
                  <span>关联 OKR 会话</span>
                </button>
              </div>
            </article>

            <article className="today-card">
              <h3>Agent 动态</h3>
              <p>动态只汇总能够追溯到会话、运行或产物的变化。</p>
              <div className="activity-item">
                <strong>研究助手整理了 7 条 OKR 资料</strong>
                <small>来自“整理季度 OKR 进展” · 本地示例</small>
              </div>
            </article>
          </div>
        </div>
      </div>
    </main>
  );
}

function ChatPane({
  session,
  messages,
  models,
  modelId,
  onModelChange,
  onSend,
  onFocusWork,
  onHide,
}: {
  session: SessionFixture;
  messages: readonly ChatMessage[];
  models: readonly ModelOption[];
  modelId: string;
  onModelChange: (modelId: string) => void;
  onSend: (text: string) => void;
  onFocusWork: () => void;
  onHide: () => void;
}) {
  const [draft, setDraft] = useState("");
  const canSend = draft.trim().length > 0;

  function send() {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  }

  return (
    <section className="pane chat-pane" aria-label="持续对话">
      <header className="pane-header">
        <div>
          <h2>{session.title}</h2>
          <p>会话保持打开 · {session.status}</p>
        </div>
        <button className="pane-button" onClick={onHide}>
          收起对话
        </button>
      </header>
      <div className="chat-stream">
        <ol className="chat-message-list">
          {messages.map((message) => (
            <li className="chat-message" data-role={message.role} key={message.id}>
              {message.role === "assistant" && <span className="message-author">Assistant</span>}
              <div className="message-bubble">{message.text}</div>
              {message.localOnly && <small className="message-local">本地预览 · 未发送</small>}
            </li>
          ))}
        </ol>
        <button
          className="current-work-card"
          aria-label={`在当前会话中聚焦工作 ${session.currentWorkTitle}`}
          onClick={onFocusWork}
        >
          <span className="eyebrow">当前工作</span>
          <span className="current-work-row">
            <span>
              <strong>{session.currentWorkTitle}</strong>
              <small>{session.currentWorkSummary}</small>
            </span>
            <StatusBadge tone={session.tone}>
              {session.tone === "danger" ? "失败" : "进行中"}
            </StatusBadge>
          </span>
        </button>
      </div>
      <div className="composer">
        <div className="composer-inner">
          <ModelSelector models={models} value={modelId} onChange={onModelChange} />
          <div className="composer-row">
            <textarea
              className="composer-input"
              aria-label="消息输入框"
              placeholder="继续这个会话…"
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
            <button className="send-button" aria-label="发送" disabled={!canSend} onClick={send}>
              发送
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function drawWorkflow(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const drawingContext = context;
  const styles = getComputedStyle(canvas);
  drawingContext.clearRect(0, 0, canvas.width, canvas.height);
  drawingContext.strokeStyle = styles.getPropertyValue("--text-tertiary").trim();
  drawingContext.globalAlpha = 0.48;
  drawingContext.lineWidth = 1.25;

  const nodeById = Object.fromEntries(WORKFLOW_NODES.map((node) => [node.id, node]));
  function node(id: string) {
    const value = nodeById[id];
    if (!value) throw new Error(`missing workflow node ${id}`);
    return value;
  }
  function curve(from: WorkflowNodeFixture, to: WorkflowNodeFixture) {
    const startX = from.x + 56;
    const startY = from.y + 82;
    const endX = to.x + 56;
    const endY = to.y;
    const middleY = startY + (endY - startY) / 2;
    drawingContext.beginPath();
    drawingContext.moveTo(startX, startY);
    drawingContext.bezierCurveTo(startX, middleY, endX, middleY, endX, endY);
    drawingContext.stroke();
  }
  curve(node("receive"), node("plan"));
  curve(node("plan"), node("research"));
  curve(node("plan"), node("metrics"));
  curve(node("research"), node("summarize"));
  curve(node("metrics"), node("summarize"));
  curve(node("summarize"), node("commit"));
  drawingContext.globalAlpha = 1;
}

function WorkflowRunView({
  session,
  theme,
  selectedNodeId,
  onSelectNode,
}: {
  session: SessionFixture;
  theme: Theme;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (canvasRef.current) drawWorkflow(canvasRef.current);
  }, [theme]);
  const selectedNode = WORKFLOW_NODES.find((node) => node.id === selectedNodeId) ?? null;

  return (
    <div className="workflow-run-view">
      <header className="work-summary">
        <div>
          <h3>{session.currentWorkTitle}</h3>
          <p>4 / 6 个步骤已结束 · 本地示例数据</p>
        </div>
        <StatusBadge tone={session.tone}>
          {session.tone === "danger" ? "失败" : "进行中"}
        </StatusBadge>
      </header>
      <div className="graph-scroll">
        <div className="graph-stage">
          <canvas ref={canvasRef} width="520" height="620" aria-hidden="true" />
          <span className="graph-branch-label">并行处理</span>
          {WORKFLOW_NODES.map((node) => (
            <button
              className="workflow-node"
              data-tone={node.tone}
              key={node.id}
              style={{ left: node.x, top: node.y }}
              aria-label={`${node.title}，${node.status}，点击查看详情`}
              onClick={() => onSelectNode(node.id)}
            >
              <span>{node.step}</span>
              <strong>{node.title}</strong>
              <span className="node-meta">
                <StatusBadge tone={node.tone}>{node.status}</StatusBadge>
                <small>{node.duration}</small>
              </span>
            </button>
          ))}
        </div>
      </div>
      {selectedNode && (
        <aside className="node-inspector" aria-label={`${selectedNode.title}详情`}>
          <header>
            <div>
              <h3>{selectedNode.title}</h3>
              <p>
                {selectedNode.step} · {selectedNode.duration}
              </p>
            </div>
            <button className="pane-button" onClick={() => onSelectNode(null)}>
              关闭
            </button>
          </header>
          <StatusBadge tone={selectedNode.tone}>{selectedNode.status}</StatusBadge>
          <dl>
            <div>
              <dt>这一步要做什么</dt>
              <dd>{selectedNode.details.purpose}</dd>
            </div>
            <div>
              <dt>使用的信息</dt>
              <dd>{selectedNode.details.source}</dd>
            </div>
            <div>
              <dt>可见结果</dt>
              <dd>{selectedNode.details.result}</dd>
            </div>
            <div>
              <dt>接下来</dt>
              <dd>{selectedNode.details.next}</dd>
            </div>
          </dl>
        </aside>
      )}
    </div>
  );
}

function SlideWorkView() {
  return (
    <div className="document-surface">
      <article className="slide-page">
        <span className="eyebrow">第 1 页 · 产品周会</span>
        <h3>本周完成核心流程验证，下一步进入真实数据闭环。</h3>
        <p>这份幻灯片与当前会话保持关联，你可以继续在左侧要求修改结构、措辞或内容。</p>
        <div className="slide-points">
          <section>
            <strong>已完成</strong>
            <span>工程骨架与首版界面</span>
          </section>
          <section>
            <strong>正在推进</strong>
            <span>Workflow 运行看护</span>
          </section>
          <section>
            <strong>下一步</strong>
            <span>PWA 与服务端消息</span>
          </section>
        </div>
      </article>
    </div>
  );
}

function CodeWorkView() {
  return (
    <div className="code-surface">
      <header>
        <span>apps/api/src/auth/session.ts</span>
        <StatusBadge tone="warning">2 个问题</StatusBadge>
      </header>
      <pre>
        <code>{`export async function refreshSession(token: string) {
  const session = await provider.refresh(token);

  // 结果未知时不能直接再次请求
  if (!session) return retryRefresh(token);

  return session;
}`}</code>
      </pre>
      <article className="code-note">
        <strong>需要确认</strong>
        <p>
          Provider 已收到请求但响应丢失时，直接重试可能生成第二个会话。应先查询或进入结果未知状态。
        </p>
      </article>
    </div>
  );
}

function CanvasWorkView() {
  return (
    <div className="canvas-surface">
      <div className="canvas-board" aria-label="产品方向白板，本地示例">
        <article>
          <span className="eyebrow">用户价值</span>
          <strong>让一件事可以持续推进</strong>
          <p>不只回答一轮，而是保留目标、状态和结果。</p>
        </article>
        <article>
          <span className="eyebrow">产品边界</span>
          <strong>Chat 拥有正式事实</strong>
          <p>运行时负责执行，不替代会话、决定与结果。</p>
        </article>
        <article>
          <span className="eyebrow">工作空间</span>
          <strong>会话与工作并排</strong>
          <p>同一会话可以看护工作流、PPT、代码或白板。</p>
        </article>
        <article>
          <span className="eyebrow">长期能力</span>
          <strong>恢复、证据与治理</strong>
          <p>失败不会产生假成功，重要动作需要用户决定。</p>
        </article>
      </div>
    </div>
  );
}

function ResultWorkView({ session }: { session: SessionFixture }) {
  return (
    <div className="result-surface">
      <span className="eyebrow">当前产物 · 本地示例</span>
      <h3>{session.currentWorkTitle}</h3>
      <p>{session.currentWorkSummary}</p>
      <section>
        <strong>当前边界</strong>
        <p>这只是用于验证界面布局的候选内容，还没有由服务端保存为正式结果。</p>
      </section>
    </div>
  );
}

function WorkContent({
  session,
  panel,
  theme,
  selectedNodeId,
  onSelectNode,
}: {
  session: SessionFixture;
  panel: WorkPanelId;
  theme: Theme;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
}) {
  if (panel === "run")
    return (
      <WorkflowRunView
        session={session}
        theme={theme}
        selectedNodeId={selectedNodeId}
        onSelectNode={onSelectNode}
      />
    );
  if (panel === "slides") return <SlideWorkView />;
  if (panel === "code" || panel === "review") return <CodeWorkView />;
  if (panel === "canvas") return <CanvasWorkView />;
  return <ResultWorkView session={session} />;
}

function WorkPane({
  session,
  activePanel,
  theme,
  layout,
  detached,
  selectedNodeId,
  onSelectPanel,
  onSelectNode,
  onToggleMax,
  onHide,
}: {
  session: SessionFixture;
  activePanel: WorkPanelId;
  theme: Theme;
  layout: LayoutMode;
  detached?: boolean;
  selectedNodeId: string | null;
  onSelectPanel: (panel: WorkPanelId) => void;
  onSelectNode: (id: string | null) => void;
  onToggleMax: () => void;
  onHide: () => void;
}) {
  return (
    <section className="pane work-pane" aria-label="工作窗口">
      <header className="work-toolbar">
        <nav className="work-tabs" aria-label="工作窗口标签">
          {session.workTabs.map((tab) => (
            <button
              className={activePanel === tab.id ? "work-tab active" : "work-tab"}
              key={tab.id}
              onClick={() => onSelectPanel(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        {!detached && (
          <div className="work-actions">
            <button className="pane-button" onClick={onToggleMax}>
              {layout === "work-only" ? "还原" : "最大化"}
            </button>
            <a
              className="detach-link"
              href={`?detached=${session.id}&panel=${activePanel}`}
              target="_blank"
              rel="noreferrer"
            >
              独立打开
            </a>
            <button className="pane-button" onClick={onHide}>
              收起工作
            </button>
          </div>
        )}
      </header>
      <div className="work-body">
        <WorkContent
          session={session}
          panel={activePanel}
          theme={theme}
          selectedNodeId={selectedNodeId}
          onSelectNode={onSelectNode}
        />
      </div>
    </section>
  );
}

export function WorkspaceShell({
  connection,
  theme,
  onToggleTheme,
  models,
  modelId,
  onModelChange,
  messagesBySession,
  onSend,
}: WorkspaceShellProps) {
  const detachedQuery = useMemo(() => new URLSearchParams(window.location.search), []);
  const detachedSessionValue = detachedQuery.get("detached");
  const detachedSession = SESSION_FIXTURES.find((session) => session.id === detachedSessionValue);
  const detachedPanelValue = detachedQuery.get("panel") as WorkPanelId | null;
  const detachedPanel = detachedSession?.workTabs.some((tab) => tab.id === detachedPanelValue)
    ? detachedPanelValue
    : detachedSession?.initialWorkPanel;

  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceId>("today");
  const [openSessions, setOpenSessions] = useState<readonly SessionId[]>([]);
  const [globalOpen, setGlobalOpen] = useState(true);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [mobileSessionsOpen, setMobileSessionsOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<MobilePane>("chat");
  const [chatWidths, setChatWidths] = useState(DEFAULT_CHAT_WIDTH);
  const [layouts, setLayouts] = useState(DEFAULT_LAYOUT);
  const [activePanels, setActivePanels] = useState<Record<SessionId, WorkPanelId>>(() =>
    detachedSession && detachedPanel
      ? { ...DEFAULT_WORK_PANEL, [detachedSession.id]: detachedPanel }
      : DEFAULT_WORK_PANEL,
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const sessionGridRef = useRef<HTMLDivElement>(null);

  if (detachedSession && detachedPanel) {
    return (
      <div className="workspace-app detached">
        <WorkPane
          session={detachedSession}
          activePanel={activePanels[detachedSession.id]}
          theme={theme}
          layout="work-only"
          detached
          selectedNodeId={selectedNodeId}
          onSelectPanel={(panel) =>
            setActivePanels((current) => ({ ...current, [detachedSession.id]: panel }))
          }
          onSelectNode={setSelectedNodeId}
          onToggleMax={() => undefined}
          onHide={() => undefined}
        />
      </div>
    );
  }

  const activeSession = activeWorkspace === "today" ? null : SESSION_BY_ID[activeWorkspace];

  function openSession(id: SessionId, resetLayout = false) {
    setOpenSessions((current) => (current.includes(id) ? current : [...current, id]));
    if (resetLayout) setLayouts((current) => ({ ...current, [id]: "split" }));
    setActiveWorkspace(id);
    setMobilePane("chat");
    setMobileSessionsOpen(false);
    setSelectedNodeId(null);
  }

  function updateActiveLayout(mode: LayoutMode) {
    if (!activeSession) return;
    setLayouts((current) => ({ ...current, [activeSession.id]: mode }));
  }

  function updateChatWidth(next: number) {
    if (!activeSession) return;
    const clamped = Math.min(68, Math.max(32, next));
    setChatWidths((current) => ({ ...current, [activeSession.id]: clamped }));
  }

  function handleSplitterKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!activeSession) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      updateChatWidth(chatWidths[activeSession.id] - 4);
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      updateChatWidth(chatWidths[activeSession.id] + 4);
    }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging || !sessionGridRef.current) return;
    const bounds = sessionGridRef.current.getBoundingClientRect();
    updateChatWidth(((event.clientX - bounds.left) / bounds.width) * 100);
  }

  function focusCalendar() {
    setActiveWorkspace("today");
    window.requestAnimationFrame(() =>
      document.getElementById("today-calendar")?.scrollIntoView({ block: "center" }),
    );
  }

  function focusCurrentWork() {
    if (activeSession) {
      setActivePanels((current) => ({ ...current, [activeSession.id]: "run" }));
      updateActiveLayout("split");
      setMobilePane("work");
      return;
    }
    openSession("okr");
  }

  const layout = activeSession ? layouts[activeSession.id] : "split";
  const chatWidth = activeSession ? chatWidths[activeSession.id] : 46;

  return (
    <div
      className={`workspace-app${globalOpen ? "" : " global-closed"}${sessionsOpen ? "" : " sessions-closed"}${mobileSessionsOpen ? " mobile-sessions-open" : ""}`}
      data-mobile-pane={mobilePane}
    >
      <GlobalRail
        active={activeWorkspace}
        onToday={() => setActiveWorkspace("today")}
        onSessions={() => {
          setSessionsOpen(true);
          setMobileSessionsOpen(true);
        }}
        onWork={focusCurrentWork}
        onCalendar={focusCalendar}
        onHide={() => setGlobalOpen(false)}
      />
      <SessionRail
        active={activeWorkspace}
        onOpen={openSession}
        onOpenSplit={(id) => openSession(id, true)}
        onHide={() => {
          setSessionsOpen(false);
          setMobileSessionsOpen(false);
        }}
        onNew={() => openSession("canvas", true)}
      />

      <section className="workspace-stage">
        <header className="workspace-bar">
          <div className="rail-controls">
            {!globalOpen && (
              <button className="bar-button" onClick={() => setGlobalOpen(true)}>
                导航
              </button>
            )}
            {!sessionsOpen && (
              <button className="bar-button" onClick={() => setSessionsOpen(true)}>
                会话列表
              </button>
            )}
          </div>
          <nav className="workspace-tabs" aria-label="打开的工作空间">
            <button
              className={activeWorkspace === "today" ? "workspace-tab active" : "workspace-tab"}
              aria-label="切换到工作空间 0 今日"
              onClick={() => setActiveWorkspace("today")}
            >
              0 今日
            </button>
            {openSessions.map((id, index) => (
              <button
                className={activeWorkspace === id ? "workspace-tab active" : "workspace-tab"}
                aria-label={`切换到工作空间 ${index + 1} ${SESSION_BY_ID[id].spaceLabel}`}
                key={id}
                onClick={() => openSession(id)}
              >
                {index + 1} {SESSION_BY_ID[id].spaceLabel}
              </button>
            ))}
          </nav>
          <div className="layout-controls">
            {activeSession && (
              <button
                className="bar-button"
                onClick={() => {
                  updateActiveLayout("split");
                  setMobilePane("chat");
                }}
              >
                {layout === "work-only" ? "显示对话" : "对话已显示"}
              </button>
            )}
            {activeSession && (
              <button
                className="bar-button"
                onClick={() => {
                  updateActiveLayout("split");
                  setMobilePane("work");
                }}
              >
                {layout === "chat-only" ? "显示工作" : "工作已显示"}
              </button>
            )}
          </div>
          <div className="bar-actions">
            <span className="connection-status" data-state={connection}>
              <span className="connection-dot" aria-hidden="true" />
              {CONNECTION_LABEL[connection]}
            </span>
            <button
              className="bar-button"
              aria-label={theme === "light" ? "切换到深色主题" : "切换到浅色主题"}
              onClick={onToggleTheme}
            >
              {theme === "light" ? "深色" : "浅色"}
            </button>
          </div>
        </header>

        <div className="workspace-deck">
          {activeWorkspace === "today" ? (
            <TodayWorkspace openSessions={openSessions} onOpenSession={openSession} />
          ) : activeSession ? (
            <main className="workspace-view active session-view" aria-label="会话工作空间">
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
              <div
                className={`session-grid layout-${layout}`}
                ref={sessionGridRef}
                style={{ "--chat-size": `${chatWidth}%` } as CSSProperties}
              >
                <ChatPane
                  session={activeSession}
                  messages={messagesBySession[activeSession.id]}
                  models={models}
                  modelId={modelId}
                  onModelChange={onModelChange}
                  onSend={(text) => onSend(activeSession.id, text)}
                  onFocusWork={focusCurrentWork}
                  onHide={() => updateActiveLayout("work-only")}
                />
                <div
                  className="splitter"
                  role="separator"
                  aria-label="调整对话与工作区域大小"
                  aria-orientation="vertical"
                  aria-valuemin={32}
                  aria-valuemax={68}
                  aria-valuenow={Math.round(chatWidth)}
                  tabIndex={0}
                  onKeyDown={handleSplitterKey}
                  onPointerDown={(event) => {
                    setDragging(true);
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }}
                  onPointerMove={handlePointerMove}
                  onPointerUp={() => setDragging(false)}
                  onPointerCancel={() => setDragging(false)}
                />
                <WorkPane
                  session={activeSession}
                  activePanel={activePanels[activeSession.id]}
                  theme={theme}
                  layout={layout}
                  selectedNodeId={selectedNodeId}
                  onSelectPanel={(panel) => {
                    setActivePanels((current) => ({ ...current, [activeSession.id]: panel }));
                    setSelectedNodeId(null);
                  }}
                  onSelectNode={setSelectedNodeId}
                  onToggleMax={() =>
                    updateActiveLayout(layout === "work-only" ? "split" : "work-only")
                  }
                  onHide={() => updateActiveLayout("chat-only")}
                />
              </div>
            </main>
          ) : null}
        </div>
      </section>

      <nav className="mobile-nav" aria-label="手机主导航">
        <button
          className={activeWorkspace === "today" ? "active" : ""}
          onClick={() => {
            setActiveWorkspace("today");
            setMobileSessionsOpen(false);
          }}
        >
          今日
        </button>
        <button onClick={() => setMobileSessionsOpen(true)}>会话</button>
        <button
          className={activeWorkspace !== "today" && mobilePane === "work" ? "active" : ""}
          onClick={focusCurrentWork}
        >
          当前工作
        </button>
      </nav>
    </div>
  );
}
