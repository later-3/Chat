import {
  ArrowRight,
  BookOpenCheck,
  BriefcaseBusiness,
  CircleAlert,
  FlaskConical,
  FolderKanban,
  HeartHandshake,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  UserRound,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ApiError } from "../../api-client";
import {
  getWorkspaceProjection,
  type ProjectCardProjection,
  type ProjectionEnvelope,
  type WorkspaceDomain,
  type WorkspaceProjectionData,
} from "../projections/projection-api";
import { ProjectDossier } from "../projects/project-dossier";
import "./workspace.css";

const DOMAIN_ITEMS: Array<{
  id: WorkspaceDomain;
  label: string;
  icon: typeof Sparkles;
}> = [
  { id: "all", label: "全部", icon: Sparkles },
  { id: "life", label: "生活", icon: HeartHandshake },
  { id: "work", label: "工作", icon: BriefcaseBusiness },
  { id: "learning", label: "学习", icon: BookOpenCheck },
  { id: "research", label: "研究", icon: FlaskConical },
];

const STATUS_LABELS: Record<string, string> = {
  proposed: "待确认",
  active: "进行中",
  paused: "已暂停",
  completed: "已完成",
  blocked: "受阻",
  ready: "可开始",
  in_progress: "推进中",
};

export function WorkspaceView({
  searchQuery,
  selectedProjectId,
  onCreateProject,
  onManageProjects,
  onSelectProject,
  onContinueProject,
}: {
  searchQuery: string;
  selectedProjectId: string | null;
  onCreateProject: () => void;
  onManageProjects: () => void;
  onSelectProject: (projectId: string | null) => void;
  onContinueProject: (title: string, projectId: string) => void;
}) {
  const [domain, setDomain] = useState<WorkspaceDomain>("all");
  const [projection, setProjection] = useState<ProjectionEnvelope<WorkspaceProjectionData> | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const lastProjectButton = useRef<string | null>(null);

  useEffect(() => {
    void refreshVersion;
    if (selectedProjectId) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void getWorkspaceProjection(domain, controller.signal)
      .then(setProjection)
      .catch((reason: unknown) => {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) {
          setError(reason instanceof Error ? reason : new Error("读取个人工作台失败"));
        }
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [domain, refreshVersion, selectedProjectId]);

  if (selectedProjectId) {
    return (
      <ProjectDossier
        onBack={() => {
          onSelectProject(null);
          window.requestAnimationFrame(() => {
            if (lastProjectButton.current)
              document.getElementById(lastProjectButton.current)?.focus();
          });
        }}
        onContinue={onContinueProject}
        onManage={onManageProjects}
        projectId={selectedProjectId}
      />
    );
  }

  if (loading && !projection) {
    return (
      <main className="workspace-state" role="status">
        <RefreshCw className="workspace-spin" size={24} />
        <strong>正在组合你的个人工作台</strong>
        <p>读取Project、Work、Action、Note和来源revision…</p>
      </main>
    );
  }
  if (error && !projection) {
    return (
      <main className="workspace-state" role="alert">
        <CircleAlert size={24} />
        <strong>工作台暂时不可用</strong>
        <p>{errorDetail(error)}</p>
        <button onClick={() => setRefreshVersion((value) => value + 1)} type="button">
          重试
        </button>
      </main>
    );
  }
  if (!projection) return null;

  const query = searchQuery.trim().toLocaleLowerCase("zh-CN");
  const visibleProjects = projection.data.projects.filter(
    (project) =>
      !query ||
      project.title.toLocaleLowerCase("zh-CN").includes(query) ||
      project.goal.toLocaleLowerCase("zh-CN").includes(query),
  );

  const openProject = (projectId: string) => {
    const elementId = projectButtonId(projectId);
    lastProjectButton.current = elementId;
    onSelectProject(projectId);
    window.requestAnimationFrame(() => document.getElementById("project-dossier")?.focus());
  };

  return (
    <main className="workspace-view">
      <section className="workspace-hero">
        <div>
          <span className="workspace-hero__kicker">
            <Sparkles size={17} /> 同一套事实，承载生活、工作、学习和研究
          </span>
          <h1>我的工作台</h1>
          <p>不用翻回某段聊天，也能知道每个Project为什么存在、现在怎样、下一步由谁推进。</p>
        </div>
        <div className="workspace-hero__actions">
          <button className="workspace-manage" onClick={onManageProjects} type="button">
            <FolderKanban size={17} /> 管理Project与资源
          </button>
          <button className="workspace-create" onClick={onCreateProject} type="button">
            <Plus size={17} /> 新建Project
          </button>
        </div>
      </section>

      <div className="workspace-trust-banner">
        <ShieldCheck size={16} />
        <span>
          当前为固定本地Scope的只读Projection；Web和Obsidian共享同一Project ID与revision。
        </span>
        <time>{formatTimestamp(projection.source_snapshot_at)}</time>
      </div>

      {projection.data.limits.projects_truncated ||
      projection.data.limits.independent_items_truncated ? (
        <p className="workspace-inline-error" role="status">
          <CircleAlert size={15} />{" "}
          当前视图已达到读取上限，仅显示最近更新的对象；全量浏览仍需稳定Cursor。
        </p>
      ) : null}

      <nav aria-label="工作台领域筛选" className="workspace-domain-nav">
        {DOMAIN_ITEMS.map((item) => {
          const Icon = item.icon;
          const count =
            item.id === "all"
              ? projection.data.summary.project_count
              : (projection.data.domains.find((value) => value.id === item.id)?.project_count ?? 0);
          return (
            <button
              aria-current={domain === item.id ? "page" : undefined}
              className={domain === item.id ? "is-active" : ""}
              key={item.id}
              onClick={() => setDomain(item.id)}
              type="button"
            >
              <Icon size={17} />
              <span>{item.label}</span>
              <em>{count}</em>
            </button>
          );
        })}
      </nav>

      <section aria-label="工作台状态摘要" className="workspace-summary">
        <SummaryMetric label="当前Project" value={projection.data.summary.project_count} />
        <SummaryMetric label="开放Work" value={projection.data.summary.open_work_count} />
        <SummaryMetric label="开放Action" value={projection.data.summary.open_action_count} />
        <SummaryMetric
          attention={projection.data.summary.blocked_count > 0}
          label="阻塞"
          value={projection.data.summary.blocked_count}
        />
      </section>

      {error ? (
        <p className="workspace-inline-error" role="alert">
          <CircleAlert size={15} /> {errorDetail(error)}
        </p>
      ) : null}

      <section className="workspace-projects">
        <header className="workspace-section-title">
          <div>
            <span>{domainLabel(domain)}</span>
            <h2>{query ? `“${searchQuery.trim()}” 的Project` : "持续推进中的Project"}</h2>
          </div>
          <small>{visibleProjects.length} 项</small>
        </header>
        {visibleProjects.length ? (
          <div className="workspace-project-grid">
            {visibleProjects.map((project) => (
              <ProjectCard
                key={project.id}
                onContinue={() => onContinueProject(project.title, project.id)}
                onOpen={() => openProject(project.id)}
                project={project}
              />
            ))}
          </div>
        ) : (
          <div className="workspace-empty">
            <FolderKanban size={24} />
            <strong>{query ? "没有匹配的Project" : "这个领域还没有正式Project"}</strong>
            <p>
              {query
                ? "搜索只读取正式Project的标题和目标，不会让模型猜测结果。"
                : "创建后才进入权威目录；聊天里提到一个想法不会自动冒充Project。"}
            </p>
            {!query ? (
              <button onClick={onCreateProject} type="button">
                新建Project
              </button>
            ) : null}
          </div>
        )}
      </section>

      {domain === "all" && projection.data.independent_work.length ? (
        <section className="workspace-loose-work">
          <header className="workspace-section-title">
            <div>
              <span>未归类</span>
              <h2>不属于任何Project的独立事项</h2>
            </div>
          </header>
          <div>
            {projection.data.independent_work.map((raw, index) => {
              const item = asRecord(raw);
              return (
                <article key={asText(item.id, String(index))}>
                  <strong>{asText(item.title, "未命名事项")}</strong>
                  <p>{asText(item.objective, "目标未记录")}</p>
                  <span>{asText(item.status, "unknown")}</span>
                </article>
              );
            })}
          </div>
          <p>Projection不会猜这些事项属于工作还是生活；归属需要正式命令。</p>
        </section>
      ) : null}

      {(domain === "all" || domain === "learning") && projection.data.learning_queue.length ? (
        <section className="workspace-learning-strip">
          <header className="workspace-section-title">
            <div>
              <span>学习复习队列</span>
              <h2>下一次复习时间仍需Schedule</h2>
            </div>
          </header>
          <div>
            {projection.data.learning_queue.map((item) => (
              <button
                key={item.project_id}
                onClick={() => openProject(item.project_id)}
                type="button"
              >
                <BookOpenCheck size={18} />
                <span>
                  <strong>{item.title}</strong>
                  <small>
                    {item.unit_counts.completed}/{item.unit_counts.total} 个学习Work完成 · 下一复习
                    unknown
                  </small>
                </span>
                <ArrowRight size={16} />
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}

function ProjectCard({
  project,
  onOpen,
  onContinue,
}: {
  project: ProjectCardProjection;
  onOpen: () => void;
  onContinue: () => void;
}) {
  const primaryAction = project.next_actions[0];
  return (
    <article className={`workspace-project-card workspace-project-card--${project.domain}`}>
      <header>
        <span className={`workspace-domain workspace-domain--${project.domain}`}>
          {domainLabel(project.domain)}
        </span>
        <span className={`workspace-status workspace-status--${project.status}`}>
          {STATUS_LABELS[project.status] ?? project.status}
        </span>
      </header>
      <h3>{project.title}</h3>
      <p>{project.goal}</p>
      <div className="workspace-card-facts">
        <span>{project.counts.open_work} Work</span>
        <span>{project.counts.open_actions} Action</span>
        <span className={project.counts.blocked ? "is-attention" : ""}>
          {project.counts.blocked} 阻塞
        </span>
      </div>
      <section className="workspace-role-counts" aria-label="责任分配">
        <span>
          <UserRound size={14} /> 你 {project.responsibility_counts.user}
        </span>
        <span>
          <Sparkles size={14} /> AI {project.responsibility_counts.agent}
        </span>
        <span>
          <HeartHandshake size={14} /> 外部 {project.responsibility_counts.external}
        </span>
      </section>
      <div className="workspace-next-action">
        <small>下一行动</small>
        <strong>{primaryAction?.title ?? "尚未形成正式下一行动"}</strong>
        <span>
          {primaryAction
            ? `${roleLabel(primaryAction.assignee_kind)} · ${STATUS_LABELS[primaryAction.status] ?? primaryAction.status}`
            : "需要补充Action或接受Plan"}
        </span>
      </div>
      <footer>
        <button onClick={onContinue} type="button">
          在对话中继续
        </button>
        <button id={projectButtonId(project.id)} onClick={onOpen} type="button">
          打开档案 <ArrowRight size={15} />
        </button>
      </footer>
    </article>
  );
}

function SummaryMetric({
  value,
  label,
  attention = false,
}: {
  value: number;
  label: string;
  attention?: boolean;
}) {
  return (
    <div className={attention ? "is-attention" : ""}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function projectButtonId(projectId: string): string {
  return `workspace-project-${projectId}`;
}

function domainLabel(value: string): string {
  return (
    { all: "全部", work: "工作", learning: "学习", research: "研究", life: "生活" }[value] ?? value
  );
}

function roleLabel(value: string): string {
  return { user: "你来做", agent: "Chat / AI", external: "外部协作" }[value] ?? value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asText(value: unknown, fallback: string): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

function errorDetail(error: Error): string {
  return error instanceof ApiError
    ? `${error.message}（${error.code} · ${error.requestId}）`
    : error.message;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "来源时间未知";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}
