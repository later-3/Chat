import { useMemo, useState } from "react";
import type { HostObservable, InjectFace } from "@deepseek-ai/dsh-client-ui-slots";
import type { ConvViewProps } from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { ProjectManagedObjectKind, ProjectObjectSummaryDto } from "@chat/contracts/public";
import type { ProjectManagementState } from "./project-management-controller.ts";

export interface ProjectManagementInjected {
  hooks: { projectManagement: HostObservable<ProjectManagementState> };
  refresh: () => Promise<void>;
  select: (projectId: string) => Promise<void>;
  setQueryText: (value: string) => void;
  setQueryKind: (value: ProjectManagedObjectKind | null) => void;
  runQuery: () => Promise<void>;
}

export type ProjectManagementViewProps = ConvViewProps & InjectFace<ProjectManagementInjected>;
export type ProjectManagementContentProps = InjectFace<ProjectManagementInjected>;
type ProjectTab = "home" | "timeline" | "review" | "query";

const TAB_LABEL: Record<ProjectTab, string> = {
  home: "Project",
  timeline: "Timeline",
  review: "Review",
  query: "Query",
};

const KIND_LABEL: Partial<Record<ProjectManagedObjectKind, string>> = {
  project: "项目",
  profile: "管理类型",
  configuration: "管理配置",
  need: "用户需要",
  requirement: "需求",
  work: "工作",
  action: "行动",
  claim: "认领",
  block: "阻塞",
  handoff: "交接",
  review: "审核",
  resource: "资源",
  artifact: "产物",
  evidence: "证据",
  decision: "决定",
  practice: "实践方法",
  metric: "指标",
  event: "事件",
  competency: "能力",
  assessment: "测评",
  publication: "发布",
  report: "报告",
};

function dateTime(value: string | undefined): string {
  if (value === undefined) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}

function Empty({ children }: { readonly children: string }) {
  return <p className="lifeos-project-empty">{children}</p>;
}

