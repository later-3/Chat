import type { ZodType } from "zod";
import {
  sessionRecordsChatPageSchema,
  sessionRecordsDshPageSchema,
  sessionRecordsOverviewSchema,
  type SessionRecordsMessageItem,
  type SessionRecordsDshPage,
  type SessionRecordsOverview,
} from "../contracts.ts";

type LoadStatus = "idle" | "loading" | "ready" | "error";

export interface SessionRecordsSourceState<T> {
  readonly status: LoadStatus;
  readonly items: readonly T[];
  readonly hasMore: boolean;
  readonly error: string | null;
}

export interface SessionRecordsState {
  readonly overviewStatus: LoadStatus;
  readonly overview: SessionRecordsOverview | null;
  readonly overviewError: string | null;
  readonly chat: SessionRecordsSourceState<SessionRecordsMessageItem>;
  readonly dsh: SessionRecordsSourceState<SessionRecordsDshPage["items"][number]>;
}

const EMPTY_SOURCE = {
  status: "idle",
  items: [],
  hasMore: true,
  error: null,
} as const;

const INITIAL_STATE: SessionRecordsState = {
  overviewStatus: "idle",
  overview: null,
  overviewError: null,
  chat: EMPTY_SOURCE,
  dsh: EMPTY_SOURCE,
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
  const title = typeof problem?.title === "string" ? problem.title : `HTTP ${String(status)}`;
  const code = typeof problem?.code === "string" ? problem.code : "lifeos_request_failed";
  return `${code}: ${title}`;
}

/**
 * “会话记录”页签的按需读控制器。每个Source独立失败，刷新会取消旧代请求，
 * cursor只消费服务端返回值；从不解析、拼接或猜测Chat cursor。
 */
export class SessionRecordsController {
  private snapshot: SessionRecordsState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly fetchImpl: typeof fetch;
  private abort: AbortController | undefined;
  private refreshPromise: Promise<void> | undefined;
  private chatPromise: Promise<void> | undefined;
  private dshPromise: Promise<void> | undefined;
  private chatCursor: string | undefined;
  private dshAfterSeq: number | undefined;
  private disposed = false;

  constructor(
    readonly sessionId: string,
    fetchImpl?: typeof fetch,
  ) {
    const request = fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.fetchImpl = (...args) => request(...args);
  }

