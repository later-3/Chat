import type { ZodType } from "zod";
import {
  projectHomeDtoSchema,
  projectObjectQueryResultDtoSchema,
  projectSummaryV3DtoSchema,
  projectTimelineItemDtoSchema,
  projectWorkspaceV3DtoSchema,
  type ProjectHomeDto,
  type ProjectManagedObjectKind,
  type ProjectObjectQueryResultDto,
  type ProjectSummaryDto,
  type ProjectTimelineItemDto,
  type ProjectWorkspaceDto,
} from "@chat/contracts/public";
import { z } from "zod";

type LoadStatus = "idle" | "loading" | "ready" | "error";

export interface ProjectManagementState {
  readonly open: boolean;
  readonly status: LoadStatus;
  readonly projects: readonly ProjectSummaryDto[];
  readonly selectedProjectId: string | null;
  readonly home: ProjectHomeDto | null;
  readonly workspace: ProjectWorkspaceDto | null;
  readonly timeline: readonly ProjectTimelineItemDto[];
  readonly review: ProjectObjectQueryResultDto | null;
  readonly query: ProjectObjectQueryResultDto | null;
  readonly queryText: string;
  readonly queryKind: ProjectManagedObjectKind | null;
  readonly error: string | null;
}

const projectsResponseSchema = z.object({ projects: z.array(projectSummaryV3DtoSchema) }).strict();
const projectOverviewResponseSchema = z
  .object({ projectHome: projectHomeDtoSchema, project: projectWorkspaceV3DtoSchema })
  .strict();
const projectTimelineResponseSchema = z
  .object({ items: z.array(projectTimelineItemDtoSchema) })
  .strict();
const projectObjectsResponseSchema = z
  .object({ result: projectObjectQueryResultDtoSchema })
  .strict();

const INITIAL_STATE: ProjectManagementState = {
  open: false,
  status: "idle",
  projects: [],
  selectedProjectId: null,
  home: null,
  workspace: null,
  timeline: [],
  review: null,
  query: null,
  queryText: "",
  queryKind: null,
  error: null,
};

interface ProblemLike {
  title?: unknown;
  code?: unknown;
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  return text === "" ? undefined : (JSON.parse(text) as unknown);
}

function problemMessage(value: unknown, status: number): string {
  const problem = typeof value === "object" && value !== null ? (value as ProblemLike) : undefined;
  const title = typeof problem?.title === "string" ? problem.title : `HTTP ${String(status)}`;
  const code = typeof problem?.code === "string" ? problem.code : "lifeos_request_failed";
  return `${code}: ${title}`;
}

/**
 * DSH Project页签的按需Query控制器。它不持久化Project对象，只保留当前页面投影；
 * 每次刷新都回到Bridge → Chat Application → Product Store读取权威事实。
 */
export class ProjectManagementController {
  private snapshot: ProjectManagementState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly fetchImpl: typeof fetch;
  private abort: AbortController | undefined;
  private loadPromise: Promise<void> | undefined;
  private disposed = false;

  constructor(fetchImpl?: typeof fetch) {
    const request = fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.fetchImpl = (...args) => request(...args);
  }

