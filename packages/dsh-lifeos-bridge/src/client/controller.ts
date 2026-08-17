import {
  lifeosProjectionSchema,
  workflowListResponseSchema,
  type DecisionRequest,
  type LifeosProjection,
  type LifeosWorkflowOption,
  type WorkflowSelection,
} from "../contracts.ts";

const POLL_INTERVAL_MS = 1_000;

export interface LifeosClientState {
  readonly status: "loading" | "ready" | "error";
  readonly projection: LifeosProjection | null;
  readonly submitting: boolean;
  readonly error: string | null;
  /** 选择表面按需加载的Workflow列表；null表示尚未加载。 */
  readonly workflows: readonly LifeosWorkflowOption[] | null;
  readonly workflowError: string | null;
  readonly selectingWorkflow: boolean;
}

const INITIAL_STATE: LifeosClientState = {
  status: "loading",
  projection: null,
  submitting: false,
  error: null,
  workflows: null,
  workflowError: null,
  selectingWorkflow: false,
};

interface ProblemLike {
  title?: unknown;
  code?: unknown;
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return undefined;
  return JSON.parse(text) as unknown;
}

function problemMessage(value: unknown, status: number): string {
  const problem = typeof value === "object" && value !== null ? (value as ProblemLike) : undefined;
  const title = typeof problem?.title === "string" ? problem.title : `HTTP ${status}`;
  const code = typeof problem?.code === "string" ? problem.code : "lifeos_request_failed";
  return `${code}: ${title}`;
}

/** Per-DSH-session polling controller exposed through a native slot hook. */
export class LifeosProjectionController {
  private snapshot: LifeosClientState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private interval: ReturnType<typeof setInterval> | undefined;
  private refreshing: Promise<void> | undefined;
  private disposed = false;
  private readonly fetchImpl: typeof fetch;

  constructor(
    readonly sessionId: string,
    fetchImpl?: typeof fetch,
  ) {
    const request = fetchImpl ?? globalThis.fetch.bind(globalThis);
    // Keep the callable in a lexical closure: invoking a native Window.fetch
    // as `this.fetchImpl(...)` otherwise supplies the controller as receiver.
    this.fetchImpl = (...args) => request(...args);
  }

  getSnapshot = (): LifeosClientState => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };

  private start(): void {
    if (this.interval !== undefined || this.disposed) return;
    void this.refresh();
    this.interval = setInterval(() => {
      void this.refresh();
    }, POLL_INTERVAL_MS);
  }

  private stop(): void {
    if (this.interval !== undefined) clearInterval(this.interval);
    this.interval = undefined;
  }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    if (this.refreshing !== undefined) return await this.refreshing;
    this.refreshing = this.performRefresh().finally(() => {
      this.refreshing = undefined;
    });
    return await this.refreshing;
  }

  async decide(request: DecisionRequest): Promise<boolean> {
    if (this.disposed || this.snapshot.submitting) return false;
    this.publish({ ...this.snapshot, submitting: true, error: null });
    try {
      const response = await this.fetchImpl(
        `/lifeos/sessions/${encodeURIComponent(this.sessionId)}/decisions`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify(request),
        },
      );
      const json = await responseJson(response);
      if (!response.ok) throw new Error(problemMessage(json, response.status));
      const projection = lifeosProjectionSchema.parse(json);
      this.publish({ ...this.snapshot, status: "ready", projection, submitting: false, error: null });
      return true;
    } catch (error) {
      this.publish({
        ...this.snapshot,
        status: this.snapshot.projection === null ? "error" : this.snapshot.status,
        submitting: false,
        error: error instanceof Error ? error.message : "LifeOS 决定提交失败",
      });
      return false;
    }
  }

  /** 打开选择表面时按需拉取一次Workflow列表；失败只影响选择表面，不打扰运行投影。 */
  async loadWorkflows(): Promise<readonly LifeosWorkflowOption[] | null> {
    if (this.disposed) return null;
    try {
      const response = await this.fetchImpl("/lifeos/workflows", {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      const json = await responseJson(response);
      if (!response.ok) throw new Error(problemMessage(json, response.status));
      const parsed = workflowListResponseSchema.parse(json);
      this.publish({ ...this.snapshot, workflows: parsed.items, workflowError: null });
      return parsed.items;
    } catch (error) {
      this.publish({
        ...this.snapshot,
        workflowError: error instanceof Error ? error.message : "Workflow 列表读取失败",
      });
      return null;
    }
  }

  /** 提交选择草稿；成功后以返回的投影刷新本地状态。 */
  async selectWorkflow(selection: WorkflowSelection | null): Promise<boolean> {
    if (this.disposed || this.snapshot.selectingWorkflow) return false;
    this.publish({ ...this.snapshot, selectingWorkflow: true, workflowError: null });
    try {
      const response = await this.fetchImpl(
        `/lifeos/sessions/${encodeURIComponent(this.sessionId)}/workflow-selection`,
        {
          method: "PUT",
          credentials: "same-origin",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ workflowSelection: selection }),
        },
      );
      const json = await responseJson(response);
      if (!response.ok) throw new Error(problemMessage(json, response.status));
      const projection = lifeosProjectionSchema.parse(json);
      this.publish({
        ...this.snapshot,
        status: "ready",
        projection,
        selectingWorkflow: false,
        workflowError: null,
      });
      return true;
    } catch (error) {
      this.publish({
        ...this.snapshot,
        workflows: null,
        selectingWorkflow: false,
        workflowError: error instanceof Error ? error.message : "Workflow 选择提交失败",
      });
      return false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.listeners.clear();
  }

  private async performRefresh(): Promise<void> {
    try {
      const response = await this.fetchImpl(
        `/lifeos/sessions/${encodeURIComponent(this.sessionId)}`,
        {
          credentials: "same-origin",
          headers: { accept: "application/json" },
        },
      );
      const json = await responseJson(response);
      if (!response.ok) throw new Error(problemMessage(json, response.status));
      const projection = lifeosProjectionSchema.parse(json);
      this.publish({
        ...this.snapshot,
        status: "ready",
        projection,
        submitting: this.snapshot.submitting,
        error: null,
      });
    } catch (error) {
      this.publish({
        ...this.snapshot,
        status: this.snapshot.projection === null ? "error" : this.snapshot.status,
        error: error instanceof Error ? error.message : "LifeOS 状态读取失败",
      });
    }
  }

  private publish(next: LifeosClientState): void {
    if (this.disposed) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
