import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowsClockwise,
  BookOpenText,
  CalendarBlank,
  Check,
  CheckCircle,
  CircleNotch,
  ClockCountdown,
  DeviceMobile,
  Eye,
  FileText,
  FlagCheckered,
  FolderOpen,
  Funnel,
  ListChecks,
  Monitor,
  Moon,
  PencilSimple,
  ProjectorScreenChart,
  Robot,
  SealCheck,
  ShieldCheck,
  Stack,
  Sun,
  Target,
  UserCircle,
  UsersThree,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import {
  acceptCandidate,
  acceptDecision,
  completeAction,
  createInitialState,
  editCandidate,
  findById,
  moveActionToDayPart,
  publishProjectUpdate,
  reviseDecision,
  startReconciliation,
  undoActionMutation,
  verifyReconciliation,
} from "./model.js";

const MODES = [
  {
    id: "project",
    label: "Project Room",
    shortLabel: "项目",
    description: "长期目标与推进事实",
    icon: FolderOpen,
  },
  {
    id: "today",
    label: "Today Rhythm",
    shortLabel: "今日",
    description: "个人注意力与时间节奏",
    icon: CalendarBlank,
  },
  {
    id: "workbench",
    label: "Evidence Workbench",
    shortLabel: "工作台",
    description: "Agent 监督与证据判断",
    icon: ShieldCheck,
  },
];

const HEALTH_LABELS = {
  on_track: "节奏正常",
  at_risk: "需要留意",
  off_track: "偏离计划",
};

const STATUS_LABELS = {
  active: "进行中",
  needs_decision: "等待决定",
  blocked: "阻塞",
  open: "待处理",
  completed: "已完成",
  candidate: "候选",
  accepted: "已接受",
  outcome_unknown: "结果未知",
  succeeded: "已确认成功",
  verified: "已核验",
  partial: "部分证据",
};

const PROJECT_FILTERS = [
  ["all", "全部工作"],
  ["active", "进行中"],
  ["needs_decision", "待决定"],
  ["blocked", "阻塞"],
];

const TODAY_FILTERS = [
  ["all", "全部"],
  ["attention", "需介入"],
  ["work", "工作"],
  ["personal", "生活与爱好"],
];

const WORKBENCH_FILTERS = [
  ["attention", "需要我介入"],
  ["decision", "决定"],
  ["candidate", "候选"],
  ["run", "运行异常"],
  ["all", "全部"],
];

function routeFromLocation() {
  const params = new URLSearchParams(window.location.search);
  const mode = MODES.some((item) => item.id === params.get("mode")) ? params.get("mode") : "project";
  return {
    mode,
    view: params.get("view") || "overview",
    detail: params.get("detail") || "",
  };
}

function objectFromDetail(detail) {
  const [type, ...idParts] = detail.split(":");
  return { type, id: idParts.join(":") };
}

function person(state, id) {
  return state.participants.find((item) => item.id === id);
}

function projectFor(state, id) {
  return state.projects.find((item) => item.id === id);
}

function objectLabel(value) {
  return STATUS_LABELS[value] || HEALTH_LABELS[value] || value;
}

function statusTone(value) {
  if (["on_track", "completed", "accepted", "succeeded", "verified"].includes(value)) return "success";
  if (["at_risk", "needs_decision", "candidate", "partial"].includes(value)) return "warning";
  if (["blocked", "off_track", "outcome_unknown"].includes(value)) return "danger";
  return "neutral";
}

function StatusChip({ value, children }) {
  const tone = statusTone(value);
  const Icon = tone === "success" ? CheckCircle : tone === "danger" ? WarningCircle : CircleNotch;
  return (
    <span className={`status-chip tone-${tone}`}>
      <Icon aria-hidden="true" size={14} weight={tone === "neutral" ? "regular" : "fill"} />
      {children || objectLabel(value)}
    </span>
  );
}

function Identity({ participant, compact = false }) {
  if (!participant) return null;
  const Icon = participant.kind === "agent" ? Robot : UserCircle;
  return (
    <span className={`identity ${participant.kind === "agent" ? "is-agent" : "is-human"}`}>
      <span className="identity-icon" aria-hidden="true">
        <Icon size={compact ? 16 : 18} weight={participant.kind === "agent" ? "fill" : "regular"} />
      </span>
      <span>
        <strong>{participant.name}</strong>
        {!compact && <small>{participant.role}</small>}
      </span>
    </span>
  );
}

