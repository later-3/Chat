import type { ZodType } from "zod";
import {
  createMemorySessionImportPayloadSchema,
  decideMemoryAgentWriteCandidatePayloadSchema,
  listMemoryAgentWriteCandidatesResponseSchema,
  listMemoryProvidersResponseSchema,
  listMemorySessionImportsResponseSchema,
  listMemorySessionSourcesResponseSchema,
  memoryAgentWriteCandidateResponseSchema,
  memoryAgentWriteDecisionResponseSchema,
  memorySessionImportResponseSchema,
  previewMemoryProviderComparisonResponseSchema,
  previewMemorySessionImportResponseSchema,
  type DecideMemoryAgentWriteCandidatePayload,
  type MemoryAgentWriteCandidate,
  type MemoryProviderComparisonPreview,
  type MemorySessionImportDto,
  type MemorySessionImportPreview,
  type MemorySessionSourceRef,
} from "@chat/contracts/public";

type LoadStatus = "idle" | "loading" | "ready" | "error";
type SourceKind = "chat" | "codex";
type MemorySessionSourceDescriptor = {
  readonly source: MemorySessionSourceRef;
  readonly title: string;
  readonly updatedAt: string;
};

export interface MemoryManagementState {
  readonly status: LoadStatus;
  readonly candidates: readonly MemoryAgentWriteCandidate[];
  readonly selectedCandidate: MemoryAgentWriteCandidate | null;
  readonly providers: readonly {
    readonly providerId: string;
    readonly displayName: string;
    readonly writeMaterialization: "synchronous" | "asynchronous" | "accepted_only" | null;
  }[];
  readonly imports: readonly MemorySessionImportDto[];
  readonly sourceKind: SourceKind;
  readonly sourcesStatus: LoadStatus;
  readonly sources: readonly MemorySessionSourceDescriptor[];
  readonly selectedSource: MemorySessionSourceRef | null;
  readonly importPreview: MemorySessionImportPreview | null;
  readonly comparison: MemoryProviderComparisonPreview | null;
  readonly saving: boolean;
  readonly error: string | null;
}

const INITIAL_STATE: MemoryManagementState = {
  status: "idle",
  candidates: [],
  selectedCandidate: null,
  providers: [],
  imports: [],
  sourceKind: "chat",
  sourcesStatus: "idle",
  sources: [],
  selectedSource: null,
  importPreview: null,
  comparison: null,
  saving: false,
  error: null,
};

interface PendingMemoryWrite {
  readonly path: string;
  /** 不含 commandId 的稳定意图；同一意图才能复用同一 commandId 重放。 */
  readonly requestJson: string;
  readonly commandId: string;
}

const PENDING_WRITE_STORAGE_KEY = "chat.memory-management.pending-write.v1";
const CANDIDATE_DECISION_PATH =
  /^\/lifeos\/memory\/write-candidates\/(mwc_[A-Za-z0-9]+)\/decisions$/u;
const SESSION_IMPORT_PATH = "/lifeos/memory/session-imports";

class MemoryManagementHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function browserCommandId(): string {
  return `cmd_${crypto.randomUUID().replaceAll("-", "")}`;
}

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function readPendingWrite(): PendingMemoryWrite | null {
  try {
    const raw = browserStorage()?.getItem(PENDING_WRITE_STORAGE_KEY);
    if (raw === undefined || raw === null) return null;
    const value = JSON.parse(raw) as Partial<PendingMemoryWrite>;
    return typeof value.path === "string" &&
      typeof value.requestJson === "string" &&
      typeof value.commandId === "string"
      ? { path: value.path, requestJson: value.requestJson, commandId: value.commandId }
      : null;
  } catch {
    return null;
  }
}