function ObjectCard({ item }: { readonly item: ProjectObjectSummaryDto }) {
  return (
    <article className="lifeos-project-object" data-kind={item.kind}>
      <header>
        <span>{KIND_LABEL[item.kind] ?? item.kind}</span>
        {item.status === undefined ? null : (
          <strong data-status={item.status}>{item.status}</strong>
        )}
      </header>
      <h3>{item.title}</h3>
      {item.attentionReasons.length === 0 ? null : (
        <ul className="lifeos-project-attention-list">
          {item.attentionReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      <footer>
        <code>{item.objectId}</code>
        <time dateTime={item.updatedAt ?? item.occurredAt}>
          {dateTime(item.updatedAt ?? item.occurredAt)}
        </time>
      </footer>
    </article>
  );
}

function HomeView({ state }: { readonly state: ProjectManagementState }) {
  const home = state.home;
  const workspace = state.workspace;
  if (home === null || workspace === null) return <Empty>项目详情尚未载入。</Empty>;
  const counts = Object.entries(home.objectCounts)
    .filter(([, count]) => count !== undefined && count > 0)
    .sort(([, left], [, right]) => (right ?? 0) - (left ?? 0));
  return (
    <div className="lifeos-project-home" data-testid="lifeos-project-home">
      <section className="lifeos-project-hero">
        <div>
          <span>{home.profile.title}</span>
          <h2>{home.name}</h2>
          <p>{home.objective}</p>
        </div>
        <dl>
          <div>
            <dt>状态</dt>
            <dd>{home.status}</dd>
          </div>
          <div>
            <dt>管理配置</dt>
            <dd>v{home.configuration.version}</dd>
          </div>
          <div>
            <dt>当前阶段</dt>
            <dd>{workspace.stage.name}</dd>
          </div>
        </dl>
      </section>

      <section className="lifeos-project-counts" aria-label="项目对象数量">
        {counts.map(([kind, count]) => (
          <article key={kind}>
            <strong>{String(count)}</strong>
            <span>{KIND_LABEL[kind as ProjectManagedObjectKind] ?? kind}</span>
          </article>
        ))}
      </section>

      <div className="lifeos-project-grid">
        <section className="lifeos-project-panel">
          <header>
            <h3>现在需要关注</h3>
            <span>{home.attention.length} 项</span>
          </header>
          {home.attention.length === 0 ? (
            <Empty>当前没有阻塞、待审或异常对象。</Empty>
          ) : (
            <div className="lifeos-project-object-list">
              {home.attention.slice(0, 8).map((item) => (
                <ObjectCard key={`${item.kind}:${item.objectId}`} item={item} />
              ))}
            </div>
          )}
        </section>

        <section className="lifeos-project-panel">
          <header>
            <h3>资源与连接</h3>
            <span>{workspace.resources.length + workspace.providerBindings.length} 个连接</span>
          </header>
          <div className="lifeos-project-binding-list">
            {workspace.resources.map((resource) => (
              <article key={resource.projectResourceId}>
                <div>
                  <strong>{resource.displayName}</strong>
                  <span>Workspace Resource</span>
                </div>
                <code>{resource.status}</code>
              </article>
            ))}
            {workspace.providerBindings.map((binding) => (
              <article key={binding.projectProviderBindingId} data-provider={binding.providerKind}>
                <div>
                  <strong>{binding.providerKind}</strong>
                  <span>{binding.externalProjectIdentifier}</span>
                </div>
                <code>{binding.status}</code>
              </article>
            ))}
          </div>
        </section>
      </div>

      <section className="lifeos-project-panel">
        <header>
          <h3>呈现能力</h3>
          <span>Profile 要求与当前绑定</span>
        </header>
        <div className="lifeos-project-surfaces">
          {home.presentationSurfaces.map((surface) => (
            <article key={surface.capability} data-availability={surface.availability}>
              <strong>{surface.capability}</strong>
              <span>{surface.availability}</span>
              <small>
                {surface.binding === null
                  ? `fallback: ${surface.fallbackIntent}`
                  : `${surface.binding.providerKind} · ${surface.binding.mode}`}
              </small>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function TimelineView({ state }: { readonly state: ProjectManagementState }) {
  if (state.timeline.length === 0) return <Empty>还没有时间线事件。</Empty>;
  return (
    <ol className="lifeos-project-timeline" data-testid="lifeos-project-timeline">
      {state.timeline.map((item) => (
        <li key={`${item.kind}:${item.id}`}>
          <time dateTime={item.occurredAt}>{dateTime(item.occurredAt)}</time>
          <div>
            <span>{item.kind}</span>
            <strong>{item.title}</strong>
            <code>{item.id}</code>
          </div>
        </li>
      ))}
    </ol>
  );
}

function ReviewView({ state }: { readonly state: ProjectManagementState }) {
  const review = state.review;
  if (review === null || review.items.length === 0) {
    return <Empty>当前没有等待用户确认、验收或采用的对象。</Empty>;
  }
  return (
    <section className="lifeos-project-review" data-testid="lifeos-project-review">
      <header>
        <div>
          <h2>待你审核</h2>
          <p>这里只投影需要人作出决定的对象；Chat Product Store仍是权威事实。</p>
        </div>
        <strong>{review.total}</strong>
      </header>
      <div className="lifeos-project-object-list">
        {review.items.map((item) => (
          <ObjectCard key={`${item.kind}:${item.objectId}`} item={item} />
        ))}
      </div>
    </section>
  );
}

function QueryView({
  state,
  setQueryText,
  setQueryKind,
  runQuery,
}: {
  readonly state: ProjectManagementState;
  readonly setQueryText: (value: string) => void;
  readonly setQueryKind: (value: ProjectManagedObjectKind | null) => void;
  readonly runQuery: () => Promise<void>;
}) {
  const kinds = useMemo(
    () =>
      Object.keys(state.home?.objectCounts ?? {})
        .filter((kind) => (state.home?.objectCounts[kind as ProjectManagedObjectKind] ?? 0) > 0)
        .sort() as ProjectManagedObjectKind[],
    [state.home],
  );
  return (
    <section className="lifeos-project-query" data-testid="lifeos-project-query">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void runQuery();
        }}
      >
        <label>
          <span>搜索对象</span>
          <input
            value={state.queryText}
            placeholder="标题、状态或对象 ID"
            onChange={(event) => setQueryText(event.currentTarget.value)}
          />
        </label>
        <label>
          <span>对象类型</span>
          <select
            value={state.queryKind ?? ""}
            onChange={(event) =>
              setQueryKind(
                event.currentTarget.value === ""
                  ? null
                  : (event.currentTarget.value as ProjectManagedObjectKind),
              )
            }
          >
            <option value="">全部对象</option>
            {kinds.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABEL[kind] ?? kind}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">查询</button>
      </form>
      <header className="lifeos-project-query-result">
        <strong>{state.query?.total ?? 0} 个对象</strong>
        <span>同一查询合同也供 Agent Context 与其他 Viewer 复用</span>
      </header>
      {state.query === null || state.query.items.length === 0 ? (
        <Empty>没有符合条件的对象。</Empty>
      ) : (
        <div className="lifeos-project-object-list">
          {state.query.items.map((item) => (
            <ObjectCard key={`${item.kind}:${item.objectId}`} item={item} />
          ))}
        </div>
      )}
    </section>
  );
}

export function ProjectManagementContent({
  useProjectManagement,
  refresh,
  select,
  setQueryText,
  setQueryKind,
  runQuery,
}: ProjectManagementContentProps) {
  const state = useProjectManagement((value) => value);
  const [tab, setTab] = useState<ProjectTab>("home");
  return (
    <section className="lifeos-projects" aria-label="项目管理" data-testid="lifeos-projects">
      <header className="lifeos-projects-toolbar">
        <div>
          <small>Chat Project Management</small>
          <strong>项目</strong>
        </div>
        <div>
          <select
            aria-label="选择项目"
            value={state.selectedProjectId ?? ""}
            disabled={state.projects.length === 0}
            onChange={(event) => void select(event.currentTarget.value)}
          >
            {state.projects.length === 0 ? <option value="">暂无项目</option> : null}
            {state.projects.map((project) => (
              <option key={project.projectId} value={project.projectId}>
                {project.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={state.status === "loading"}
            onClick={() => void refresh()}
          >
            刷新
          </button>
        </div>
      </header>
      <nav className="lifeos-project-tabs" aria-label="项目视图">
        {(Object.keys(TAB_LABEL) as ProjectTab[]).map((item) => (
          <button
            key={item}
            type="button"
            aria-selected={tab === item}
            onClick={() => setTab(item)}
          >
            {TAB_LABEL[item]}
            {item === "review" && (state.review?.total ?? 0) > 0 ? (
              <span>{state.review?.total}</span>
            ) : null}
          </button>
        ))}
      </nav>
      {state.error === null ? null : (
        <p className="lifeos-project-error" role="alert">
          {state.error}
        </p>
      )}
      {state.status === "loading" && state.home === null ? (
        <Empty>正在读取项目事实…</Empty>
      ) : state.projects.length === 0 ? (
        <Empty>Chat 中还没有项目。创建或接手一个 Workspace 后会显示在这里。</Empty>
      ) : (
        <main className="lifeos-project-content">
          {tab === "home" ? <HomeView state={state} /> : null}
          {tab === "timeline" ? <TimelineView state={state} /> : null}
          {tab === "review" ? <ReviewView state={state} /> : null}
          {tab === "query" ? (
            <QueryView
              state={state}
              setQueryText={setQueryText}
              setQueryKind={setQueryKind}
              runQuery={runQuery}
            />
          ) : null}
        </main>
      )}
    </section>
  );
}

export function ProjectManagementView(props: ProjectManagementViewProps) {
  return <ProjectManagementContent {...props} />;
}
