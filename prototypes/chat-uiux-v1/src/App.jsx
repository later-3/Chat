import { useMemo, useState } from "react";
import {
  ArrowRight,
  Bot,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  Clock3,
  Code2,
  Command,
  Cpu,
  Database,
  Eye,
  FileText,
  FolderKanban,
  GitBranch,
  Home,
  Info,
  Layers3,
  Lightbulb,
  ListTree,
  MessageCircle,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Plus,
  Save,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sprout,
  UserRound,
  Workflow,
  X,
} from "lucide-react";

const NAV_ITEMS = [
  { id: "home", label: "主页", icon: Home },
  { id: "chat", label: "对话", icon: MessageCircle },
  { id: "workflow", label: "运行", icon: Workflow },
  { id: "approval", label: "审批", icon: ShieldCheck, badge: 1 },
];

const CONTEXT_OPTIONS = [
  { id: "project", label: "书签 API", type: "Project", icon: FolderKanban, tone: "teal" },
  { id: "rule", label: "文档必须有 metadata", type: "规则", icon: ShieldCheck, tone: "coral" },
  { id: "file", label: "README.md", type: "文件", icon: FileText, tone: "blue" },
  { id: "experience", label: "API 验证经验", type: "经验", icon: Sparkles, tone: "yellow" },
];

const WORKFLOW_NODES = [
  {
    id: "input_acceptance",
    label: "接纳用户输入",
    kind: "确定性 Executor",
    status: "done",
    input: "给书签 API 补充权限校验，并验证旧接口不受影响。",
    output: "User Message 已保存；Product Run 已创建。",
    reason: "任何模型或工具运行前，先保存用户输入和本轮身份。",
  },
  {
    id: "context_selection",
    label: "组装有效上下文",
    kind: "Context Executor",
    status: "done",
    input: "显式选择：书签 API、README.md、文档规则、API 验证经验。",
    output: "采用 4 个来源，估算 3,280 tokens；完整历史未默认加入。",
    reason: "只采用与本轮目标直接相关且用户可见的有界上下文。",
  },
  {
    id: "intent_recognition",
    label: "识别本轮意图",
    kind: "Governed Agent",
    status: "done",
    input: "用户消息 + 主题摘要 + Project/Work 目录。",
    output: "场景：continue_project；目标：继续书签 API；置信度 0.94。",
    reason: "识别到已有 Project 和明确改动目标，不需要创建新项目。",
  },
  {
    id: "scenario_router",
    label: "选择执行分支",
    kind: "MAF 选择节点",
    status: "done",
    input: "scenario=continue_project；needs_plan=true；project=书签 API。",
    output: "命中「继续 Project」分支。",
    reason: "按声明顺序求值，第一条满足的边是 continue_project。",
  },
  {
    id: "plan_compilation",
    label: "拆分可执行步骤",
    kind: "Planner Agent",
    status: "done",
    input: "目标、Project 当前状态、约束、验证要求。",
    output: "3 步：定位鉴权边界 → 实现 → 回归旧接口与权限异常。",
    reason: "这是多文件代码变更，需要先形成可审核的最小工作包。",
  },
  {
    id: "execution_draft",
    label: "准备执行请求",
    kind: "确定性 Executor",
    status: "active",
    input: "已接受计划 + 有效上下文 + 用户规则 + pi Agent 能力。",
    output: "ExecutionDraft r4 已生成，等待用户审批。",
    reason: "执行层只能收到用户可审核、版本化且有边界的工作包。",
  },
  {
    id: "response_generation",
    label: "等待执行结果",
    kind: "Agent / Runtime",
    status: "idle",
    input: "审批通过后才会生成不可变 RunSpec。",
    output: "尚未开始。",
    reason: "当前停在人工闸门，未向执行层发送。",
  },
  {
    id: "result_finalization",
    label: "提交结果与证据",
    kind: "Finalization Gate",
    status: "idle",
    input: "等待执行结果、验证证据和用户规则复核。",
    output: "尚未开始。",
    reason: "只有验证通过的结果才能成为完成事实。",
  },
];