  getSnapshot = (): ProjectManagementState => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    if (this.listeners.size === 1 && this.snapshot.status === "idle") void this.refresh();
    return () => this.listeners.delete(listener);
  };

  open(): void {
    this.publish({ ...this.snapshot, open: true });
  }

  close(): void {
    this.publish({ ...this.snapshot, open: false });
  }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    if (this.loadPromise !== undefined) return await this.loadPromise;
    this.abort?.abort(new DOMException("project refresh superseded", "AbortError"));
    const abort = new AbortController();
    this.abort = abort;
    this.publish({ ...this.snapshot, status: "loading", error: null });
    const work = this.loadProjectsAndSelection(abort.signal);
    const tracked = work.finally(() => {
      if (this.loadPromise === tracked) this.loadPromise = undefined;
    });
    this.loadPromise = tracked;
    return await tracked;
  }

  async select(projectId: string): Promise<void> {
    if (this.disposed || projectId === this.snapshot.selectedProjectId) return;
    this.abort?.abort(new DOMException("project selection superseded", "AbortError"));
    const abort = new AbortController();
    this.abort = abort;
    this.publish({
      ...this.snapshot,
      status: "loading",
      selectedProjectId: projectId,
      home: null,
      workspace: null,
      timeline: [],
      review: null,
      query: null,
      queryText: "",
      queryKind: null,
      error: null,
    });
    await this.loadSelected(projectId, abort.signal);
  }

  setQueryText(value: string): void {
    this.publish({ ...this.snapshot, queryText: value });
  }

  setQueryKind(value: ProjectManagedObjectKind | null): void {
    this.publish({ ...this.snapshot, queryKind: value });
  }

  async runQuery(): Promise<void> {
    const projectId = this.snapshot.selectedProjectId;
    if (projectId === null || this.disposed) return;
    try {
      const params = new URLSearchParams({ view: "all", limit: "200" });
      const text = this.snapshot.queryText.trim();
      if (text !== "") params.set("q", text);
      if (this.snapshot.queryKind !== null) params.set("kind", this.snapshot.queryKind);
      const response = await this.request(
        `/lifeos/projects/${encodeURIComponent(projectId)}/objects?${params.toString()}`,
        projectObjectsResponseSchema,
        this.abort?.signal,
      );
      this.publish({ ...this.snapshot, query: response.result, error: null });
    } catch (error) {
      if (this.abort?.signal.aborted === true || this.disposed) return;
      this.publish({
        ...this.snapshot,
        error: error instanceof Error ? error.message : "Project Query读取失败",
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.abort?.abort(new DOMException("project management disposed", "AbortError"));
    this.listeners.clear();
  }

  private async loadProjectsAndSelection(signal: AbortSignal): Promise<void> {
    try {
      const response = await this.request("/lifeos/projects", projectsResponseSchema, signal);
      const selected =
        response.projects.find((item) => item.projectId === this.snapshot.selectedProjectId) ??
        response.projects[0];
      this.publish({
        ...this.snapshot,
        projects: response.projects,
        selectedProjectId: selected?.projectId ?? null,
        status: selected === undefined ? "ready" : "loading",
        home: selected === undefined ? null : this.snapshot.home,
        workspace: selected === undefined ? null : this.snapshot.workspace,
        timeline: selected === undefined ? [] : this.snapshot.timeline,
        review: selected === undefined ? null : this.snapshot.review,
        query: selected === undefined ? null : this.snapshot.query,
        error: null,
      });
      if (selected !== undefined) await this.loadSelected(selected.projectId, signal);
    } catch (error) {
      if (signal.aborted || this.disposed) return;
      this.publish({
        ...this.snapshot,
        status: "error",
        error: error instanceof Error ? error.message : "Project列表读取失败",
      });
    }
  }

  private async loadSelected(projectId: string, signal: AbortSignal): Promise<void> {
    try {
      const reviewParams = new URLSearchParams({ view: "review", limit: "200" });
      const queryParams = new URLSearchParams({ view: "all", limit: "200" });
      const [overview, timeline, review, query] = await Promise.all([
        this.request(
          `/lifeos/projects/${encodeURIComponent(projectId)}`,
          projectOverviewResponseSchema,
          signal,
        ),
        this.request(
          `/lifeos/projects/${encodeURIComponent(projectId)}/timeline`,
          projectTimelineResponseSchema,
          signal,
        ),
        this.request(
          `/lifeos/projects/${encodeURIComponent(projectId)}/objects?${reviewParams.toString()}`,
          projectObjectsResponseSchema,
          signal,
        ),
        this.request(
          `/lifeos/projects/${encodeURIComponent(projectId)}/objects?${queryParams.toString()}`,
          projectObjectsResponseSchema,
          signal,
        ),
      ]);
      this.publish({
        ...this.snapshot,
        status: "ready",
        selectedProjectId: projectId,
        home: overview.projectHome,
        workspace: overview.project,
        timeline: timeline.items,
        review: review.result,
        query: query.result,
        error: null,
      });
    } catch (error) {
      if (signal.aborted || this.disposed) return;
      this.publish({
        ...this.snapshot,
        status: "error",
        error: error instanceof Error ? error.message : "Project详情读取失败",
      });
    }
  }

  private async request<T>(path: string, schema: ZodType<T>, signal?: AbortSignal): Promise<T> {
    const response = await this.fetchImpl(path, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
    const json = await responseJson(response);
    if (!response.ok) throw new Error(problemMessage(json, response.status));
    return schema.parse(json);
  }

  private publish(next: ProjectManagementState): void {
    if (this.disposed) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
