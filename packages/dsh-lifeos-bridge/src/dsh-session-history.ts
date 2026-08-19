import { SessionId, type SessionEvent, type SessionHeader } from "@deepseek-ai/dsh-session";
import {
  assertSessionHeadersCompatible,
  type SessionQueryEngine,
  type SessionRecord,
} from "@deepseek-ai/dsh-session-query";

export interface DshSessionDescription {
  readonly header: SessionHeader;
  readonly title?: string;
  readonly live: boolean;
  readonly persisted: boolean;
  readonly archived: boolean;
  readonly eventCount: number;
  readonly lastEventSeq: number | null;
  readonly lastEventAt: number | null;
}

export interface DshSessionEventPage {
  readonly header: SessionHeader;
  readonly items: readonly SessionEvent[];
  readonly hasMore: boolean;
  readonly nextAfterSeq?: number;
}

/**
 * DSH会话历史Port。Bridge只依赖“授权后的描述/分页读取”，不依赖DSH的
 * JSONL目录结构，也不把DSH日志或归档集合改造成Chat产品事实。
 */
export interface DshSessionHistoryPort {
  assertAccessible(dshSessionId: string, signal?: AbortSignal): Promise<void>;
  describe(dshSessionId: string, signal?: AbortSignal): Promise<DshSessionDescription>;
  readEvents(
    dshSessionId: string,
    afterSeq: number | undefined,
    limit: number,
    signal?: AbortSignal,
  ): Promise<DshSessionEventPage>;
}

/** 已知的DSH历史目标不属于Chat受管Workspace；同源不等于跨Workspace授权。 */
export class DshSessionHistoryAccessError extends Error {
  constructor(
    readonly status: 403 | 404,
    readonly code: "lifeos_dsh_session_not_found" | "lifeos_dsh_session_forbidden",
    message: string,
  ) {
    super(message);
    this.name = "DshSessionHistoryAccessError";
  }
}

function requireWorkspaceHeader(header: SessionHeader, workspacePath: string): void {
  if (header.cwd !== workspacePath) {
    throw new DshSessionHistoryAccessError(
      403,
      "lifeos_dsh_session_forbidden",
      "DSH Session不属于Chat Workspace",
    );
  }
}

function requireRecord(records: readonly SessionRecord[], dshSessionId: string): SessionRecord {
  const record = records.find((candidate) => String(candidate.header.id) === dshSessionId);
  if (record === undefined) {
    throw new DshSessionHistoryAccessError(
      404,
      "lifeos_dsh_session_not_found",
      "DSH Session不存在",
    );
  }
  return record;
}

/**
 * rc.6 SessionQuery窄Adapter：复用其live-preferred回放校验和持久化读取，
 * 再在Bridge边界补Chat Workspace授权与cursor分页。分页只限制事件数量，
 * 从不截短事件内的正文、工具参数或结果。
 */
export class DshSessionQueryHistory implements DshSessionHistoryPort {
  constructor(
    private readonly query: SessionQueryEngine,
    private readonly workspacePath: string,
    private readonly archivedSessionIds: () => readonly string[],
  ) {}

  private async authorizedRecord(
    sessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<SessionRecord> {
    const records = await this.query.filterSessions([{ kind: "id", values: [sessionId] }], signal);
    signal?.throwIfAborted();
    const record = requireRecord(records, String(sessionId));
    // 先用轻量Header拒绝跨Workspace目标，避免授权失败后仍加载整份日志。
    requireWorkspaceHeader(record.header, this.workspacePath);
    return record;
  }

  /**
   * 只校验目标存在且属于Chat Workspace，不加载整份事件日志。
   * Chat正式Message翻页只需要这层授权，长DSH历史不会因此被重复回放。
   */
  async assertAccessible(dshSessionId: string, signal?: AbortSignal): Promise<void> {
    await this.authorizedRecord(SessionId(dshSessionId), signal);
  }

  async describe(dshSessionId: string, signal?: AbortSignal): Promise<DshSessionDescription> {
    const sessionId = SessionId(dshSessionId);
    const record = await this.authorizedRecord(sessionId, signal);
    const [log, title] = await Promise.all([
      this.query.readSession(sessionId),
      this.query.readTitle(sessionId, signal),
    ]);
    signal?.throwIfAborted();
    assertSessionHeadersCompatible(record.header, log.session);
    requireWorkspaceHeader(log.session, this.workspacePath);
    const last = log.events.at(-1);
    return {
      header: log.session,
      ...(title === undefined ? {} : { title: title.title }),
      live: record.live,
      persisted: record.persisted,
      archived: this.archivedSessionIds().includes(dshSessionId),
      eventCount: log.events.length,
      lastEventSeq: last?.seq ?? null,
      lastEventAt: last?.time ?? null,
    };
  }

  async readEvents(
    dshSessionId: string,
    afterSeq: number | undefined,
    limit: number,
    signal?: AbortSignal,
  ): Promise<DshSessionEventPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("DSH Session事件页limit必须是1到100的整数");
    }
    if (afterSeq !== undefined && (!Number.isSafeInteger(afterSeq) || afterSeq < 0)) {
      throw new RangeError("DSH Session事件页afterSeq必须是非负安全整数");
    }
    signal?.throwIfAborted();
    const sessionId = SessionId(dshSessionId);
    const record = await this.authorizedRecord(sessionId, signal);
    const log = await this.query.readSession(sessionId);
    signal?.throwIfAborted();
    assertSessionHeadersCompatible(record.header, log.session);
    requireWorkspaceHeader(log.session, this.workspacePath);
    const start =
      afterSeq === undefined ? 0 : log.events.findIndex((event) => event.seq > afterSeq);
    if (start < 0) {
      return { header: log.session, items: [], hasMore: false };
    }
    const window = log.events.slice(start, start + limit + 1);
    const items = window.slice(0, limit);
    const hasMore = window.length > limit;
    const last = items.at(-1);
    return {
      header: log.session,
      items,
      hasMore,
      ...(hasMore && last !== undefined ? { nextAfterSeq: last.seq } : {}),
    };
  }
}