const MESSAGES = [
  {
    id: 1,
    role: "user",
    text: "继续书签 API。把权限校验补上，但别影响现在已经可用的接口。",
    time: "09:42",
  },
  {
    id: 2,
    role: "assistant",
    text: "我找到了「书签 API」Project 和上次留下的两个待办。当前最合适的是先固定鉴权边界，再实现并回归匿名读取、登录写入和过期凭证三类场景。我已经把执行请求准备好，发送给执行层之前会请你确认。",
    time: "09:43",
  },
];

function AppIcon({ icon: Icon, size = 20 }) {
  return <Icon aria-hidden="true" size={size} strokeWidth={2} />;
}

function Topbar({ onOpenWorkflow, onToast }) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">
          <Bot size={21} />
        </span>
        <span>
          <strong>Chat</strong>
          <small>Later 的协作空间</small>
        </span>
      </div>

      <label className="global-search">
        <Search size={19} />
        <input aria-label="全局搜索" placeholder="搜索对话、项目、知识，或输入 / 打开命令…" />
        <kbd>
          <Command size={13} /> K
        </kbd>
      </label>

      <div className="topbar-actions">
        <button className="workflow-chip" onClick={onOpenWorkflow} type="button">
          <Workflow size={17} />
          <span>
            <small>本轮 Workflow</small>
            <strong>持续协作主流程 · v1.4.0</strong>
          </span>
          <ChevronDown size={16} />
        </button>
        <button
          aria-label="打开配置"
          className="round-button"
          onClick={() => onToast("配置中心会继续沿用统一弹层，本原型先聚焦主工作区。")}
          type="button"
        >
          <Settings2 size={20} />
        </button>
        <button aria-label="个人资料" className="avatar-button" type="button">
          <UserRound size={19} />
        </button>
      </div>
    </header>
  );
}

function ActivityRail({ activeView, onSelect }) {
  return (
    <nav className="activity-rail" aria-label="主导航">
      <div className="rail-main">
        {NAV_ITEMS.map((item) => (
          <button
            aria-current={activeView === item.id ? "page" : undefined}
            className={activeView === item.id ? "rail-button rail-button--active" : "rail-button"}
            key={item.id}
            onClick={() => onSelect(item.id)}
            type="button"
          >
            <AppIcon icon={item.icon} />
            <span>{item.label}</span>
            {item.badge ? <em>{item.badge}</em> : null}
          </button>
        ))}
      </div>
      <button className="rail-button rail-button--quiet" onClick={() => onSelect("home")} type="button">
        <Sprout size={20} />
        <span>花园</span>
      </button>
    </nav>
  );
}

function CalendarHeatmap() {
  const [selectedDay, setSelectedDay] = useState({
    label: "7 月 24 日",
    summary: "推进了书签 API，整理了 1 条规则，并产生 1 个待审批执行请求。",
  });
  const days = useMemo(
    () =>
      Array.from({ length: 371 }, (_, index) => {
        const signal = (index * 17 + (index % 7) * 5) % 19;
        const intensity = signal < 8 ? 0 : signal < 12 ? 1 : signal < 16 ? 2 : signal < 18 ? 3 : 4;
        return {
          id: index,
          intensity,
          label: `${Math.floor(index / 31) + 1} 月 ${(index % 28) + 1} 日`,
        };
      }),
    [],
  );

  return (
    <section className="activity-card">
      <header className="section-heading">
        <span className="section-icon section-icon--teal">
          <CalendarDays size={20} />
        </span>
        <div>
          <h2>年度协作日历</h2>
          <p>颜色只表示这一天是否发生了有意义的协作，不是效率评分。</p>
        </div>
        <button className="text-button" type="button">
          查看协作日 <ArrowRight size={16} />
        </button>
      </header>
      <div className="calendar-months" aria-hidden="true">
        {["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"].map(
          (month) => (
            <span key={month}>{month}</span>
          ),
        )}
      </div>
      <div className="calendar-scroll">
        <div className="calendar-weekdays" aria-hidden="true">
          <span>一</span>
          <span>三</span>
          <span>五</span>
          <span>日</span>
        </div>
        <div className="heatmap" aria-label="年度协作活动">
          {days.map((day) => (
            <button
              aria-label={`${day.label}，活动强度 ${day.intensity}`}
              className={`heat-cell heat-cell--${day.intensity}`}
              key={day.id}
              onClick={() =>
                setSelectedDay({
                  label: day.label,
                  summary:
                    day.intensity === 0
                      ? "这一天没有协作记录。你可以从任何一天重新开始。"
                      : `这一天有 ${day.intensity} 组可追溯活动，点击协作日可查看来源。`,
                })
              }
              title={day.label}
              type="button"
            />
          ))}
        </div>
      </div>
      <div className="calendar-detail">
        <span>
          <CircleDot size={16} />
          {selectedDay.label}
        </span>
        <p>{selectedDay.summary}</p>
        <button type="button">
          打开当天记录 <ChevronRight size={16} />
        </button>
      </div>
    </section>
  );
}

