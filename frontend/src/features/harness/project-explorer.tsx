import { Check, ChevronRight, CircleAlert, Database, Plus, X } from "lucide-react";
import { type FormEvent, useState } from "react";

import {
  createProject,
  type HarnessProject,
  type ProjectContext,
  type ProjectKind,
} from "./harness-api";
import { ProjectRepositories } from "./project-repositories";

const PROJECT_KIND_LABELS: Record<ProjectKind, string> = {
  delivery: "交付项目",
  learning: "学习项目",
  research: "研究项目",
  personal: "个人项目",
};

const PROJECT_STATUS_LABELS: Record<string, string> = {
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
};

function statusLabel(value: string): string {
  return PROJECT_STATUS_LABELS[value] ?? value;
}

function timeLabel(value: string | null | undefined): string {
  if (!value) return "时间未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function ProjectEmpty({ title, copy }: { title: string; copy: string }) {
  return (
    <div className="harness-empty">
      <Database size={22} />
      <strong>{title}</strong>
      <p>{copy}</p>
    </div>
  );
}

/**
 * Project Explorer owns only Project-page interaction state.
 *
 * Product facts remain server-owned. Repository commands return the new Project
 * row version and this component forwards it to the parent projection so the
 * next CAS command never relies on a stale revision.
 */
export function ProjectExplorer({
  projects,
  selectedProjectId,
  context,
  sessionId,
  onSelect,
  onCreated,
  onProjectRowVersionChange,
}: {
  projects: HarnessProject[];
  selectedProjectId: string | null;
  context: ProjectContext | null;
  sessionId: string;
  onSelect: (id: string) => void;
  onCreated: (value: HarnessProject) => void;
  onProjectRowVersionChange: (projectId: string, rowVersion: number) => void;
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
      const value = await createProject({
        kind,
        title,
        goal,
        status: "active",
        session_id: sessionId,
      });
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
        <header>
          <div>
            <p className="eyebrow">AUTHORITATIVE DIRECTORY</p>
            <h3>正式Project</h3>
          </div>
          <button onClick={() => setCreating(true)} type="button">
            <Plus size={15} />
            新建
          </button>
        </header>
        {projects.length === 0 ? (
          <ProjectEmpty
            title="还没有正式Project"
            copy="对话摘要不会冒充Project；由你明确创建后才进入目录。"
          />
        ) : (
          projects.map((project) => (
            <button
              className={selectedProjectId === project.id ? "harness-resource-card--active" : ""}
              key={project.id}
              onClick={() => onSelect(project.id)}
              type="button"
            >
              <span className={`harness-status-dot harness-status-dot--${project.status}`} />
              <span>
                <strong>{project.title}</strong>
                <small>
                  {PROJECT_KIND_LABELS[project.kind]} · {statusLabel(project.status)}
                </small>
              </span>
              <ChevronRight size={15} />
            </button>
          ))
        )}
      </section>
      <section className="harness-detail-pane">
        {creating ? (
          <form className="harness-form" onSubmit={submit}>
            <header>
              <div>
                <p className="eyebrow">EXPLICIT USER COMMAND</p>
                <h3>创建正式Project</h3>
              </div>
              <button aria-label="关闭创建表单" onClick={() => setCreating(false)} type="button">
                <X size={16} />
              </button>
            </header>
            <label>
              <span>类型</span>
              <select onChange={(event) => setKind(event.target.value as ProjectKind)} value={kind}>
                {Object.entries(PROJECT_KIND_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>标题</span>
              <input
                maxLength={180}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="例如：贪吃蛇"
                value={title}
              />
            </label>
            <label>
              <span>目标</span>
              <textarea
                onChange={(event) => setGoal(event.target.value)}
                placeholder="怎样才算这个Project达成？"
                rows={6}
                value={goal}
              />
            </label>
            {error && (
              <p className="harness-error">
                <CircleAlert size={14} />
                {error}
              </p>
            )}
            <button
              className="harness-primary"
              disabled={!title.trim() || !goal.trim()}
              type="submit"
            >
              <Check size={15} />
              创建并激活
            </button>
          </form>
        ) : context ? (
          <div className="project-overview">
            <header>
              <p className="eyebrow">PROJECT · REVISION {context.project.row_version}</p>
              <h2>{context.project.title}</h2>
              <p>{context.project.goal}</p>
              <div>
                <span>{PROJECT_KIND_LABELS[context.project.kind]}</span>
                <span>{statusLabel(context.project.status)}</span>
                <time>{timeLabel(context.project.updated_at)}</time>
              </div>
            </header>
            <div className="harness-metric-grid">
              <div>
                <strong>{context.work_items.length}</strong>
                <span>WorkItem</span>
              </div>
              <div>
                <strong>
                  {
                    context.action_items.filter(
                      (value) => !["completed", "cancelled", "skipped"].includes(value.status),
                    ).length
                  }
                </strong>
                <span>开放Action</span>
              </div>
              <div>
                <strong>{context.notes.length}</strong>
                <span>Note</span>
              </div>
              <div>
                <strong>{context.accepted_memory.length}</strong>
                <span>有效Memory</span>
              </div>
            </div>
            <ProjectRepositories
              onProjectRowVersionChange={(rowVersion) =>
                onProjectRowVersionChange(context.project.id, rowVersion)
              }
              projectId={context.project.id}
              projectRowVersion={context.project.row_version}
            />
            <section className="harness-detail-section">
              <h4>当前工作</h4>
              {context.work_items.length === 0 ? (
                <p>还没有WorkItem。</p>
              ) : (
                context.work_items.map((work) => (
                  <article key={work.id}>
                    <div>
                      <strong>{work.title}</strong>
                      <span>{statusLabel(work.status)}</span>
                    </div>
                    <p>{work.objective}</p>
                    <small>
                      {work.kind} · {work.priority} · revision {work.row_version}
                    </small>
                  </article>
                ))
              )}
            </section>
          </div>
        ) : (
          <ProjectEmpty
            title="选择一个Project"
            copy="查看目标、Work、Plan、Action、Note、Accepted Memory与代码资源。"
          />
        )}
      </section>
    </div>
  );
}