function IconButton({ label, children, className = "", ...props }) {
  return (
    <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}

function ModeButton({ mode, active, onClick, compact = false }) {
  const Icon = mode.icon;
  return (
    <button
      type="button"
      className={`mode-button ${active ? "is-active" : ""} ${compact ? "is-compact" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      <Icon size={20} weight={active ? "fill" : "regular"} aria-hidden="true" />
      <span>{compact ? mode.shortLabel : mode.label}</span>
    </button>
  );
}

function SectionHeading({ title, note, action }) {
  return (
    <div className="section-heading">
      <div>
        <h2>{title}</h2>
        {note && <p>{note}</p>}
      </div>
      {action}
    </div>
  );
}

function FilterBar({ label, items, value, onChange }) {
  return (
    <div className="filter-bar" aria-label={label}>
      <Funnel size={16} aria-hidden="true" />
      {items.map(([id, text]) => (
        <button
          type="button"
          key={id}
          className={value === id ? "is-active" : ""}
          aria-pressed={value === id}
          onClick={() => onChange(id)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function GlobalNavigation({ route, onModeChange }) {
  return (
    <aside className="global-navigation" aria-label="全局模式">
      <div className="wordmark" aria-label="Chat">
        Chat
      </div>
      <nav className="global-mode-list">
        {MODES.map((mode) => (
          <ModeButton key={mode.id} mode={mode} active={route.mode === mode.id} onClick={() => onModeChange(mode.id)} />
        ))}
      </nav>
      <div className="global-note">
        <strong>组合原型</strong>
        <span>Fixture · 非真实服务</span>
      </div>
    </aside>
  );
}

function ProjectContext({ state, projectId, onProjectChange, filter, onFilterChange }) {
  return (
    <>
      <header className="context-heading">
        <ProjectorScreenChart size={20} aria-hidden="true" />
        <div>
          <strong>Projects</strong>
          <span>稳定的长期地点</span>
        </div>
      </header>
      <div className="context-scroll">
        <p className="context-label">正在推进</p>
        <div className="context-list">
          {state.projects.map((project) => (
            <button
              type="button"
              key={project.id}
              className={`context-row ${projectId === project.id ? "is-active" : ""}`}
              aria-current={projectId === project.id ? "page" : undefined}
              onClick={() => onProjectChange(project.id)}
            >
              <span>
                <strong>{project.shortName}</strong>
                <small>
                  {project.stage} · {HEALTH_LABELS[project.health]}
                </small>
              </span>
              <StatusChip value={project.health} />
            </button>
          ))}
        </div>
        <p className="context-label">工作状态</p>
        <div className="context-list is-compact">
          {PROJECT_FILTERS.map(([id, label]) => (
            <button
              type="button"
              key={id}
              className={`context-row ${filter === id ? "is-active" : ""}`}
              aria-pressed={filter === id}
              onClick={() => onFilterChange(id)}
            >
              <span>{label}</span>
              <strong>{id === "all" ? state.works.length : state.works.filter((work) => work.status === id).length}</strong>
            </button>
          ))}
        </div>
      </div>
      <footer className="context-footer">
        <strong>Project 拥有长期归属</strong>
        <span>Today 和 Workbench 只投影同一批对象。</span>
      </footer>
    </>
  );
}

function TodayContext({ state, filter, onFilterChange }) {
  const activeActions = state.actions.filter((action) => action.scheduledFor === "today" && action.status === "open");
  return (
    <>
      <header className="context-heading">
        <CalendarBlank size={20} aria-hidden="true" />
        <div>
          <strong>今天</strong>
          <span>个人注意力投影</span>
        </div>
      </header>
      <div className="context-scroll">
        <p className="context-label">8 月</p>
        <div className="context-list">
          <button type="button" className="context-row is-active" aria-current="date" onClick={() => onFilterChange("all")}>
            <span>
              <strong>周一 · 10 日</strong>
              <small>2 个时间约束 · {activeActions.length} 个 Action</small>
            </span>
            <span className="count-chip">今</span>
          </button>
          <button type="button" className="context-row" onClick={() => onFilterChange("personal")}>
            <span>
              <strong>周二 · 11 日</strong>
              <small>生活与爱好 2 项</small>
            </span>
          </button>
        </div>
        <p className="context-label">注意力范围</p>
        <div className="context-list is-compact">
          {TODAY_FILTERS.map(([id, label]) => (
            <button
              type="button"
              key={id}
              className={`context-row ${filter === id ? "is-active" : ""}`}
              aria-pressed={filter === id}
              onClick={() => onFilterChange(id)}
            >
              <span>{label}</span>
            </button>
          ))}
        </div>
      </div>
      <footer className="context-footer">
        <strong>Today 不拥有 Work</strong>
        <span>完成与移晚只允许作用于可逆 Action。</span>
      </footer>
    </>
  );
}

function WorkbenchContext({ state, filter, onFilterChange, agentFilter, onAgentFilter }) {
  const attentionCount =
    state.decisions.filter((item) => item.status === "candidate").length +
    state.candidates.filter((item) => item.status === "candidate").length +
    state.runs.filter((item) => item.status === "outcome_unknown").length;
  return (
    <>
      <header className="context-heading">
        <ShieldCheck size={20} aria-hidden="true" />
        <div>
          <strong>监督队列</strong>
          <span>按介入原因分流</span>
        </div>
      </header>
      <div className="context-scroll">
        <p className="context-label">任务类型</p>
        <div className="context-list is-compact">
          {WORKBENCH_FILTERS.map(([id, label]) => (
            <button
              type="button"
              key={id}
              className={`context-row ${filter === id ? "is-active" : ""}`}
              aria-pressed={filter === id}
              onClick={() => onFilterChange(id)}
            >
              <span>{label}</span>
              {id === "attention" && <span className="count-chip">{attentionCount}</span>}
            </button>
          ))}
        </div>
        <p className="context-label">Agent</p>
        <div className="context-list">
          <button
            type="button"
            className={`context-row ${agentFilter === "all" ? "is-active" : ""}`}
            aria-pressed={agentFilter === "all"}
            onClick={() => onAgentFilter("all")}
          >
            <span>
              <strong>全部 Agent</strong>
              <small>保留 Project 与对象来源</small>
            </span>
          </button>
          {state.participants
            .filter((item) => item.kind === "agent")
            .map((agent) => (
              <button
                type="button"
                key={agent.id}
                className={`context-row ${agentFilter === agent.id ? "is-active" : ""}`}
                aria-pressed={agentFilter === agent.id}
                onClick={() => onAgentFilter(agent.id)}
              >
                <Identity participant={agent} compact />
              </button>
            ))}
        </div>
      </div>
      <footer className="context-footer">
        <strong>Feed 只是投影</strong>
        <span>决定、运行、候选与证据各自拥有状态。</span>
      </footer>
    </>
  );
}

function ContextPanel(props) {
  return (
    <aside className="context-panel" aria-label="当前模式导航">
      {props.route.mode === "project" && <ProjectContext {...props} />}
      {props.route.mode === "today" && <TodayContext {...props} />}
      {props.route.mode === "workbench" && <WorkbenchContext {...props} />}
    </aside>
  );
}

function TopBar({ route, previewMobile, onPreviewToggle, theme, onThemeToggle }) {
  const mode = MODES.find((item) => item.id === route.mode);
  return (
    <header className="top-bar">
      <div className="breadcrumb">
        <span>组合原型</span>
        <strong>{mode.label}</strong>
      </div>
      <div className="top-actions">
        <span className="fixture-chip">稳定 Mock IDs</span>
        <IconButton label={previewMobile ? "使用自适应桌面宽度" : "切换 391 × 844 移动预览"} onClick={onPreviewToggle}>
          {previewMobile ? <Monitor size={19} aria-hidden="true" /> : <DeviceMobile size={19} aria-hidden="true" />}
        </IconButton>
        <IconButton label={theme === "light" ? "切换深色主题" : "切换浅色主题"} onClick={onThemeToggle}>
          {theme === "light" ? <Moon size={19} aria-hidden="true" /> : <Sun size={19} aria-hidden="true" />}
        </IconButton>
      </div>
    </header>
  );
}

function MobileNavigation({ route, onModeChange }) {
  return (
    <nav className="mobile-navigation" aria-label="移动端模式">
      {MODES.map((mode) => (
        <ModeButton key={mode.id} mode={mode} active={route.mode === mode.id} compact onClick={() => onModeChange(mode.id)} />
      ))}
    </nav>
  );
}

function StageStrip({ project }) {
  return (
    <section className="stage-strip" aria-label="项目推进结构">
      <article>
        <span className="stage-icon"><Target size={18} aria-hidden="true" /></span>
        <div>
          <small>Stage · {project.stageIndex} / 3</small>
          <strong>{project.stage}</strong>
        </div>
      </article>
      <article>
        <span className="stage-icon"><FlagCheckered size={18} aria-hidden="true" /></span>
        <div>
          <small>Milestone · {project.milestoneDue}</small>
          <strong>{project.milestone}</strong>
        </div>
      </article>
      <article>
        <span className="stage-icon"><Stack size={18} aria-hidden="true" /></span>
        <div>
          <small>Iteration · 当前承诺</small>
          <strong>{project.iteration}</strong>
        </div>
      </article>
    </section>
  );
}

function WorkRow({ state, work, triggerId, onOpen }) {
  const owner = person(state, work.ownerId);
  const project = projectFor(state, work.projectId);
  return (
    <li className="object-row" data-object-id={work.id}>
      <button type="button" id={triggerId} className="object-main" onClick={() => onOpen("project", "work", work.id, triggerId)}>
        <span className="object-icon" aria-hidden="true"><ListChecks size={18} /></span>
        <span>
          <strong>{work.title}</strong>
          <small>{project.shortName} · {work.updatedAt}</small>
        </span>
      </button>
      <div className="object-tail">
        <Identity participant={owner} compact />
        <StatusChip value={work.status} />
      </div>
    </li>
  );
}

function UpdateEditor({ update, project, onSave, onCancel }) {
  const [body, setBody] = useState(update.body);
  const [health, setHealth] = useState(update.health);
  return (
    <form
      className="inline-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (body.trim()) onSave(body.trim(), health);
      }}
    >
      <label>
        <span>负责人判断</span>
        <select value={health} onChange={(event) => setHealth(event.target.value)}>
          <option value="on_track">节奏正常</option>
          <option value="at_risk">需要留意</option>
          <option value="off_track">偏离计划</option>
        </select>
      </label>
      <label>
        <span>更新叙事</span>
        <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={5} aria-label={`${project.shortName} 更新正文`} />
      </label>
      <div className="form-actions">
        <button type="button" className="secondary-button" onClick={onCancel}>取消</button>
        <button type="submit" className="primary-button"><Check size={17} aria-hidden="true" />发布 revision {update.revision + 1}</button>
      </div>
    </form>
  );
}

function ParticipantBoundary({ state, participantIds, visibility = "project_members", consent = "explicit_on_external_share" }) {
  return (
    <section className="boundary-panel" aria-label="参与与权限边界">
      <div className="boundary-row">
        <span><Eye size={17} aria-hidden="true" />可见范围</span>
        <strong>{visibility === "owner_only" ? "仅 Owner" : "Project participants"}</strong>
      </div>
      <div className="boundary-row">
        <span><ShieldCheck size={17} aria-hidden="true" />Consent</span>
        <strong>{consent.replaceAll("_", " ")}</strong>
      </div>
      <div className="participant-stack">
        {participantIds.map((id) => <Identity key={id} participant={person(state, id)} compact />)}
      </div>
    </section>
  );
}

function ResourceList({ state, resourceIds, onOpen }) {
  return (
    <ul className="resource-list">
      {resourceIds.map((id, index) => {
        const resource = findById(state, "resources", id);
        const triggerId = `resource-trigger-${resource.id}-${index}`;
        return (
          <li key={resource.id} data-object-id={resource.id}>
            <button type="button" id={triggerId} onClick={() => onOpen("project", "resource", resource.id, triggerId)}>
              <BookOpenText size={18} aria-hidden="true" />
              <span><strong>{resource.title}</strong><small>{resource.provenance}</small></span>
            </button>
            <span className="resource-kind">{resource.kind}</span>
          </li>
        );
      })}
    </ul>
  );
}

function ProjectOverview({ state, project, works, onOpen, setState, announce }) {
  const [editing, setEditing] = useState(false);
  const update = state.updates.find((item) => item.projectId === project.id);
  const decision = state.decisions[0];
  return (
    <div className="room-grid">
      <div className="room-main">
        <section className="room-section owner-update" data-object-id={update.id}>
          <SectionHeading
            title="负责人 Update"
            note={`${project.cadence} · 不是活动日志或自动摘要`}
            action={!editing && (
              <button type="button" className="text-button" onClick={() => setEditing(true)}>
                <PencilSimple size={16} aria-hidden="true" />编辑
              </button>
            )}
          />
          {editing ? (
            <UpdateEditor
              key={`${update.id}-${update.revision}`}
              update={update}
              project={project}
              onCancel={() => setEditing(false)}
              onSave={(body, health) => {
                setState((current) => publishProjectUpdate(current, project.id, body, health));
                setEditing(false);
                announce(`已发布 ${project.shortName} Update revision ${update.revision + 1}`);
              }}
            />
          ) : (
            <article className="update-card">
              <header><StatusChip value={update.health} /><time>{update.publishedAt}</time></header>
              <h3>{update.title}</h3>
              <p>{update.body}</p>
              <footer>
                <Identity participant={person(state, update.authorId)} compact />
                <span>revision {update.revision} · {update.evidenceIds.length} 项 Evidence</span>
              </footer>
            </article>
          )}
        </section>
        <section className="room-section">
          <SectionHeading title="当前 Work" note="Scope 与 Action 在详情内保持同一身份" />
          <ul className="object-list">
            {works.map((work, index) => (
              <WorkRow key={work.id} state={state} work={work} triggerId={`overview-work-${work.id}-${index}`} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      </div>
      <aside className="room-aside">
        <section className="room-section attention-panel">
          <SectionHeading title="需要我处理" note="由对象类型决定动作" />
          <button
            type="button"
            id="project-decision-trigger"
            className="attention-card"
            onClick={() => onOpen("workbench", "decision", decision.id, "project-decision-trigger")}
          >
            <span className="attention-kicker"><Robot size={16} weight="fill" aria-hidden="true" />阿橘 → 你</span>
            <strong>{decision.title}</strong>
            <small>Decision revision {decision.revision} · 需要接受或修订</small>
          </button>
        </section>
        <section className="room-section">
          <SectionHeading title="Participants" note={`${project.participantIds.length} 位`} />
          <ParticipantBoundary state={state} participantIds={project.participantIds} />
        </section>
        <section className="room-section">
          <SectionHeading title="Resource / Evidence" note="资料可复用，证据可引用" />
          <ResourceList state={state} resourceIds={project.resourceIds} onOpen={onOpen} />
        </section>
      </aside>
    </div>
  );
}

function DetailHeader({ eyebrow, title, description, onBack }) {
  return (
    <header className="detail-header">
      <button type="button" className="back-button" onClick={onBack}><ArrowLeft size={18} aria-hidden="true" />返回</button>
      <p className="page-kicker">{eyebrow}</p>
      <h1>{title}</h1>
      {description && <p className="page-lede">{description}</p>}
    </header>
  );
}

function WorkDetail({ state, id, onBack, onModeChange, onOpen }) {
  const work = findById(state, "works", id);
  const project = projectFor(state, work.projectId);
  const owner = person(state, work.ownerId);
  const scopes = state.scopes.filter((scope) => work.scopeIds.includes(scope.id));
  return (
    <main className="detail-page" data-object-id={work.id}>
      <DetailHeader eyebrow={`Work · ${project.shortName}`} title={work.title} description="Work 拥有推进边界；Scope 组织承诺，Action 才是可执行的下一步。" onBack={onBack} />
      <section className="fact-grid">
        <article><small>状态</small><StatusChip value={work.status} /></article>
        <article><small>负责人</small><Identity participant={owner} compact /></article>
        <article><small>最近更新</small><strong>{work.updatedAt}</strong></article>
      </section>
      <section className="detail-section">
        <SectionHeading title="Scope / Action" note="完成 Action 不自动完成 Work 或 Project" />
        {scopes.map((scope) => (
          <article className="scope-card" key={scope.id} data-object-id={scope.id}>
            <header><Stack size={18} aria-hidden="true" /><strong>{scope.title}</strong><span>Scope</span></header>
            <ul>
              {scope.actionIds.map((actionId) => {
                const action = findById(state, "actions", actionId);
                return (
                  <li key={action.id} data-object-id={action.id}>
                    <CheckCircle size={18} aria-hidden="true" />
                    <span><strong>{action.title}</strong><small>Action · {action.reversible ? "可逆" : "外部结果不可撤销"}</small></span>
                    <StatusChip value={action.status} />
                  </li>
                );
              })}
            </ul>
          </article>
        ))}
      </section>
      <section className="detail-section">
        <SectionHeading title="关联资料" note="引用 Resource，不复制内容" />
        <ResourceList state={state} resourceIds={work.resourceIds} onOpen={onOpen} />
      </section>
      <div className="sticky-actions">
        <button type="button" className="secondary-button" onClick={() => onModeChange("today")}><CalendarBlank size={17} aria-hidden="true" />在 Today 中继续</button>
      </div>
    </main>
  );
}

function ResourceDetail({ state, id, onBack }) {
  const resource = findById(state, "resources", id);
  const evidence = resource.evidenceIds.map((evidenceId) => findById(state, "evidence", evidenceId));
  return (
    <main className="detail-page" data-object-id={resource.id}>
      <DetailHeader eyebrow={`Resource · ${resource.kind}`} title={resource.title} description={resource.provenance} onBack={onBack} />
      <section className="detail-section">
        <SectionHeading title="Evidence links" note="Resource 是材料；Evidence 是一次判断可引用的观察" />
        <ul className="evidence-list">
          {evidence.map((item) => (
            <li key={item.id} data-object-id={item.id}>
              <FileText size={18} aria-hidden="true" />
              <span><strong>{item.title}</strong><small>{item.source} · {item.observedAt}</small></span>
              <StatusChip value={item.integrity} />
            </li>
          ))}
        </ul>
      </section>
      <section className="detail-section">
        <ParticipantBoundary state={state} participantIds={["participant_later", "agent_mochi"]} visibility={resource.visibility} consent="scope_must_be_explicit" />
      </section>
    </main>
  );
}

function ProjectMode({ state, setState, projectId, onProjectChange, filter, onFilterChange, route, navigate, onOpen, onBack, announce, onModeChange }) {
  const project = projectFor(state, projectId);
  const projectWorks = state.works.filter((work) => work.projectId === project.id && (filter === "all" || work.status === filter));
  const detail = route.detail ? objectFromDetail(route.detail) : null;
  if (detail?.type === "work") return <WorkDetail state={state} id={detail.id} onBack={onBack} onModeChange={onModeChange} onOpen={onOpen} />;
  if (detail?.type === "resource") return <ResourceDetail state={state} id={detail.id} onBack={onBack} />;

  const view = ["overview", "work", "resources"].includes(route.view) ? route.view : "overview";
  return (
    <main className="mode-page project-mode">
      <header className="page-header">
        <div>
          <p className="page-kicker">Project Room · {project.category === "work" ? "工作" : project.category === "life" ? "生活" : "爱好"}</p>
          <h1>{project.shortName}</h1>
          <p className="page-lede">{project.goal}</p>
        </div>
        <div className="page-status">
          <label className="project-switcher">
            <span className="sr-only">切换 Project</span>
            <select value={projectId} onChange={(event) => onProjectChange(event.target.value)}>
              {state.projects.map((item) => <option key={item.id} value={item.id}>{item.shortName}</option>)}
            </select>
          </label>
          <StatusChip value={project.health} />
          <span>{project.cadence}</span>
        </div>
      </header>
      <StageStrip project={project} />
      <nav className="room-tabs" aria-label="Project Room 区域">
        {[
          ["overview", "概览"],
          ["work", "Work"],
          ["resources", "资料与证据"],
        ].map(([id, label]) => (
          <button
            type="button"
            key={id}
            className={view === id ? "is-active" : ""}
            aria-current={view === id ? "page" : undefined}
            onClick={() => navigate({ view: id, detail: "" })}
          >
            {label}
          </button>
        ))}
      </nav>
      <section className="room-sheet">
        {view === "overview" && (
          <ProjectOverview state={state} project={project} works={projectWorks.slice(0, 3)} onOpen={onOpen} setState={setState} announce={announce} />
        )}
        {view === "work" && (
          <section className="room-section full-section">
            <SectionHeading title="Project Work" note="列表扫描 → 详情理解 → 返回原焦点" action={<FilterBar label="筛选 Work" items={PROJECT_FILTERS} value={filter} onChange={onFilterChange} />} />
            {projectWorks.length ? (
              <ul className="object-list">
                {projectWorks.map((work, index) => <WorkRow key={work.id} state={state} work={work} triggerId={`work-list-${work.id}-${index}`} onOpen={onOpen} />)}
              </ul>
            ) : <p className="empty-state">这个 Project 当前没有符合筛选条件的 Work。</p>}
          </section>
        )}
        {view === "resources" && (
          <section className="room-section full-section">
            <SectionHeading title="Resource / Evidence" note="同一份材料可被多个 Work、Decision 与 Workbench 引用" />
            <ResourceList state={state} resourceIds={project.resourceIds} onOpen={onOpen} />
          </section>
        )}
      </section>
    </main>
  );
}

function CalendarFlow({ state }) {
  return (
    <section className="time-section">
      <SectionHeading title="时间约束" note="来自 Calendar，只读；不拥有 Work 状态" />
      <div className="timeline">
        {state.calendarEvents.map((event) => {
          const project = projectFor(state, event.projectId);
          return (
            <article key={event.id} data-object-id={event.id}>
              <time>{event.start}</time>
              <span className="timeline-marker" aria-hidden="true" />
              <div>
                <strong>{event.title}</strong>
                <small>{event.start}–{event.end} · {event.calendar} · {project.shortName}</small>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function TodayActionRow({ state, action, onOpen, onComplete, onMove }) {
  const project = projectFor(state, action.projectId);
  const owner = person(state, action.ownerId);
  const triggerId = `today-action-${action.id}`;
  return (
    <li className="today-row" data-object-id={action.id}>
      <IconButton label={`完成 ${action.title}`} className="complete-button" onClick={() => onComplete(action.id)} disabled={!action.reversible || action.status !== "open"}>
        <Check size={18} aria-hidden="true" />
      </IconButton>
      <button type="button" id={triggerId} className="today-object" onClick={() => onOpen("today", "action", action.id, triggerId)}>
        <strong>{action.title}</strong>
        <small>Action · {project.shortName} · {owner?.name}</small>
      </button>
      <div className="today-row-actions">
        <button type="button" className="text-button" onClick={() => onMove(action.id, action.dayPart === "day" ? "evening" : "day")}>
          <ClockCountdown size={16} aria-hidden="true" />{action.dayPart === "day" ? "移到今晚" : "移回白天"}
        </button>
      </div>
    </li>
  );
}

function AttentionRow({ state, type, object, onOpen }) {
  const isDecision = type === "decision";
  const isRun = type === "run";
  const isWork = type === "work";
  const project = projectFor(state, object.projectId);
  const triggerId = `today-${type}-${object.id}`;
  const Icon = isDecision ? ShieldCheck : isRun ? WarningCircle : ListChecks;
  const targetMode = isWork ? "project" : "workbench";
  const label = isDecision ? "决定" : isRun ? "运行" : "阻塞";
  return (
    <li className="today-row is-attention" data-object-id={object.id}>
      <span className="type-icon" aria-hidden="true"><Icon size={18} weight={isRun ? "fill" : "regular"} /></span>
      <button type="button" id={triggerId} className="today-object" onClick={() => onOpen(targetMode, type, object.id, triggerId)}>
        <strong>{object.title}</strong>
        <small>{label} · {project.shortName} · {isRun ? "只能查询对账" : "需要人工介入"}</small>
      </button>
      <StatusChip value={object.status} />
    </li>
  );
}

function ActionDetail({ state, id, onBack, onComplete, onMove }) {
  const action = findById(state, "actions", id);
  const project = projectFor(state, action.projectId);
  const scope = findById(state, "scopes", action.scopeId);
  return (
    <main className="detail-page" data-object-id={action.id}>
      <DetailHeader eyebrow={`Action · ${project.shortName}`} title={action.title} description="Today 只投影这项 Action 的个人节奏；长期归属仍在 Project / Work / Scope。" onBack={onBack} />
      <section className="fact-grid">
        <article><small>Scope</small><strong>{scope.title}</strong></article>
        <article><small>时段</small><strong>{action.dayPart === "day" ? "白天" : "今晚"}</strong></article>
        <article><small>可逆性</small><strong>{action.reversible ? "可完成、可撤销" : "不可撤销"}</strong></article>
      </section>
      <div className="sticky-actions">
        {action.status === "open" && action.reversible && (
          <>
            <button type="button" className="secondary-button" onClick={() => onMove(action.id, action.dayPart === "day" ? "evening" : "day")}>
              <ClockCountdown size={17} aria-hidden="true" />{action.dayPart === "day" ? "移到今晚" : "移回白天"}
            </button>
            <button type="button" className="primary-button" onClick={() => onComplete(action.id)}><Check size={17} aria-hidden="true" />完成 Action</button>
          </>
        )}
        {action.status === "completed" && <StatusChip value="completed" />}
      </div>
    </main>
  );
}

function TodayMode({ state, filter, onFilterChange, route, onOpen, onBack, onComplete, onMove }) {
  const detail = route.detail ? objectFromDetail(route.detail) : null;
  if (detail?.type === "action") return <ActionDetail state={state} id={detail.id} onBack={onBack} onComplete={onComplete} onMove={onMove} />;

  const openActions = state.actions.filter((action) => {
    if (action.scheduledFor !== "today" || action.status !== "open" || !action.reversible) return false;
    const project = projectFor(state, action.projectId);
    if (filter === "work") return project.category === "work";
    if (filter === "personal") return project.category !== "work";
    if (filter === "attention") return false;
    return true;
  });
  const daytime = openActions.filter((action) => action.dayPart === "day");
  const evening = openActions.filter((action) => action.dayPart === "evening");
  const decision = state.decisions[0];
  const run = state.runs[0];
  const blocker = state.works.find((work) => work.status === "blocked");
  const showAttention = ["all", "attention", "work"].includes(filter);
  const completed = state.actions.filter((action) => action.status === "completed" && action.scheduledFor === "today");
  return (
    <main className="mode-page today-mode">
      <header className="page-header today-heading">
        <div>
          <p className="page-kicker">Today Rhythm · 2026 年 8 月 10 日 · 周一</p>
          <h1>今天留一点空白。</h1>
          <p className="page-lede">先读真实时间约束，再选择承诺、判断或看护什么。长期 Project 与个人 Today 保持正交。</p>
        </div>
        <div className="attention-meter" aria-label="今日注意力使用 60%">
          <span><strong>3</strong> / 5</span>
          <small>今日承诺</small>
        </div>
      </header>
      <FilterBar label="筛选 Today" items={TODAY_FILTERS} value={filter} onChange={onFilterChange} />
      {filter !== "attention" && <CalendarFlow state={state} />}
      {showAttention && (
        <section className="today-section attention-section">
          <SectionHeading title="需要我介入" note="Decision、Run、Blocker 不伪装成可勾选 Action" />
          <ul className="today-list">
            {decision.status === "candidate" && <AttentionRow state={state} type="decision" object={decision} onOpen={onOpen} />}
            {run.status === "outcome_unknown" && <AttentionRow state={state} type="run" object={run} onOpen={onOpen} />}
            <AttentionRow state={state} type="work" object={blocker} onOpen={onOpen} />
          </ul>
        </section>
      )}
      {filter !== "attention" && (
        <>
          <section className="today-section">
            <SectionHeading title="白天" note="只显示可逆 Action 的完成与移晚动作" />
            {daytime.length ? <ul className="today-list">{daytime.map((action) => <TodayActionRow key={action.id} state={state} action={action} onOpen={onOpen} onComplete={onComplete} onMove={onMove} />)}</ul> : <p className="empty-state">这个范围的白天没有待处理 Action。</p>}
          </section>
          <section className="today-section evening-section">
            <SectionHeading title="今晚" note="仍属于今天，但不与白天主序列争抢注意力" />
            {evening.length ? <ul className="today-list">{evening.map((action) => <TodayActionRow key={action.id} state={state} action={action} onOpen={onOpen} onComplete={onComplete} onMove={onMove} />)}</ul> : <p className="empty-state">今晚暂时保留为空。</p>}
          </section>
          {completed.length > 0 && (
            <section className="today-section completed-section">
              <SectionHeading title="今天已完成" note="完成事实仍属于 Action" />
              <ul className="completed-list">{completed.map((action) => <li key={action.id}><CheckCircle size={18} weight="fill" aria-hidden="true" /><span>{action.title}</span></li>)}</ul>
            </section>
          )}
        </>
      )}
    </main>
  );
}

function WorkbenchCard({ state, item, onOpen }) {
  const project = projectFor(state, item.object.projectId);
  const agentId = item.type === "decision" ? item.object.createdById : item.type === "candidate" ? item.object.createdById : item.type === "run" ? item.object.agentId : "agent_mochi";
  const agent = person(state, agentId);
  const Icon = item.type === "decision" ? ShieldCheck : item.type === "candidate" ? FileText : item.type === "run" ? WarningCircle : Eye;
  const triggerId = `workbench-${item.type}-${item.object.id}`;
  return (
    <li className="workbench-card" data-object-id={item.object.id}>
      <button type="button" id={triggerId} onClick={() => onOpen("workbench", item.type, item.object.id, triggerId)}>
        <span className="workbench-icon" aria-hidden="true"><Icon size={20} weight={item.type === "run" ? "fill" : "regular"} /></span>
        <span className="workbench-content">
          <span className="workbench-kicker"><Identity participant={agent} compact /><span>{project.shortName}</span></span>
          <strong>{item.object.title}</strong>
          <small>{item.reason}</small>
        </span>
        <StatusChip value={item.object.status || item.object.integrity} />
      </button>
    </li>
  );
}

function RelatedEvidence({ state, evidenceIds }) {
  return (
    <aside className="evidence-sidecar">
      <SectionHeading title="Evidence" note={`${evidenceIds.length} 项`} />
      <ul>
        {evidenceIds.map((id) => {
          const evidence = findById(state, "evidence", id);
          return (
            <li key={evidence.id} data-object-id={evidence.id}>
              <FileText size={18} aria-hidden="true" />
              <span><strong>{evidence.title}</strong><small>{evidence.source} · {evidence.observedAt}</small></span>
              <StatusChip value={evidence.integrity} />
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function DecisionDetail({ state, setState, id, onBack, announce }) {
  const decision = findById(state, "decisions", id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(decision.content);
  return (
    <main className="detail-page workbench-detail" data-object-id={decision.id}>
      <DetailHeader eyebrow="Decision · 版本绑定" title={decision.title} description={decision.impact} onBack={onBack} />
      <div className="detail-layout">
        <div>
          <section className="fact-grid decision-facts">
            <article><small>Revision</small><strong>{decision.revision}</strong></article>
            <article><small>Hash</small><code>{decision.hash}</code></article>
            <article><small>状态</small><StatusChip value={decision.status} /></article>
          </section>
          <section className="detail-section">
            <SectionHeading title="可读候选" note="模型输出不是长期事实" />
            {editing ? (
              <form
                className="inline-editor"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!draft.trim()) return;
                  setState((current) => reviseDecision(current, decision.id, draft.trim(), decision.revision));
                  setEditing(false);
                  announce(`已生成 Decision revision ${decision.revision + 1}`);
                }}
              >
                <label><span>修订内容</span><textarea rows={6} value={draft} onChange={(event) => setDraft(event.target.value)} /></label>
                <div className="form-actions">
                  <button type="button" className="secondary-button" onClick={() => { setDraft(decision.content); setEditing(false); }}>取消</button>
                  <button type="submit" className="primary-button"><Check size={17} aria-hidden="true" />保存新 revision</button>
                </div>
              </form>
            ) : <blockquote>{decision.content}</blockquote>}
          </section>
          <ParticipantBoundary state={state} participantIds={decision.participantIds} visibility={decision.visibility} consent={decision.consent} />
          {decision.status === "candidate" && !editing && (
            <div className="sticky-actions">
              <button type="button" className="secondary-button" onClick={() => setEditing(true)}><PencilSimple size={17} aria-hidden="true" />修订候选</button>
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  setState((current) => acceptDecision(current, decision.id, decision.revision));
                  announce(`已接受 Decision revision ${decision.revision}，hash 已绑定`);
                }}
              ><SealCheck size={17} aria-hidden="true" />接受并写入事实</button>
            </div>
          )}
          {decision.status === "accepted" && <div className="result-banner success"><SealCheck size={20} weight="fill" aria-hidden="true" /><span><strong>已接受</strong>revision {decision.revision} 与 hash 已绑定；没有提供普通 Undo。</span></div>}
        </div>
        <RelatedEvidence state={state} evidenceIds={decision.evidenceIds} />
      </div>
    </main>
  );
}

function CandidateDetail({ state, setState, id, onBack, announce }) {
  const candidate = findById(state, "candidates", id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(candidate.content);
  return (
    <main className="detail-page workbench-detail" data-object-id={candidate.id}>
      <DetailHeader eyebrow={`Candidate · revision ${candidate.revision}`} title={candidate.title} description="Agent 生成的内容先作为候选；编辑或接受都保留来源。" onBack={onBack} />
      <div className="detail-layout">
        <div>
          <section className="detail-section">
            {editing ? (
              <form
                className="inline-editor"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!draft.trim()) return;
                  setState((current) => editCandidate(current, candidate.id, draft.trim(), candidate.revision));
                  setEditing(false);
                  announce(`已保存 Candidate revision ${candidate.revision + 1}`);
                }}
              >
                <label><span>候选正文</span><textarea rows={7} value={draft} onChange={(event) => setDraft(event.target.value)} /></label>
                <div className="form-actions">
                  <button type="button" className="secondary-button" onClick={() => { setDraft(candidate.content); setEditing(false); }}>取消</button>
                  <button type="submit" className="primary-button"><Check size={17} aria-hidden="true" />保存编辑</button>
                </div>
              </form>
            ) : <blockquote>{candidate.content}</blockquote>}
          </section>
          <ParticipantBoundary state={state} participantIds={["participant_later", candidate.createdById]} visibility={candidate.visibility} consent={candidate.consent} />
          {candidate.status === "candidate" && !editing && (
            <div className="sticky-actions">
              <button type="button" className="secondary-button" onClick={() => setEditing(true)}><PencilSimple size={17} aria-hidden="true" />编辑候选</button>
              <button type="button" className="primary-button" onClick={() => { setState((current) => acceptCandidate(current, candidate.id, candidate.revision)); announce(`已接受 Candidate revision ${candidate.revision}`); }}><CheckCircle size={17} aria-hidden="true" />接受候选</button>
            </div>
          )}
          {candidate.status === "accepted" && <div className="result-banner success"><CheckCircle size={20} weight="fill" aria-hidden="true" /><span><strong>候选已接受</strong>来源 Agent 与 revision 保持可追溯。</span></div>}
        </div>
        <RelatedEvidence state={state} evidenceIds={candidate.evidenceIds} />
      </div>
    </main>
  );
}

function RunDetail({ state, setState, id, onBack, announce }) {
  const run = findById(state, "runs", id);
  return (
    <main className="detail-page workbench-detail" data-object-id={run.id}>
      <DetailHeader eyebrow="Run · 外部副作用" title={run.title} description="供应商响应丢失后，Chat 不猜测成功，也不盲目重试。" onBack={onBack} />
      <div className="detail-layout">
        <div>
          <section className="fact-grid">
            <article><small>运行状态</small><StatusChip value={run.status} /></article>
            <article><small>对账状态</small><strong>{run.reconciliation === "idle" ? "尚未开始" : run.reconciliation === "querying" ? "正在查询" : "已核验"}</strong></article>
            <article><small>Undo</small><strong>不可用</strong></article>
          </section>
          <section className="detail-section reconciliation-path">
            <SectionHeading title="唯一安全路径" note="查询 → 证据 → 处置" />
            <ol>
              <li className={run.reconciliation !== "idle" ? "is-done" : "is-current"}><span>1</span><div><strong>查询供应商回执</strong><small>使用原始幂等身份，不发起第二次发布。</small></div></li>
              <li className={run.reconciliation === "verified" ? "is-done" : run.reconciliation === "querying" ? "is-current" : ""}><span>2</span><div><strong>绑定新 Evidence</strong><small>只有外部查询结果可以解除 outcome_unknown。</small></div></li>
              <li className={run.status === "succeeded" ? "is-done" : ""}><span>3</span><div><strong>提交正式结果</strong><small>Product Store 拥有最终状态。</small></div></li>
            </ol>
          </section>
          {run.status === "outcome_unknown" && run.reconciliation === "idle" && (
            <div className="sticky-actions"><button type="button" className="primary-button" onClick={() => { setState((current) => startReconciliation(current, run.id)); announce("已开始查询供应商回执；未重试外部动作"); }}><ArrowsClockwise size={17} aria-hidden="true" />开始查询对账</button></div>
          )}
          {run.status === "outcome_unknown" && run.reconciliation === "querying" && (
            <div className="sticky-actions"><button type="button" className="primary-button" onClick={() => { setState((current) => verifyReconciliation(current, run.id)); announce("已用供应商 Evidence 确认外部结果"); }}><SealCheck size={17} aria-hidden="true" />绑定回执并确认结果</button></div>
          )}
          {run.status === "succeeded" && <div className="result-banner success"><SealCheck size={20} weight="fill" aria-hidden="true" /><span><strong>对账完成</strong>确认事件已存在；未执行 Undo 或第二次发布。</span></div>}
        </div>
        <RelatedEvidence state={state} evidenceIds={run.evidenceIds} />
      </div>
    </main>
  );
}

function EvidenceDetail({ state, id, onBack }) {
  const evidence = findById(state, "evidence", id);
  return (
    <main className="detail-page" data-object-id={evidence.id}>
      <DetailHeader eyebrow="Evidence · 只读观察" title={evidence.title} description={`${evidence.source} · ${evidence.observedAt}`} onBack={onBack} />
      <section className="detail-section"><StatusChip value={evidence.integrity} /></section>
    </main>
  );
}

function WorkbenchMode({ state, setState, filter, onFilterChange, agentFilter, onAgentFilter, route, onOpen, onBack, announce }) {
  const detail = route.detail ? objectFromDetail(route.detail) : null;
  if (detail?.type === "decision") return <DecisionDetail state={state} setState={setState} id={detail.id} onBack={onBack} announce={announce} />;
  if (detail?.type === "candidate") return <CandidateDetail state={state} setState={setState} id={detail.id} onBack={onBack} announce={announce} />;
  if (detail?.type === "run") return <RunDetail state={state} setState={setState} id={detail.id} onBack={onBack} announce={announce} />;
  if (detail?.type === "evidence") return <EvidenceDetail state={state} id={detail.id} onBack={onBack} />;

  const feedItems = [
    { type: "decision", object: state.decisions[0], reason: "高影响决定等待版本绑定的接受或修订" },
    { type: "run", object: state.runs[0], reason: "外部副作用结果未知，只能查询对账" },
    { type: "candidate", object: state.candidates[0], reason: "Agent 候选等待编辑或接受" },
    { type: "evidence", object: state.evidence[1], reason: "已核验证据，仅供复核" },
  ].filter((item) => {
    if (filter === "decision" && item.type !== "decision") return false;
    if (filter === "candidate" && item.type !== "candidate") return false;
    if (filter === "run" && item.type !== "run") return false;
    if (filter === "attention") {
      if (item.type === "evidence") return false;
      if (item.type === "decision" || item.type === "candidate") return item.object.status === "candidate";
      if (item.type === "run") return item.object.status === "outcome_unknown";
    }
    if (agentFilter !== "all") {
      const owner = item.type === "decision" || item.type === "candidate" ? item.object.createdById : item.type === "run" ? item.object.agentId : "agent_mochi";
      return owner === agentFilter;
    }
    return true;
  });
  return (
    <main className="mode-page workbench-mode">
      <header className="page-header">
        <div>
          <p className="page-kicker">Evidence Workbench · 多 Agent 监督</p>
          <h1>先看哪里需要人。</h1>
          <p className="page-lede">动态按责任边界分流；点击后回到 Decision、Run、Candidate 或 Evidence 的权威对象。</p>
        </div>
        <div className="page-status">
          <label className="agent-switcher">
            <span className="sr-only">按 Agent 筛选</span>
            <Robot size={17} weight="fill" aria-hidden="true" />
            <select value={agentFilter} onChange={(event) => onAgentFilter(event.target.value)}>
              <option value="all">全部 Agent</option>
              {state.participants.filter((item) => item.kind === "agent").map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.role}</option>)}
            </select>
          </label>
        </div>
      </header>
      <FilterBar label="筛选监督队列" items={WORKBENCH_FILTERS} value={filter} onChange={onFilterChange} />
      <div className="workbench-layout">
        <section className="workbench-feed">
          <SectionHeading title={filter === "attention" ? "需要我介入" : "监督任务"} note={`${feedItems.length} 项 · 不是社交 Feed`} />
          {feedItems.length ? <ul>{feedItems.map((item) => <WorkbenchCard key={`${item.type}-${item.object.id}`} state={state} item={item} onOpen={onOpen} />)}</ul> : <p className="empty-state">这个 Agent 当前没有符合条件的监督任务。</p>}
        </section>
        <aside className="workbench-summary">
          <SectionHeading title="责任边界" note="Chat owns facts" />
          <ul>
            <li><ShieldCheck size={18} aria-hidden="true" /><span><strong>Decision</strong><small>revision、hash、权限、幂等</small></span></li>
            <li><WarningCircle size={18} aria-hidden="true" /><span><strong>Run</strong><small>失败、取消、结果未知分别呈现</small></span></li>
            <li><FileText size={18} aria-hidden="true" /><span><strong>Candidate</strong><small>接受前不成为长期事实</small></span></li>
            <li><Eye size={18} aria-hidden="true" /><span><strong>Visibility</strong><small>参与者、同意与可见范围显式</small></span></li>
          </ul>
        </aside>
      </div>
    </main>
  );
}

function Toast({ toast, onUndo, onDismiss }) {
  if (!toast) return null;
  return (
    <div className="toast" role="status" aria-live="polite">
      <CheckCircle size={20} weight="fill" aria-hidden="true" />
      <span>{toast.message}</span>
      {toast.mutation?.undoable && <button type="button" onClick={onUndo}>撤销</button>}
      <IconButton label="关闭提示" onClick={onDismiss}><X size={17} aria-hidden="true" /></IconButton>
    </div>
  );
}

export function App() {
  const [state, setState] = useState(createInitialState);
  const [route, setRoute] = useState(routeFromLocation);
  const [projectId, setProjectId] = useState("project_chat_solution");
  const [projectFilter, setProjectFilter] = useState("all");
  const [todayFilter, setTodayFilter] = useState("all");
  const [workbenchFilter, setWorkbenchFilter] = useState("attention");
  const [agentFilter, setAgentFilter] = useState("all");
  const [previewMobile, setPreviewMobile] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem("combination-prototype-theme") || "light");
  const [toast, setToast] = useState(null);
  const [announcement, setAnnouncement] = useState("");
  const lastTriggerId = useRef("");
  const listScrollTop = useRef(0);
  const previousRoute = useRef(route);

  const navigate = useCallback((patch, options = {}) => {
    setRoute((current) => {
      const next = { ...current, ...patch };
      const url = new URL(window.location.href);
      url.searchParams.set("mode", next.mode);
      url.searchParams.set("view", next.view || "overview");
      if (next.detail) url.searchParams.set("detail", next.detail);
      else url.searchParams.delete("detail");
      const method = options.replace ? "replaceState" : "pushState";
      window.history[method]({ combinationPrototype: true }, "", url);
      return next;
    });
  }, []);

  const announce = useCallback((message) => {
    setAnnouncement("");
    window.requestAnimationFrame(() => setAnnouncement(message));
  }, []);

  const onModeChange = useCallback((mode) => {
    listScrollTop.current = 0;
    navigate({ mode, view: "overview", detail: "" });
  }, [navigate]);

  const onOpen = useCallback((mode, type, id, triggerId) => {
    lastTriggerId.current = triggerId;
    listScrollTop.current = document.querySelector("#workspace-scroll")?.scrollTop || 0;
    navigate({ mode, view: "detail", detail: `${type}:${id}` });
  }, [navigate]);

  const onBack = useCallback(() => {
    navigate({ view: route.mode === "project" ? "work" : "overview", detail: "" }, { replace: true });
  }, [navigate, route.mode]);

  const onComplete = useCallback((actionId) => {
    const action = findById(state, "actions", actionId);
    const result = completeAction(state, actionId);
    setState(result.state);
    setToast({ message: `已完成“${action.title}”`, mutation: result.mutation });
    announce(`已完成 Action ${action.title}，可撤销`);
  }, [announce, state]);

  const onMove = useCallback((actionId, dayPart) => {
    const action = findById(state, "actions", actionId);
    const result = moveActionToDayPart(state, actionId, dayPart);
    setState(result.state);
    setToast({ message: `已把“${action.title}”移到${dayPart === "day" ? "白天" : "今晚"}`, mutation: result.mutation });
    announce(`已移动 Action ${action.title}，可撤销`);
  }, [announce, state]);

  useEffect(() => {
    const onPopState = () => setRoute(routeFromLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("combination-prototype-theme", theme);
  }, [theme]);

  useEffect(() => {
    document.title = `Chat · ${MODES.find((item) => item.id === route.mode)?.label}`;
    const scroller = document.querySelector("#workspace-scroll");
    const previous = previousRoute.current;
    if (scroller && (previous.mode !== route.mode || (!previous.detail && route.detail))) {
      scroller.scrollTop = 0;
    } else if (scroller && previous.detail && !route.detail) {
      scroller.scrollTop = listScrollTop.current;
    }
    previousRoute.current = route;
    if (!route.detail && lastTriggerId.current) {
      const triggerId = lastTriggerId.current;
      window.requestAnimationFrame(() => {
        const target = document.getElementById(triggerId) || document.querySelector("h1");
        if (target instanceof HTMLElement) {
          if (target.tagName === "H1") target.setAttribute("tabindex", "-1");
          target.focus();
        }
      });
    }
  }, [route]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target instanceof HTMLElement && event.target.matches("input, textarea, select, [contenteditable]")) return;
      if (event.key === "Escape" && route.detail) onBack();
      if (event.key === "1") onModeChange("project");
      if (event.key === "2") onModeChange("today");
      if (event.key === "3") onModeChange("workbench");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onBack, onModeChange, route.detail]);

  const contextProps = useMemo(() => ({
    route,
    state,
    projectId,
    onProjectChange: (id) => { setProjectId(id); navigate({ view: "overview", detail: "" }); },
    filter: route.mode === "project" ? projectFilter : route.mode === "today" ? todayFilter : workbenchFilter,
    onFilterChange: route.mode === "project" ? setProjectFilter : route.mode === "today" ? setTodayFilter : setWorkbenchFilter,
    agentFilter,
    onAgentFilter: setAgentFilter,
  }), [agentFilter, navigate, projectFilter, projectId, route, state, todayFilter, workbenchFilter]);

  return (
    <div className={`prototype-stage ${previewMobile ? "preview-mobile" : ""}`}>
      <div className={`app-shell ${previewMobile ? "force-mobile" : ""}`} data-device={previewMobile ? "mobile" : "responsive"}>
        <GlobalNavigation route={route} onModeChange={onModeChange} />
        <ContextPanel {...contextProps} />
        <section className="workspace">
          <TopBar
            route={route}
            previewMobile={previewMobile}
            onPreviewToggle={() => setPreviewMobile((current) => !current)}
            theme={theme}
            onThemeToggle={() => setTheme((current) => current === "light" ? "dark" : "light")}
          />
          <div className="workspace-scroll" id="workspace-scroll">
            {route.mode === "project" && (
              <ProjectMode
                state={state}
                setState={setState}
                projectId={projectId}
                onProjectChange={(id) => { setProjectId(id); navigate({ view: "overview", detail: "" }); }}
                filter={projectFilter}
                onFilterChange={setProjectFilter}
                route={route}
                navigate={navigate}
                onOpen={onOpen}
                onBack={onBack}
                announce={announce}
                onModeChange={onModeChange}
              />
            )}
            {route.mode === "today" && (
              <TodayMode state={state} filter={todayFilter} onFilterChange={setTodayFilter} route={route} onOpen={onOpen} onBack={onBack} onComplete={onComplete} onMove={onMove} />
            )}
            {route.mode === "workbench" && (
              <WorkbenchMode state={state} setState={setState} filter={workbenchFilter} onFilterChange={setWorkbenchFilter} agentFilter={agentFilter} onAgentFilter={setAgentFilter} route={route} onOpen={onOpen} onBack={onBack} announce={announce} />
            )}
          </div>
        </section>
        <MobileNavigation route={route} onModeChange={onModeChange} />
        <Toast
          toast={toast}
          onDismiss={() => setToast(null)}
          onUndo={() => {
            setState((current) => undoActionMutation(current, toast.mutation));
            setToast(null);
            announce("已撤销 Action 变更");
          }}
        />
        <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
      </div>
    </div>
  );
}
