import {
  BookOpenText,
  Boxes,
  Check,
  ChevronRight,
  CircleAlert,
  ClipboardList,
  Database,
  LoaderCircle,
  PanelRightClose,
  Plus,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
  X,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { ExecutionDraftWorkbench } from "./execution-draft-workbench";
import { ProductDecisionFieldEditor } from "./product-decision-review";
import {
  captureNote,
  createProject,
  createWorkItem,
  getProjectContext,
  latestContextPackage,
  listMemory,
  listNotes,
  listProjects,
  listWorkItems,
  proposeMemory,
  resolveMemoryCandidate,
  type ContextPackage,
  type HarnessMemory,
  type HarnessMemoryCandidate,
  type HarnessNote,
  type HarnessProject,
  type HarnessWorkItem,
  type ProjectContext,
  type ProjectKind,
  type WorkKind,
} from "./harness-api";
import {
  listDurableDecisionRequests,
  resolveDurableDecisionRequest,
  type DurableDecisionRequest,
} from "./hitl-api";
import { WorkbenchNav, type WorkbenchView } from "./workbench-nav";
import type { ProductDecisionEditableField } from "./use-chat-agent";

const PROJECT_KIND_LABELS: Record<string, string> = {
  delivery: "交付项目",
  learning: "学习项目",
  research: "研究项目",
  personal: "个人项目",
};

const STATUS_LABELS: Record<string, string> = {
  proposed: "待激活",
  active: "进行中",
  paused: "已暂停",
  completed: "已完成",
  cancelled: "已取消",
  archived: "已归档",
  draft: "草稿",
  planned: "已规划",
  ready: "可开始",
  in_progress: "进行中",
  blocked: "受阻",
  pending_review: "等待确认",
  accepted: "已接受",
  superseded: "已替代",
  revoked: "已撤销",
  invalid: "已失效",
};

function statusLabel(value: string): string {
  return STATUS_LABELS[value] ?? value;
}

function timeLabel(value: string | null | undefined): string {
  if (!value) return "时间未记录";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function ReadableValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") return <span className="harness-empty-inline">未设置</span>;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return <span>{String(value)}</span>;
  if (Array.isArray(value)) return <ol>{value.map((item, index) => <li key={index}><ReadableValue value={item} /></li>)}</ol>;
  if (typeof value === "object") return <dl>{Object.entries(value as Record<string, unknown>).map(([key, item]) => <div key={key}><dt>{key}</dt><dd><ReadableValue value={item} /></dd></div>)}</dl>;
  return <span>{String(value)}</span>;
}

function EmptyResource({ title, copy }: { title: string; copy: string }) {
  return <div className="harness-empty"><Database size={22} /><strong>{title}</strong><p>{copy}</p></div>;
}

function ProjectExplorer({
  projects,
  selectedProjectId,
  context,
  sessionId,
  onSelect,
  onCreated,
}: {
  projects: HarnessProject[];
  selectedProjectId: string | null;
  context: ProjectContext | null;
  sessionId: string;
  onSelect: (id: string) => void;
  onCreated: (value: HarnessProject) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState<ProjectKind>("delivery");
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !goal.trim()) return;
    setError(null);
    try {
      const value = await createProject({ kind, title, goal, status: "active", session_id: sessionId });
      onCreated(value);
      setCreating(false);
      setTitle("");
      setGoal("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建Project失败");
    }
  };

  return (
    <div className="harness-split-view">
      <section className="harness-resource-list">
        <header><div><p className="eyebrow">AUTHORITATIVE DIRECTORY</p><h3>正式Project</h3></div><button onClick={() => setCreating(true)} type="button"><Plus size={15} />新建</button></header>
        {projects.length === 0 ? <EmptyResource title="还没有正式Project" copy="对话摘要不会冒充Project；由你明确创建后才进入目录。" /> : projects.map((project) => (
          <button className={selectedProjectId === project.id ? "harness-resource-card--active" : ""} key={project.id} onClick={() => onSelect(project.id)} type="button">
            <span className={`harness-status-dot harness-status-dot--${project.status}`} />
            <span><strong>{project.title}</strong><small>{PROJECT_KIND_LABELS[project.kind]} · {statusLabel(project.status)}</small></span>
            <ChevronRight size={15} />
          </button>
        ))}
      </section>
      <section className="harness-detail-pane">
        {creating ? (
          <form className="harness-form" onSubmit={submit}>
            <header><div><p className="eyebrow">EXPLICIT USER COMMAND</p><h3>创建正式Project</h3></div><button aria-label="关闭创建表单" onClick={() => setCreating(false)} type="button"><X size={16} /></button></header>
            <label><span>类型</span><select onChange={(event) => setKind(event.target.value as ProjectKind)} value={kind}>{Object.entries(PROJECT_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label><span>标题</span><input maxLength={180} onChange={(event) => setTitle(event.target.value)} placeholder="例如：贪吃蛇" value={title} /></label>
            <label><span>目标</span><textarea onChange={(event) => setGoal(event.target.value)} placeholder="怎样才算这个Project达成？" rows={6} value={goal} /></label>
            {error && <p className="harness-error"><CircleAlert size={14} />{error}</p>}
            <button className="harness-primary" disabled={!title.trim() || !goal.trim()} type="submit"><Check size={15} />创建并激活</button>
          </form>
        ) : context ? (
          <div className="project-overview">
            <header><p className="eyebrow">PROJECT · REVISION {context.project.row_version}</p><h2>{context.project.title}</h2><p>{context.project.goal}</p><div><span>{PROJECT_KIND_LABELS[context.project.kind]}</span><span>{statusLabel(context.project.status)}</span><time>{timeLabel(context.project.updated_at)}</time></div></header>
            <div className="harness-metric-grid"><div><strong>{context.work_items.length}</strong><span>WorkItem</span></div><div><strong>{context.action_items.filter((value) => !["completed", "cancelled", "skipped"].includes(value.status)).length}</strong><span>开放Action</span></div><div><strong>{context.notes.length}</strong><span>Note</span></div><div><strong>{context.accepted_memory.length}</strong><span>有效Memory</span></div></div>
            <section className="harness-detail-section"><h4>当前工作</h4>{context.work_items.length === 0 ? <p>还没有WorkItem。</p> : context.work_items.map((work) => <article key={work.id}><div><strong>{work.title}</strong><span>{statusLabel(work.status)}</span></div><p>{work.objective}</p><small>{work.kind} · {work.priority} · revision {work.row_version}</small></article>)}</section>
          </div>
        ) : <EmptyResource title="选择一个Project" copy="查看目标、Work、Plan、Action、Note与Accepted Memory的权威状态。" />}
      </section>
    </div>
  );
}

function WorkBoard({ projects, work, selectedProjectId, onProjectChange, onCreated }: {
  projects: HarnessProject[];
  work: HarnessWorkItem[];
  selectedProjectId: string | null;
  onProjectChange: (id: string | null) => void;
  onCreated: (value: HarnessWorkItem) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState<WorkKind>("task");
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [priority, setPriority] = useState("normal");
  const [error, setError] = useState<string | null>(null);
  const groups = useMemo(() => ["blocked", "in_progress", "ready", "planned", "draft", "completed"].map((status) => ({ status, values: work.filter((value) => value.status === status) })).filter((group) => group.values.length > 0), [work]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !objective.trim()) return;
    setError(null);
    try {
      const value = await createWorkItem({ project_id: selectedProjectId, kind, title, objective, priority, status: "draft" });
      onCreated(value); setCreating(false); setTitle(""); setObjective("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "创建WorkItem失败"); }
  };
  return (
    <div className="work-board">
      <header className="harness-toolbar"><div><p className="eyebrow">WORK LIFECYCLE</p><h3>Work Board</h3></div><label><span>Project</span><select onChange={(event) => onProjectChange(event.target.value || null)} value={selectedProjectId ?? ""}><option value="">全部Work</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label><button onClick={() => setCreating((value) => !value)} type="button"><Plus size={15} />新建Work</button></header>
      {creating && <form className="harness-form harness-form--inline" onSubmit={submit}><label><span>类型</span><select onChange={(event) => setKind(event.target.value as WorkKind)} value={kind}><option value="task">任务</option><option value="milestone">里程碑</option><option value="learning_unit">学习单元</option><option value="research_question">研究问题</option></select></label><label><span>标题</span><input onChange={(event) => setTitle(event.target.value)} value={title} /></label><label className="harness-form-wide"><span>目标</span><textarea onChange={(event) => setObjective(event.target.value)} rows={3} value={objective} /></label><label><span>优先级</span><select onChange={(event) => setPriority(event.target.value)} value={priority}><option value="low">低</option><option value="normal">普通</option><option value="high">高</option><option value="critical">关键</option></select></label>{error && <p className="harness-error">{error}</p>}<button className="harness-primary" type="submit"><Check size={15} />创建草稿</button></form>}
      {groups.length === 0 ? <EmptyResource title="没有匹配的WorkItem" copy="明确创建后，Work才会进入生命周期；模型建议本身仍是候选。" /> : <div className="work-board-columns">{groups.map((group) => <section key={group.status}><header><strong>{statusLabel(group.status)}</strong><span>{group.values.length}</span></header>{group.values.map((item) => <article key={item.id}><div><small>{item.kind}</small><span>{item.priority}</span></div><strong>{item.title}</strong><p>{item.objective}</p><footer><code>r{item.row_version}</code><span>{item.completion_evidence.length} Evidence</span></footer></article>)}</section>)}</div>}
    </div>
  );
}

function KnowledgeView({ projects, notes, accepted, candidates, selectedProjectId, onRefresh }: {
  projects: HarnessProject[];
  notes: HarnessNote[];
  accepted: HarnessMemory[];
  candidates: HarnessMemoryCandidate[];
  selectedProjectId: string | null;
  onRefresh: () => void;
}) {
  const [mode, setMode] = useState<"note" | "memory" | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(null);
    try {
      if (mode === "note") await captureNote({ kind: selectedProjectId ? "project_note" : "idea", title, content, project_id: selectedProjectId });
      if (mode === "memory") await proposeMemory({ scope_kind: selectedProjectId ? "project" : "user", scope_ref_id: selectedProjectId, memory_kind: "stable_fact", content });
      setMode(null); setTitle(""); setContent(""); onRefresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
  };
  const decide = async (id: string, decision: "accept" | "reject" | "session_only") => { try { await resolveMemoryCandidate(id, decision); onRefresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : "处理Memory候选失败"); } };
  return <div className="knowledge-view"><header className="harness-toolbar"><div><p className="eyebrow">NOTE ≠ MEMORY</p><h3>Knowledge</h3><p>{selectedProjectId ? `当前Project：${projects.find((value) => value.id === selectedProjectId)?.title}` : "当前查看全部Scope"}</p></div><div><button onClick={() => setMode("note")} type="button"><Plus size={15} />记录Note</button><button onClick={() => setMode("memory")} type="button"><ShieldCheck size={15} />提出Memory</button></div></header>{mode && <form className="harness-form harness-form--inline" onSubmit={submit}>{mode === "note" && <label><span>标题</span><input onChange={(event) => setTitle(event.target.value)} value={title} /></label>}<label className="harness-form-wide"><span>{mode === "note" ? "Note内容" : "长期Memory候选"}</span><textarea onChange={(event) => setContent(event.target.value)} rows={4} value={content} /></label>{error && <p className="harness-error">{error}</p>}<button className="harness-primary" disabled={!content.trim() || (mode === "note" && !title.trim())} type="submit">保存候选</button></form>}<div className="knowledge-grid"><section><header><BookOpenText size={17} /><strong>Note与Revision</strong><span>{notes.length}</span></header>{notes.length === 0 ? <p className="knowledge-empty">没有Note。</p> : notes.map((note) => <article key={note.id}><div><strong>{note.title}</strong><span>{statusLabel(note.status)}</span></div><p>{note.current_revision?.content}</p><small>{note.kind} · revision {note.current_revision?.revision ?? 0}</small></article>)}</section><section><header><ShieldCheck size={17} /><strong>Memory候选</strong><span>{candidates.length}</span></header>{candidates.length === 0 ? <p className="knowledge-empty">没有待处理候选。</p> : candidates.map((candidate) => <article key={candidate.id}><div><strong>{candidate.memory_kind}</strong><span>{statusLabel(candidate.status)}</span></div><p>{candidate.content}</p><footer><button onClick={() => void decide(candidate.id, "reject")} type="button">拒绝</button><button onClick={() => void decide(candidate.id, "session_only")} type="button">仅本会话</button><button className="harness-primary" onClick={() => void decide(candidate.id, "accept")} type="button">接受</button></footer></article>)}<header><ShieldCheck size={17} /><strong>Accepted Memory</strong><span>{accepted.length}</span></header>{accepted.map((memory) => <article key={memory.id}><div><strong>{memory.memory_kind}</strong><span>{statusLabel(memory.status)}</span></div><p>{memory.current_revision?.content}</p><small>{memory.scope_kind} · revision {memory.current_revision?.revision ?? 0}</small></article>)}</section></div></div>;
}

function DurableDecisionCard({ request, onResolved }: { request: DurableDecisionRequest; onResolved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const item = request.items[0];
  const decisionView = item?.subject?.decision_view ?? {};
  const editableFields = Array.isArray(decisionView.editable_fields)
    ? decisionView.editable_fields as ProductDecisionEditableField[]
    : [];
  const [changes, setChanges] = useState<Record<string, unknown>>(() => Object.fromEntries(
    editableFields.map((field) => [field.key, field.value]),
  ));
  if (!item) return <article className="durable-decision-card"><p className="harness-error">决定请求没有可处理项。</p></article>;
  const draftId = request.decision_point_key === "execution_authorization" ? item?.subject?.resource_id : null;
  const resolve = async (decision: string, responsePayload: Record<string, unknown> = {}) => {
    setBusy(true); setError(null);
    try { await resolveDurableDecisionRequest(request, request.items.map((value) => ({ item_key: value.item_key, decision })), responsePayload); onResolved(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "提交决定失败"); }
    finally { setBusy(false); }
  };
  const genericEditor = !draftId && item.allowed_actions.includes("revise") && editableFields.length > 0;
  return <article className="durable-decision-card"><header><div><ShieldCheck size={17} /><span><strong>{request.title}</strong><small>{request.decision_point_key} · {request.runtime_recovery?.status ?? "等待Checkpoint"}</small></span></div><code>{request.request_hash.slice(0, 10)}</code></header><p>{request.reason_summary}</p>{!editing && <section><ReadableValue value={(request.visible_evidence.content as unknown) ?? decisionView.content ?? decisionView} /></section>}{editing && draftId && <ExecutionDraftWorkbench busy={busy} draftId={draftId} onReapprove={(revisionId) => void resolve("revise", { changes: { execution_draft_revision_id: revisionId } })} />}{editing && genericEditor && <section className="product-decision-fields durable-decision-fields" aria-label="修改持久决定内容">{editableFields.map((field) => <label key={field.key}><span>{field.label}</span><ProductDecisionFieldEditor field={field} onChange={(value) => setChanges((current) => ({ ...current, [field.key]: value }))} value={changes[field.key]} /></label>)}</section>}{error && <p className="harness-error">{error}</p>}<footer>{item.allowed_actions.includes("revise") && !editing && <button disabled={busy} onClick={() => setEditing(true)} type="button">修改内容</button>}{genericEditor && editing && <button disabled={busy} onClick={() => void resolve("revise", { changes })} type="button">保存修改并重新评估</button>}{item.allowed_actions.filter((action) => action !== "revise").map((action) => <button className={["accept", "approve", "execute", "commit"].includes(action) ? "harness-primary" : ""} disabled={busy} key={action} onClick={() => void resolve(action)} type="button">{action === "cancel" ? "停止Run" : action === "skip" ? "本轮跳过" : action === "accept" ? "接受并继续" : action === "execute" ? "授权并继续" : action === "commit" ? "提交并继续" : action}</button>)}</footer></article>;
}

function ContextInspector({ context, decisions, onRefresh }: { context: ContextPackage | null; decisions: DurableDecisionRequest[]; onRefresh: () => void }) {
  const adopted = context?.items.filter((value) => value.adopted) ?? [];
  const excluded = context?.items.filter((value) => !value.adopted) ?? [];
  return <div className="context-inspector"><header className="harness-toolbar"><div><p className="eyebrow">SOURCE · REVISION · REASON</p><h3>Context Inspector</h3><p>检查本轮采用了什么、排除了什么，以及为什么。</p></div><button onClick={onRefresh} type="button"><RefreshCw size={15} />刷新</button></header>{decisions.length > 0 && <section className="durable-decision-inbox"><header><CircleAlert size={18} /><div><strong>待处理的跨进程HITL</strong><p>决定提交后由Outbox Worker从版本绑定的MAF Checkpoint继续。</p></div><span>{decisions.length}</span></header>{decisions.map((request) => <DurableDecisionCard key={request.id} onResolved={onRefresh} request={request} />)}</section>}{!context ? <EmptyResource title="本会话还没有ContextPackage" copy="运行持续协作Workflow后，阶段A目录和阶段B详情会在这里留下可审核快照。" /> : <><section className="context-summary"><div><strong>{context.estimated_tokens}</strong><span>估算Tokens</span></div><div><strong>{context.token_budget}</strong><span>预算上限</span></div><div><strong>{adopted.length}</strong><span>采用来源</span></div><div><strong>{excluded.length}</strong><span>排除来源</span></div><footer><span>{context.stage === "detail" ? "阶段B · 目标详情" : "阶段A · 轻量目录"}</span><code>{context.package_hash.slice(0, 14)}</code></footer></section><div className="context-columns"><section><header><Check size={17} /><strong>已采用</strong><span>{adopted.length}</span></header>{adopted.map((item) => <article key={`${item.source_kind}:${item.source_id}`}><div><strong>{item.title}</strong><span>{item.token_estimate} tokens</span></div><p>{item.reason}</p><small>{item.source_kind} · {item.source_id} · revision {item.source_revision ?? "-"}</small><details><summary>查看采用内容</summary><pre>{item.content}</pre></details></article>)}</section><section><header><X size={17} /><strong>已排除</strong><span>{excluded.length}</span></header>{excluded.length === 0 ? <p className="knowledge-empty">本包没有排除项。</p> : excluded.map((item) => <article key={`${item.source_kind}:${item.source_id}`}><strong>{item.title}</strong><p>{item.reason}</p><small>{item.token_estimate} tokens · {item.source_kind}</small></article>)}</section></div></>}
  </div>;
}

export function HarnessWorkbench({ sessionId, view, onViewChange, onClose }: { sessionId: string; view: Exclude<WorkbenchView, "workflow">; onViewChange: (view: WorkbenchView) => void; onClose: () => void }) {
  const [projects, setProjects] = useState<HarnessProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projectContext, setProjectContext] = useState<ProjectContext | null>(null);
  const [work, setWork] = useState<HarnessWorkItem[]>([]);
  const [notes, setNotes] = useState<HarnessNote[]>([]);
  const [accepted, setAccepted] = useState<HarnessMemory[]>([]);
  const [candidates, setCandidates] = useState<HarnessMemoryCandidate[]>([]);
  const [context, setContext] = useState<ContextPackage | null>(null);
  const [decisions, setDecisions] = useState<DurableDecisionRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [projectValues, workValues, noteValues, memoryValues, contextValue, decisionValues] = await Promise.all([listProjects(), listWorkItems(selectedProjectId), listNotes(selectedProjectId), listMemory(), latestContextPackage(sessionId), listDurableDecisionRequests(sessionId)]);
      setProjects(projectValues); setWork(workValues); setNotes(noteValues); setAccepted(memoryValues.accepted); setCandidates(memoryValues.candidates); setContext(contextValue); setDecisions(decisionValues);
      const target = selectedProjectId ?? (view === "projects" ? projectValues[0]?.id ?? null : null);
      if (target && target !== selectedProjectId) setSelectedProjectId(target);
      setProjectContext(target ? await getProjectContext(target) : null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "读取Product Harness失败"); }
    finally { setLoading(false); }
  }, [selectedProjectId, sessionId, view]);

  useEffect(() => { void refresh(); }, [refresh]);

  const selectProject = (id: string | null) => { setSelectedProjectId(id); if (id) void getProjectContext(id).then(setProjectContext).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "读取Project失败")); else setProjectContext(null); };
  const title = view === "projects" ? "Project Explorer" : view === "work" ? "Work Board" : view === "knowledge" ? "Knowledge" : "Context Inspector";
  const icon = view === "projects" ? <Boxes size={20} /> : view === "work" ? <ClipboardList size={20} /> : view === "knowledge" ? <BookOpenText size={20} /> : <ScanSearch size={20} />;

  return <aside className="workbench harness-workbench" aria-label={`${title} 工作台`}><header className="workbench-header"><div>{icon}<span><p className="eyebrow">PRODUCT HARNESS</p><strong>{title}</strong></span></div><button aria-label="关闭工作台" onClick={onClose} type="button"><PanelRightClose size={20} /></button></header><WorkbenchNav active={view} onChange={onViewChange} pendingCount={decisions.length} /><div className="workbench-body harness-workbench-body">{loading && <div className="harness-loading"><LoaderCircle size={20} />正在读取权威产品事实…</div>}{error && <p className="harness-error"><CircleAlert size={15} />{error}</p>}{!loading && view === "projects" && <ProjectExplorer context={projectContext} onCreated={(value) => { setProjects((current) => [value, ...current]); selectProject(value.id); }} onSelect={(id) => selectProject(id)} projects={projects} selectedProjectId={selectedProjectId} sessionId={sessionId} />}{!loading && view === "work" && <WorkBoard onCreated={(value) => setWork((current) => [value, ...current])} onProjectChange={(id) => selectProject(id)} projects={projects} selectedProjectId={selectedProjectId} work={work} />}{!loading && view === "knowledge" && <KnowledgeView accepted={accepted} candidates={candidates} notes={notes} onRefresh={() => void refresh()} projects={projects} selectedProjectId={selectedProjectId} />}{!loading && view === "context" && <ContextInspector context={context} decisions={decisions} onRefresh={() => void refresh()} />}</div></aside>;
}