function HomeView({ onContinue }) {
  return (
    <main className="home-view">
      <section className="home-hero">
        <div>
          <span className="hero-kicker">
            <Sparkles size={17} /> 今天也从一件值得继续的事开始
          </span>
          <h1>
            早上好，Later
            <br />
            <em>今天想把什么变得更好？</em>
          </h1>
          <p>你的对话、项目、学习和灵感会在这里连成一条可继续的协作时间线。</p>
        </div>
        <div className="today-orbit">
          <span className="today-date">07 / 24</span>
          <strong>今天</strong>
          <p>2 项正在推进</p>
          <div>
            <span>3 次协作</span>
            <span>1 个新灵感</span>
          </div>
        </div>
      </section>

      <section className="continue-section">
        <header className="section-title-row">
          <div>
            <span>继续</span>
            <h2>不必重新交代，从上次的位置接着来</h2>
          </div>
          <button className="text-button" type="button">
            全部事项 <ArrowRight size={16} />
          </button>
        </header>
        <div className="continue-grid">
          <article className="continue-card continue-card--teal">
            <span className="continue-icon">
              <FolderKanban size={22} />
            </span>
            <div className="continue-copy">
              <small>PROJECT · 2 小时前</small>
              <h3>书签 API</h3>
              <p>下一步：补充权限校验，并回归现有匿名读取接口。</p>
              <div className="progress-track">
                <span style={{ width: "68%" }} />
              </div>
              <span className="progress-label">当前阶段：实现与验证 · 68%</span>
            </div>
            <button aria-label="继续书签 API" onClick={onContinue} type="button">
              继续 <ArrowRight size={17} />
            </button>
          </article>
          <article className="continue-card continue-card--blue">
            <span className="continue-icon">
              <Layers3 size={22} />
            </span>
            <div className="continue-copy">
              <small>LEARNING · 昨天</small>
              <h3>FastAPI 学习地图</h3>
              <p>下一步：完成依赖注入练习，把结论关联到书签 API。</p>
              <div className="progress-track">
                <span style={{ width: "42%" }} />
              </div>
              <span className="progress-label">本周节奏：2 / 4 次 · 42%</span>
            </div>
            <button aria-label="继续 FastAPI 学习" onClick={onContinue} type="button">
              继续 <ArrowRight size={17} />
            </button>
          </article>
        </div>
      </section>

      <CalendarHeatmap />

      <section className="home-lower-grid">
        <article className="collection-card">
          <header className="section-heading">
            <span className="section-icon section-icon--blue">
              <FileText size={20} />
            </span>
            <div>
              <h2>最近产物</h2>
              <p>真正生成、可继续使用的内容</p>
            </div>
            <button className="text-button" type="button">
              查看全部
            </button>
          </header>
          <div className="output-list">
            {[
              ["Chat Harness 协议 v1", "文档 · 2 小时前", "coral"],
              ["FastAPI 学习地图", "白板 · 昨天", "blue"],
              ["书签 API 验证报告", "报告 · 2 天前", "teal"],
            ].map(([title, meta, tone]) => (
              <button className="output-item" key={title} type="button">
                <span className={`output-mark output-mark--${tone}`}>
                  <FileText size={18} />
                </span>
                <span>
                  <strong>{title}</strong>
                  <small>{meta}</small>
                </span>
                <ChevronRight size={17} />
              </button>
            ))}
          </div>
        </article>

        <article className="collection-card idea-card">
          <header className="section-heading">
            <span className="section-icon section-icon--yellow">
              <Lightbulb size={20} />
            </span>
            <div>
              <h2>灵感花园</h2>
              <p>想法可以先活下来，不必立刻变成任务</p>
            </div>
            <button className="round-button round-button--small" type="button">
              <Plus size={17} />
            </button>
          </header>
          <div className="idea-list">
            <button type="button">
              <span className="idea-seed idea-seed--coral">
                <Sprout size={18} />
              </span>
              <span>
                <strong>把学习复盘做成卡片</strong>
                <small>待培育 · 今天</small>
              </span>
              <em>新芽</em>
            </button>
            <button type="button">
              <span className="idea-seed idea-seed--teal">
                <Sprout size={18} />
              </span>
              <span>
                <strong>语音里直接选择上下文</strong>
                <small>已关联 · Chat Project</small>
              </span>
              <em>生长中</em>
            </button>
            <button type="button">
              <span className="idea-seed idea-seed--blue">
                <Sprout size={18} />
              </span>
              <span>
                <strong>协作日历的季节变化</strong>
                <small>可升级 · 3 天前</small>
              </span>
              <em>可移栽</em>
            </button>
          </div>
        </article>
      </section>
    </main>
  );
}