function persistPendingWrite(value: PendingMemoryWrite | null): void {
  try {
    const storage = browserStorage();
    if (storage === undefined) return;
    if (value === null) storage.removeItem(PENDING_WRITE_STORAGE_KEY);
    else storage.setItem(PENDING_WRITE_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // 浏览器存储仅用于结果未知后的原样重试；不可用时仍保留内存中的命令身份。
  }
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  return text === "" ? undefined : (JSON.parse(text) as unknown);
}

function problemMessage(value: unknown, status: number): string {
  const problem =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const code = typeof problem["code"] === "string" ? problem["code"] : "lifeos_memory_failed";
  const title = typeof problem["title"] === "string" ? problem["title"] : `HTTP ${String(status)}`;
  return `${code}: ${title}`;
}

function sourceKey(source: MemorySessionSourceRef): string {
  return source.kind === "chat"
    ? `chat:${source.productSessionId}`
    : `codex:${source.codexSessionId}`;
}

/**
 * 根级 Memory 管理面只调用 Bridge 的同源窄路由。它不轮询 Run，也不把 Provider
 * 响应、候选正文或导入预览写入浏览器持久状态；唯一持久化项是可安全重放的命令信封。
 */
export class MemoryManagementController {
  private snapshot: MemoryManagementState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly fetchImpl: typeof fetch;
  private abort: AbortController | undefined;
  private disposed = false;
  private pendingWrite: PendingMemoryWrite | null = readPendingWrite();

  constructor(fetchImpl?: typeof fetch) {
    const request = fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.fetchImpl = (...args) => request(...args);
  }

  getSnapshot = (): MemoryManagementState => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    if (this.listeners.size === 1 && this.snapshot.status === "idle") void this.refresh();
    return () => this.listeners.delete(listener);
  };

  async refresh(): Promise<void> {
    if (this.disposed) return;
    this.abort?.abort(new DOMException("memory management refresh superseded", "AbortError"));
    const abort = new AbortController();
    this.abort = abort;
    this.publish({ ...this.snapshot, status: "loading", error: null });
    try {
      const replayError = await this.replayPendingWrite();
      const [candidates, providers, imports] = await Promise.all([
        this.request(
          "/lifeos/memory/write-candidates?status=pending_review&limit=100",
          listMemoryAgentWriteCandidatesResponseSchema,
          undefined,
          abort.signal,
        ),
        this.request(
          "/lifeos/memory/providers",
          listMemoryProvidersResponseSchema,
          undefined,
          abort.signal,
        ),
        this.request(
          "/lifeos/memory/session-imports?limit=100",
          listMemorySessionImportsResponseSchema,
          undefined,
          abort.signal,
        ),
      ]);
      const selectedCandidate =
        this.snapshot.selectedCandidate === null
          ? null
          : this.snapshot.selectedCandidate.status !== "pending_review"
            ? this.snapshot.selectedCandidate
            : (candidates.candidates.find(
                (candidate) =>
                  candidate.memoryAgentWriteCandidateId ===
                  this.snapshot.selectedCandidate?.memoryAgentWriteCandidateId,
              ) ?? this.snapshot.selectedCandidate);
      this.publish({
        ...this.snapshot,
        status: "ready",
        candidates: candidates.candidates,
        selectedCandidate,
        providers: providers.providers.map((provider) => ({
          providerId: provider.providerId,
          displayName: provider.displayName,
          writeMaterialization: provider.capabilities.write?.materialization ?? null,
        })),
        imports: imports.memorySessionImports,
        error: replayError,
      });
    } catch (error) {
      if (abort.signal.aborted || this.disposed) return;
      this.publish({
        ...this.snapshot,
        status: "error",
        error: error instanceof Error ? error.message : "Memory 管理面读取失败",
      });
    }
  }

  async selectCandidate(candidateId: string): Promise<void> {
    this.publish({ ...this.snapshot, saving: true, error: null });
    try {
      const response = await this.request(
        `/lifeos/memory/write-candidates/${encodeURIComponent(candidateId)}`,
        memoryAgentWriteCandidateResponseSchema,
      );
      this.publish({
        ...this.snapshot,
        selectedCandidate: response.candidate,
        saving: false,
        error: null,
      });
    } catch (error) {
      this.fail(error);
    }
  }

  closeCandidate(): void {
    this.publish({ ...this.snapshot, selectedCandidate: null, error: null });
  }

  async decideCandidate(
    kind: DecideMemoryAgentWriteCandidatePayload["kind"],
    reason?: string,
  ): Promise<void> {
    const candidate = this.snapshot.selectedCandidate;
    if (candidate === null || candidate.status !== "pending_review") return;
    const payload: DecideMemoryAgentWriteCandidatePayload =
      kind === "approve"
        ? {
            kind,
            expectedCandidateRevision: candidate.revision,
            expectedCandidateSha256: candidate.sha256,
          }
        : {
            kind,
            expectedCandidateRevision: candidate.revision,
            expectedCandidateSha256: candidate.sha256,
            ...(reason === undefined || reason.trim() === "" ? {} : { reason: reason.trim() }),
          };
    try {
      const response = await this.write(
        `/lifeos/memory/write-candidates/${encodeURIComponent(candidate.memoryAgentWriteCandidateId)}/decisions`,
        payload,
        memoryAgentWriteDecisionResponseSchema,
      );
      this.publish({ ...this.snapshot, selectedCandidate: response.candidate });
      await this.refresh();
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async loadSources(kind: SourceKind): Promise<void> {
    if (this.disposed) return;
    this.publish({
      ...this.snapshot,
      sourceKind: kind,
      sourcesStatus: "loading",
      sources: [],
      selectedSource: null,
      importPreview: null,
      comparison: null,
      error: null,
    });
    try {
      const response = await this.request(
        `/lifeos/memory/session-sources?kind=${kind}&limit=100`,
        listMemorySessionSourcesResponseSchema,
      );
      this.publish({
        ...this.snapshot,
        sourcesStatus: "ready",
        sources: response.sources,
        selectedSource: response.sources[0]?.source ?? null,
        error: null,
      });
    } catch (error) {
      this.publish({
        ...this.snapshot,
        sourcesStatus: "error",
        error: error instanceof Error ? error.message : "Memory 来源读取失败",
      });
    }
  }

  selectSource(source: MemorySessionSourceRef): void {
    const available = this.snapshot.sources.some(
      (item) => sourceKey(item.source) === sourceKey(source),
    );
    if (!available) return;
    this.publish({
      ...this.snapshot,
      selectedSource: source,
      importPreview: null,
      comparison: null,
    });
  }

  async previewImport(providerId: string): Promise<void> {
    const source = this.snapshot.selectedSource;
    if (source === null) return this.fail(new Error("请先选择待导入会话来源"));
    this.publish({ ...this.snapshot, saving: true, error: null });
    try {
      const response = await this.request(
        "/lifeos/memory/session-import-previews",
        previewMemorySessionImportResponseSchema,
        { method: "POST", body: JSON.stringify({ source, providerId }) },
      );
      this.publish({
        ...this.snapshot,
        importPreview: response.preview,
        saving: false,
        error: null,
      });
    } catch (error) {
      this.fail(error);
    }
  }

  async createImport(): Promise<void> {
    const preview = this.snapshot.importPreview;
    if (preview === null) return this.fail(new Error("请先生成当前来源的导入预览"));
    try {
      const response = await this.write(
        "/lifeos/memory/session-imports",
        {
          source: preview.source,
          providerId: preview.providerId,
          sourceSnapshotSha256: preview.sourceSnapshotSha256,
          previewSha256: preview.previewSha256,
        },
        memorySessionImportResponseSchema,
      );
      this.publish({ ...this.snapshot, importPreview: null });
      await this.refresh();
      this.publish({
        ...this.snapshot,
        imports: [
          response.memorySessionImport,
          ...this.snapshot.imports.filter(
            (item) =>
              item.memorySessionImportId !== response.memorySessionImport.memorySessionImportId,
          ),
        ],
      });
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async compare(input: {
    readonly query: string;
    readonly providerIds: readonly string[];
    readonly maxResults?: number;
    readonly maxContextCharacters?: number;
  }): Promise<void> {
    const source = this.snapshot.selectedSource;
    if (source === null) return this.fail(new Error("请先选择用于比较的会话来源"));
    if (input.providerIds.length < 2) return this.fail(new Error("至少选择两个 Memory Provider"));
    this.publish({ ...this.snapshot, saving: true, error: null });
    try {
      const response = await this.request(
        "/lifeos/memory/provider-comparison-previews",
        previewMemoryProviderComparisonResponseSchema,
        {
          method: "POST",
          body: JSON.stringify({
            source,
            query: input.query,
            providerIds: input.providerIds,
            ...(input.maxResults === undefined ? {} : { maxResults: input.maxResults }),
            ...(input.maxContextCharacters === undefined
              ? {}
              : { maxContextCharacters: input.maxContextCharacters }),
          }),
        },
      );
      this.publish({
        ...this.snapshot,
        comparison: response.comparison,
        saving: false,
        error: null,
      });
    } catch (error) {
      this.fail(error);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.abort?.abort(new DOMException("memory management disposed", "AbortError"));
    this.listeners.clear();
  }

  private async write<T>(path: string, payload: unknown, schema: ZodType<T>): Promise<T> {
    this.publish({ ...this.snapshot, saving: true, error: null });
    const requestJson = JSON.stringify({ payload });
    const pending = this.pendingWrite;
    if (pending !== null && (pending.path !== path || pending.requestJson !== requestJson)) {
      throw new Error("上一 Memory 写入结果未知；只能原样重试，或刷新确认结果");
    }
    const active = pending ?? { path, requestJson, commandId: browserCommandId() };
    this.pendingWrite = active;
    persistPendingWrite(active);
    try {
      const value = await this.request(path, schema, {
        method: "POST",
        body: JSON.stringify({ commandId: active.commandId, payload }),
      });
      this.clearPendingWrite(active.commandId);
      this.publish({ ...this.snapshot, saving: false, error: null });
      return value;
    } catch (error) {
      if (
        error instanceof MemoryManagementHttpError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408 &&
        error.status !== 429
      ) {
        this.clearPendingWrite(active.commandId);
      }
      throw error;
    }
  }

  /**
   * 刷新/重启后只对白名单命令做原样重放。localStorage不是可信边界，因此路径和
   * payload都必须再次经过公开合同；任何未知内容都会被清除，绝不变成通用同源POST。
   */
  private async replayPendingWrite(): Promise<string | null> {
    const pending = this.pendingWrite;
    if (pending === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(pending.requestJson) as unknown;
    } catch {
      this.clearPendingWrite(pending.commandId);
      return "已清除损坏的 Memory 待确认命令";
    }
    const envelope =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { readonly payload?: unknown })
        : {};
    const decisionMatch = CANDIDATE_DECISION_PATH.exec(pending.path);
    const decisionPayload =
      decisionMatch === null
        ? undefined
        : decideMemoryAgentWriteCandidatePayloadSchema.safeParse(envelope.payload);
    const importPayload =
      pending.path === SESSION_IMPORT_PATH
        ? createMemorySessionImportPayloadSchema.safeParse(envelope.payload)
        : undefined;
    if (
      (decisionPayload === undefined || !decisionPayload.success) &&
      (importPayload === undefined || !importPayload.success)
    ) {
      this.clearPendingWrite(pending.commandId);
      return "已清除不符合合同的 Memory 待确认命令";
    }
    try {
      if (decisionPayload?.success === true) {
        const response = await this.request(pending.path, memoryAgentWriteDecisionResponseSchema, {
          method: "POST",
          body: JSON.stringify({ commandId: pending.commandId, payload: decisionPayload.data }),
        });
        this.publish({ ...this.snapshot, selectedCandidate: response.candidate });
      } else if (importPayload?.success === true) {
        await this.request(pending.path, memorySessionImportResponseSchema, {
          method: "POST",
          body: JSON.stringify({ commandId: pending.commandId, payload: importPayload.data }),
        });
      }
      this.clearPendingWrite(pending.commandId);
      return null;
    } catch (error) {
      if (
        error instanceof MemoryManagementHttpError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408 &&
        error.status !== 429
      ) {
        this.clearPendingWrite(pending.commandId);
      }
      return error instanceof Error
        ? `Memory 待确认命令重放失败：${error.message}`
        : "Memory 待确认命令重放失败";
    }
  }

  private async request<T>(
    path: string,
    schema: ZodType<T>,
    init?: RequestInit,
    signal?: AbortSignal,
  ): Promise<T> {
    const headers = new Headers(init?.headers);
    headers.set("accept", "application/json");
    if (init?.body !== undefined) headers.set("content-type", "application/json");
    const response = await this.fetchImpl(path, {
      ...init,
      headers,
      credentials: "same-origin",
      ...(signal === undefined ? {} : { signal }),
    });
    const value = await responseJson(response);
    if (!response.ok) {
      throw new MemoryManagementHttpError(response.status, problemMessage(value, response.status));
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new Error("lifeos_memory_contract_mismatch: 响应合同不匹配");
    return parsed.data;
  }

  private clearPendingWrite(commandId: string): void {
    if (this.pendingWrite?.commandId !== commandId) return;
    this.pendingWrite = null;
    persistPendingWrite(null);
  }

  private fail(error: unknown): void {
    this.publish({
      ...this.snapshot,
      saving: false,
      error: error instanceof Error ? error.message : "Memory 操作失败",
    });
  }

  private publish(next: MemoryManagementState): void {
    if (this.disposed) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