  getSnapshot = (): SessionRecordsState => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    if (this.listeners.size === 1 && this.snapshot.overviewStatus === "idle") {
      void this.refresh();
    }
    return () => this.listeners.delete(listener);
  };

  async refresh(): Promise<void> {
    if (this.disposed) return;
    if (this.refreshPromise !== undefined) return await this.refreshPromise;
    this.abort?.abort(new DOMException("session records superseded", "AbortError"));
    const abort = new AbortController();
    this.abort = abort;
    this.chatCursor = undefined;
    this.dshAfterSeq = undefined;
    this.publish({
      overviewStatus: "loading",
      overview: this.snapshot.overview,
      overviewError: null,
      chat: { status: "loading", items: [], hasMore: true, error: null },
      dsh: { status: "loading", items: [], hasMore: true, error: null },
    });
    const work = Promise.allSettled([
      this.loadOverview(abort.signal),
      this.loadChatPage(false, abort.signal),
      this.loadDshPage(false, abort.signal),
    ]).then(() => undefined);
    const tracked = work.finally(() => {
      if (this.refreshPromise === tracked) this.refreshPromise = undefined;
    });
    this.refreshPromise = tracked;
    return await tracked;
  }

  async loadMoreChat(): Promise<void> {
    if (this.disposed || !this.snapshot.chat.hasMore) return;
    if (this.chatPromise !== undefined) return await this.chatPromise;
    const signal = this.abort?.signal;
    this.publish({
      ...this.snapshot,
      chat: { ...this.snapshot.chat, status: "loading", error: null },
    });
    const work = this.loadChatPage(true, signal);
    const tracked = work.finally(() => {
      if (this.chatPromise === tracked) this.chatPromise = undefined;
    });
    this.chatPromise = tracked;
    return await tracked;
  }

  async loadMoreDsh(): Promise<void> {
    if (this.disposed || !this.snapshot.dsh.hasMore) return;
    if (this.dshPromise !== undefined) return await this.dshPromise;
    const signal = this.abort?.signal;
    this.publish({
      ...this.snapshot,
      dsh: { ...this.snapshot.dsh, status: "loading", error: null },
    });
    const work = this.loadDshPage(true, signal);
    const tracked = work.finally(() => {
      if (this.dshPromise === tracked) this.dshPromise = undefined;
    });
    this.dshPromise = tracked;
    return await tracked;
  }

  dispose(): void {
    this.disposed = true;
    this.abort?.abort(new DOMException("session records disposed", "AbortError"));
    this.listeners.clear();
  }

  private async loadOverview(signal: AbortSignal): Promise<void> {
    try {
      const overview = await this.request(
        `/lifeos/sessions/${encodeURIComponent(this.sessionId)}/records`,
        sessionRecordsOverviewSchema,
        signal,
      );
      this.publish({
        ...this.snapshot,
        overviewStatus: "ready",
        overview,
        overviewError: null,
      });
    } catch (error) {
      if (signal.aborted || this.disposed) return;
      this.publish({
        ...this.snapshot,
        overviewStatus: "error",
        overviewError: error instanceof Error ? error.message : "会话概况读取失败",
      });
    }
  }

  private async loadChatPage(append: boolean, signal?: AbortSignal): Promise<void> {
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (append && this.chatCursor !== undefined) params.set("cursor", this.chatCursor);
      const page = await this.request(
        `/lifeos/sessions/${encodeURIComponent(this.sessionId)}/records/chat?${params.toString()}`,
        sessionRecordsChatPageSchema,
        signal,
      );
      const nextCursor = page.messages.nextCursor;
      if (append && nextCursor !== undefined && nextCursor === this.chatCursor) {
        throw new Error("Chat消息分页cursor没有推进");
      }
      this.chatCursor = nextCursor;
      const prior = append ? this.snapshot.chat.items : [];
      const byId = new Map(prior.map((item) => [item.message.messageId, item]));
      for (const item of page.messages.items) byId.set(item.message.messageId, item);
      this.publish({
        ...this.snapshot,
        chat: {
          status: "ready",
          items: [...byId.values()].sort(
            (left, right) => left.message.sessionSequence - right.message.sessionSequence,
          ),
          hasMore: nextCursor !== undefined,
          error: null,
        },
      });
    } catch (error) {
      if (signal?.aborted === true || this.disposed) return;
      this.publish({
        ...this.snapshot,
        chat: {
          ...this.snapshot.chat,
          status: "error",
          error: error instanceof Error ? error.message : "Chat正式消息读取失败",
        },
      });
    }
  }

  private async loadDshPage(append: boolean, signal?: AbortSignal): Promise<void> {
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (append && this.dshAfterSeq !== undefined) {
        params.set("afterSeq", String(this.dshAfterSeq));
      }
      const page = await this.request(
        `/lifeos/sessions/${encodeURIComponent(this.sessionId)}/records/dsh?${params.toString()}`,
        sessionRecordsDshPageSchema,
        signal,
      );
      const nextAfterSeq = page.nextAfterSeq;
      if (append && nextAfterSeq !== undefined && nextAfterSeq === this.dshAfterSeq) {
        throw new Error("DSH事件分页位置没有推进");
      }
      this.dshAfterSeq = nextAfterSeq;
      const prior = append ? this.snapshot.dsh.items : [];
      const bySeq = new Map(prior.map((event) => [event.seq, event]));
      for (const event of page.items) bySeq.set(event.seq, event);
      this.publish({
        ...this.snapshot,
        dsh: {
          status: "ready",
          items: [...bySeq.values()].sort((left, right) => left.seq - right.seq),
          hasMore: page.hasMore,
          error: null,
        },
      });
    } catch (error) {
      if (signal?.aborted === true || this.disposed) return;
      this.publish({
        ...this.snapshot,
        dsh: {
          ...this.snapshot.dsh,
          status: "error",
          error: error instanceof Error ? error.message : "DSH原始日志读取失败",
        },
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

  private publish(next: SessionRecordsState): void {
    if (this.disposed) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