function ContextPicker({ selected, setSelected }) {
  const [open, setOpen] = useState(false);
  const toggle = (item) => {
    setSelected((items) =>
      items.some((current) => current.id === item.id)
        ? items.filter((current) => current.id !== item.id)
        : [...items, item],
    );
  };

  return (
    <div className="context-picker">
      <div className="context-row">
        <button className="context-add" onClick={() => setOpen((value) => !value)} type="button">
          <Plus size={16} /> 选择上下文
        </button>
        {selected.map((item) => (
          <button
            className={`context-chip context-chip--${item.tone}`}
            key={item.id}
            onClick={() => toggle(item)}
            title={`移除 ${item.label}`}
            type="button"
          >
            <AppIcon icon={item.icon} size={15} />
            {item.label}
            <X size={14} />
          </button>
        ))}
        <span className="context-budget">采用 {selected.length} 项 · 约 3.2k tokens</span>
      </div>
      {open ? (
        <div className="context-menu">
          <header>
            <div>
              <strong>本轮采用什么</strong>
              <small>你的选择会进入有效上下文，完整历史不会自动加入。</small>
            </div>
            <button aria-label="关闭上下文选择" onClick={() => setOpen(false)} type="button">
              <X size={17} />
            </button>
          </header>
          <div>
            {CONTEXT_OPTIONS.map((item) => (
              <button
                className={selected.some((current) => current.id === item.id) ? "selected" : ""}
                key={item.id}
                onClick={() => toggle(item)}
                type="button"
              >
                <span className={`context-option-icon context-option-icon--${item.tone}`}>
                  <AppIcon icon={item.icon} size={18} />
                </span>
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.type}</small>
                </span>
                {selected.some((current) => current.id === item.id) ? <Check size={17} /> : <Plus size={17} />}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ChatView({
  messages,
  draft,
  setDraft,
  onSend,
  selectedContext,
  setSelectedContext,
  workbenchOpen,
  onToggleWorkbench,
}) {
  return (
    <main className="chat-view">
      <header className="conversation-header">
        <div>
          <span className="conversation-day">今天 · 7 月 24 日</span>
          <h1>继续书签 API</h1>
          <p>连续对话流 · 系统只为本轮组装有界上下文</p>
        </div>
        <button
          aria-expanded={workbenchOpen}
          className={workbenchOpen ? "workbench-trigger workbench-trigger--active" : "workbench-trigger"}
          id="conversation-workbench-trigger"
          onClick={onToggleWorkbench}
          type="button"
        >
          {workbenchOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
          {workbenchOpen ? "收起工作台" : "查看工作流"}
        </button>
      </header>

      <div className="message-stream">
        <div className="day-divider">
          <span>今天上午</span>
        </div>
        {messages.map((message) => (
          <article className={`message-row message-row--${message.role}`} key={message.id}>
            <span className="message-avatar">
              {message.role === "user" ? <UserRound size={18} /> : <Sparkles size={18} />}
            </span>
            <div className="message-content">
              <span>
                <strong>{message.role === "user" ? "Later" : "Chat"}</strong>
                <time>{message.time}</time>
              </span>
              <p>{message.text}</p>
              {message.role === "assistant" ? (
                <button className="inline-action" onClick={onToggleWorkbench} type="button">
                  <Workflow size={16} /> 查看本轮如何运行
                </button>
              ) : null}
            </div>
          </article>
        ))}
      </div>

      <section className="composer-zone">
        <ContextPicker selected={selectedContext} setSelected={setSelectedContext} />
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            onSend();
          }}
        >
          <textarea
            aria-label="发送消息"
            onChange={(event) => setDraft(event.target.value)}
            placeholder="输入你想继续推进的事情…"
            rows={3}
            value={draft}
          />
          <div className="composer-footer">
            <button className="workflow-select" type="button">
              <Workflow size={16} />
              持续协作主流程 · v1.4.0
              <ChevronDown size={15} />
            </button>
            <span>Enter 发送 · 每次真实模型调用发送前确认</span>
            <button aria-label="发送" className="send-button" disabled={!draft.trim()} type="submit">
              <Send size={19} />
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}

function Workbench({ selectedNodeId, setSelectedNodeId, onClose, onOpenApproval }) {
  const selectedNode =
    WORKFLOW_NODES.find((node) => node.id === selectedNodeId) ?? WORKFLOW_NODES[5];
  const before = WORKFLOW_NODES.slice(0, 3);
  const after = WORKFLOW_NODES.slice(4);

  const renderNode = (node) => (
    <button
      className={`mind-node mind-node--${node.status} ${
        selectedNode.id === node.id ? "mind-node--selected" : ""
      }`}
      key={node.id}
      onClick={() => setSelectedNodeId(node.id)}
      type="button"
    >
      <span className="node-state">
        {node.status === "done" ? <Check size={16} /> : node.status === "active" ? <CircleDot size={16} /> : <Circle size={15} />}
      </span>
      <span>
        <small>{node.kind}</small>
        <strong>{node.label}</strong>
      </span>
    </button>
  );

  return (
    <aside className="workbench" aria-label="Workflow 运行工作台">
      <header className="workbench-header">
        <div>
          <span>WORKBENCH</span>
          <h2>Workflow Run</h2>
        </div>
        <button aria-label="关闭工作台" onClick={onClose} type="button">
          <PanelRightClose size={20} />
        </button>
      </header>
      <div className="workbench-scroll">
        <section className="run-hero">
          <span className="run-icon">
            <Workflow size={22} />
          </span>
          <div>
            <small>WORKFLOW DEFINITION · v1.4.0</small>
            <h3>持续协作主流程</h3>
            <p>识别用户要做什么，组装有效上下文，并在执行前交给用户确认。</p>
          </div>
          <span className="status-pill status-pill--waiting">等待审批</span>
          <button className="primary-button" onClick={onOpenApproval} type="button">
            <ShieldCheck size={17} /> 打开审批
          </button>
        </section>

        <section className="journey-card">
          <header className="mini-heading">
            <span>
              <ListTree size={18} /> 完整系统链路
            </span>
            <small>代码边界，不是额外 MAF 节点</small>
          </header>
          <ol>
            {[
              ["前端提交", "done", "React / AG-UI"],
              ["产品事实接纳", "done", "Product Session"],
              ["Worker 执行", "done", "Job / Lease"],
              ["MAF Workflow", "active", "28 个真实节点"],
              ["结果提交", "idle", "Finalization Gate"],
              ["前端呈现", "idle", "Product 事实"],
            ].map(([label, status, owner], index) => (
              <li className={`journey-step journey-step--${status}`} key={label}>
                <span>{status === "done" ? <Check size={14} /> : index + 1}</span>
                <strong>{label}</strong>
                <small>{owner}</small>
              </li>
            ))}
          </ol>
        </section>

        <section className="mindmap-card">
          <header className="mini-heading">
            <span>
              <GitBranch size={18} /> 本轮真实路径
            </span>
            <small>点击节点查看经过的公开内容</small>
          </header>
          <div className="mindmap">
            <div className="mind-group">
              <span className="group-label">进入选择前</span>
              {before.map(renderNode)}
            </div>
            <div className="mind-connector">
              <ArrowRight size={19} />
            </div>
            <div className="decision-group">
              <span className="group-label">真实选择节点</span>
              {renderNode(WORKFLOW_NODES[3])}
              <div className="route-options">
                <button className="route-option route-option--selected" type="button">
                  <CheckCircle2 size={16} />
                  <span>
                    <strong>继续 Project</strong>
                    <small>scenario = continue_project · 本轮命中</small>
                  </span>
                </button>
                <button className="route-option" type="button">
                  <Circle size={15} />
                  <span>
                    <strong>新任务</strong>
                    <small>条件不满足 · 本轮未走</small>
                  </span>
                </button>
                <button className="route-option" type="button">
                  <Circle size={15} />
                  <span>
                    <strong>简单询问</strong>
                    <small>条件不满足 · 本轮未走</small>
                  </span>
                </button>
              </div>
            </div>
            <div className="mind-connector">
              <ArrowRight size={19} />
            </div>
            <div className="mind-group">
              <span className="group-label">选中路径后续</span>
              {after.map(renderNode)}
            </div>
          </div>
        </section>

        <section className="inspector-card">
          <header>
            <span className={`inspector-state inspector-state--${selectedNode.status}`}>
              {selectedNode.status === "done" ? <Check size={17} /> : <CircleDot size={17} />}
            </span>
            <div>
              <small>当前选中节点 · {selectedNode.kind}</small>
              <h3>{selectedNode.label}</h3>
            </div>
            <span>{selectedNode.status === "done" ? "已完成" : selectedNode.status === "active" ? "等待用户" : "未开始"}</span>
          </header>
          <div className="inspector-grid">
            <article>
              <span>
                <Database size={16} /> 公开输入
              </span>
              <p>{selectedNode.input}</p>
            </article>
            <article>
              <span>
                <Eye size={16} /> 公开输出
              </span>
              <p>{selectedNode.output}</p>
            </article>
            <article className="inspector-reason">
              <span>
                <GitBranch size={16} /> 为什么这样走
              </span>
              <p>{selectedNode.reason}</p>
            </article>
          </div>
          <details>
            <summary>
              <Code2 size={16} /> 查看运行事实与源码入口 <ChevronDown size={16} />
            </summary>
            <dl>
              <div>
                <dt>executor_id</dt>
                <dd>{selectedNode.id}</dd>
              </div>
              <div>
                <dt>Product Run</dt>
                <dd>run_7d31f5c2</dd>
              </div>
              <div>
                <dt>源码入口</dt>
                <dd>continuous_chat.py · execute</dd>
              </div>
            </dl>
          </details>
        </section>
      </div>
    </aside>
  );
}

function ApprovalModal({ onReturn, onApproved }) {
  const [tab, setTab] = useState("readable");
  const [draft, setDraft] = useState({
    provider: "火山方舟",
    model: "doubao-seed-1-6",
    objective: "为书签 API 补充权限校验，并确保现有匿名读取接口不受影响。",
    instructions:
      "先读取项目 README 与现有鉴权代码；修改前固定行为基线；实现后验证匿名读取、登录写入、过期凭证和旧接口回归。",
    message: "请在现有书签 API 中实现权限校验。不要创建第二套鉴权逻辑，也不要修改无关文件。",
    context: "书签 API Project 当前阶段、README.md、文档 metadata 规则、API 验证经验。",
    output: "提交代码改动、测试结果、耗时、工具调用和仍存在的风险。",
  });
  const [savedDraft, setSavedDraft] = useState(draft);
  const [revision, setRevision] = useState(4);
  const dirty = JSON.stringify(draft) !== JSON.stringify(savedDraft);

  const update = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const save = () => {
    setSavedDraft(draft);
    setRevision((value) => value + 1);
  };

  return (
    <div className="approval-backdrop">
      <section aria-labelledby="approval-title" aria-modal="true" className="approval-dialog" role="dialog">
        <header className="approval-header">
          <span className="approval-icon">
            <ShieldCheck size={24} />
          </span>
          <div>
            <span>HUMAN IN THE LOOP · 每次模型调用</span>
            <h1 id="approval-title">确认真正发给执行层的内容</h1>
            <p>下面每一项都可以修改；保存后会生成新的版本和 Hash，再由你决定是否继续。</p>
          </div>
          <span className="hash-chip">r{revision} · 8bf2c9a1</span>
        </header>

        <div className={dirty ? "dirty-banner dirty-banner--active" : "dirty-banner"}>
          <Info size={17} />
          <span>{dirty ? "检测到修改：旧批准已失效，请先保存新版本。" : "当前内容与已保存版本一致，可以批准继续。"}</span>
        </div>

        <nav className="approval-tabs" aria-label="审批内容视图">
          <button className={tab === "readable" ? "active" : ""} onClick={() => setTab("readable")} type="button">
            <Eye size={17} /> 可读编辑
          </button>
          <button className={tab === "provider" ? "active" : ""} onClick={() => setTab("provider")} type="button">
            <Code2 size={17} /> Provider 请求预览
          </button>
        </nav>

        <div className="approval-body">
          {tab === "readable" ? (
            <>
              <section className="approval-section approval-section--route">
                <header>
                  <span className="approval-section-number">1</span>
                  <div>
                    <h2>模型路由</h2>
                    <p>Provider 决定可用模型，用户只从已配置目录中选择。</p>
                  </div>
                </header>
                <div className="two-column-fields">
                  <label>
                    <span>Provider</span>
                    <select value={draft.provider} onChange={(event) => update("provider", event.target.value)}>
                      <option>火山方舟</option>
                      <option>智谱 BigModel</option>
                    </select>
                  </label>
                  <label>
                    <span>模型</span>
                    <select value={draft.model} onChange={(event) => update("model", event.target.value)}>
                      <option>doubao-seed-1-6</option>
                      <option>doubao-1-5-pro</option>
                    </select>
                  </label>
                </div>
              </section>

              {[
                ["objective", "本轮目标", "模型和执行层最终要完成什么。"],
                ["instructions", "工作方法与边界", "必须遵守的规则、步骤和禁止事项。"],
                ["message", "本轮消息", "真正进入请求的用户内容，可直接改写。"],
                ["context", "采用的上下文", "来自历史、项目、文件、规则和经验的有界内容。"],
                ["output", "交付与验证要求", "结果必须包含什么，以及怎样证明完成。"],
              ].map(([key, label, helper], index) => (
                <section className="approval-section" key={key}>
                  <header>
                    <span className="approval-section-number">{index + 2}</span>
                    <div>
                      <h2>{label}</h2>
                      <p>{helper}</p>
                    </div>
                    <Pencil size={17} />
                  </header>
                  <label>
                    <span className="field-key">{key}</span>
                    <textarea rows={key === "instructions" || key === "context" ? 4 : 3} value={draft[key]} onChange={(event) => update(key, event.target.value)} />
                  </label>
                </section>
              ))}
            </>
          ) : (
            <section className="provider-preview">
              <header>
                <div>
                  <h2>即将发送的脱敏 Provider 请求</h2>
                  <p>这是同一份请求的传输视图，内容与左侧可读编辑保持一致。</p>
                </div>
                <span>store = false</span>
              </header>
              <dl>
                <div>
                  <dt>provider</dt>
                  <dd>{draft.provider}</dd>
                </div>
                <div>
                  <dt>model</dt>
                  <dd>{draft.model}</dd>
                </div>
                <div>
                  <dt>input</dt>
                  <dd>{draft.message}</dd>
                </div>
                <div>
                  <dt>instructions</dt>
                  <dd>{draft.instructions}</dd>
                </div>
                <div>
                  <dt>context</dt>
                  <dd>{draft.context}</dd>
                </div>
                <div>
                  <dt>tools</dt>
                  <dd>read · grep · test（来自真实 Tool Catalog，只读）</dd>
                </div>
                <div>
                  <dt>tool_choice</dt>
                  <dd>auto</dd>
                </div>
                <div>
                  <dt>continuation</dt>
                  <dd>不使用 Provider 保存历史；完整上下文随本次请求发送。</dd>
                </div>
              </dl>
            </section>
          )}
        </div>

        <footer className="approval-footer">
          <button className="secondary-button secondary-button--danger" onClick={onReturn} type="button">
            <X size={18} /> 放弃并返回对话
          </button>
          <span>返回不会删除输入；你仍可在对话框继续修改。</span>
          <div>
            <button className="secondary-button" disabled={!dirty} onClick={save} type="button">
              <Save size={18} /> 保存新版本
            </button>
            <button className="primary-button primary-button--large" disabled={dirty} onClick={onApproved} type="button">
              <ShieldCheck size={18} /> 批准并继续
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

export function App() {
  const [activeView, setActiveView] = useState("home");
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState("execution_draft");
  const [messages, setMessages] = useState(MESSAGES);
  const [draft, setDraft] = useState("");
  const [selectedContext, setSelectedContext] = useState(CONTEXT_OPTIONS);
  const [toast, setToast] = useState("");

  const showToast = (message) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2800);
  };

  const selectView = (view) => {
    setActiveView(view);
    setWorkbenchOpen(view === "workflow");
  };

  const openWorkflow = () => {
    setActiveView("workflow");
    setWorkbenchOpen(true);
  };

  const returnToChat = () => {
    setActiveView("chat");
    setWorkbenchOpen(false);
    window.requestAnimationFrame(() => document.getElementById("conversation-workbench-trigger")?.focus());
  };

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setMessages((items) => [
      ...items,
      { id: Date.now(), role: "user", text, time: "现在" },
      {
        id: Date.now() + 1,
        role: "assistant",
        text: "我已经接纳这条输入，并按你显式选择的上下文启动持续协作主流程。右侧工作台正在展示本轮真实路径。",
        time: "现在",
      },
    ]);
    setDraft("");
    openWorkflow();
  };

  const approve = () => {
    setMessages((items) => [
      ...items,
      {
        id: Date.now(),
        role: "assistant",
        text: "执行请求已按你确认的版本继续。本原型停在这里，不会真的调用模型或执行工具。",
        time: "现在",
      },
    ]);
    setActiveView("workflow");
    setWorkbenchOpen(true);
    showToast("已批准 r4；原型没有真正发送外部请求。");
  };

  const mainIsHome = activeView === "home";
  const approvalOpen = activeView === "approval";

  return (
    <div className="app-shell">
      <Topbar onOpenWorkflow={openWorkflow} onToast={showToast} />
      <div className="workspace">
        <ActivityRail activeView={activeView} onSelect={selectView} />
        <div className={workbenchOpen ? "collaboration-surface collaboration-surface--split" : "collaboration-surface"}>
          {mainIsHome ? (
            <HomeView onContinue={() => selectView("chat")} />
          ) : (
            <ChatView
              draft={draft}
              messages={messages}
              onSend={send}
              onToggleWorkbench={() => {
                if (workbenchOpen) {
                  returnToChat();
                } else {
                  openWorkflow();
                }
              }}
              selectedContext={selectedContext}
              setDraft={setDraft}
              setSelectedContext={setSelectedContext}
              workbenchOpen={workbenchOpen}
            />
          )}
          {workbenchOpen ? (
            <Workbench
              onClose={returnToChat}
              onOpenApproval={() => selectView("approval")}
              selectedNodeId={selectedNodeId}
              setSelectedNodeId={setSelectedNodeId}
            />
          ) : null}
        </div>
      </div>
      {approvalOpen ? <ApprovalModal onApproved={approve} onReturn={returnToChat} /> : null}
      {toast ? (
        <div className="toast" role="status">
          <CheckCircle2 size={18} /> {toast}
        </div>
      ) : null}
    </div>
  );
}
