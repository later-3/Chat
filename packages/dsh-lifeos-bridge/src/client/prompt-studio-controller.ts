import { z, type ZodType } from "zod";
import {
  promptFragmentCommandResultDtoSchema,
  promptFragmentDetailDtoSchema,
  promptFragmentPageDtoSchema,
  promptFragmentRevisionDetailDtoSchema,
  promptRegionsDtoSchema,
  type ChangePromptFragmentArchiveStatusPayload,
  type CopyPromptFragmentPayload,
  type CreatePromptFragmentPayload,
  type PromptFragmentDetailDto,
  type PromptFragmentRevisionDetailDto,
  type PromptFragmentSummaryDto,
  type PromptRegionDefinitionDto,
  type RevisePromptFragmentPayload,
} from "@chat/contracts/public";

export interface PromptStudioState {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly regions: readonly PromptRegionDefinitionDto[];
  readonly fragments: readonly PromptFragmentSummaryDto[];
  readonly selected: PromptFragmentDetailDto | null;
  readonly viewedRevision: PromptFragmentRevisionDetailDto | null;
  readonly sourceOpeners: readonly PromptSourceOpener[];
  readonly saving: boolean;
  readonly error: string | null;
}

export interface PromptSourceOpener {
  readonly id: "vscode" | "trae-cn" | "cursor" | "sublime-text" | "textedit" | "system-default";
  readonly label: string;
}

const promptSourceOpenersResponseSchema = z
  .object({
    schemaVersion: z.literal("chat-prompt-source-openers.v1"),
    items: z
      .array(
        z
          .object({
            id: z.enum([
              "vscode",
              "trae-cn",
              "cursor",
              "sublime-text",
              "textedit",
              "system-default",
            ]),
            label: z.string().min(1).max(100),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();

const promptSourceOpenResponseSchema = z
  .object({
    schemaVersion: z.literal("chat-prompt-source-open.v1"),
    status: z.literal("launched"),
    relativePath: z.string().min(1).max(500),
    openerId: promptSourceOpenersResponseSchema.shape.items.element.shape.id,
  })
  .strict();

const INITIAL_STATE: PromptStudioState = {
  status: "idle",
  regions: [],
  fragments: [],
  selected: null,
  viewedRevision: null,
  sourceOpeners: [],
  saving: false,
  error: null,
};

const PENDING_WRITE_STORAGE_KEY = "chat.prompt-studio.pending-write.v1";

interface PendingPromptStudioWrite {
  readonly path: string;
  readonly requestJson: string;
  readonly commandId: string;
}

class PromptStudioHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function commandId(): string {
  return `cmd_${crypto.randomUUID().replaceAll("-", "")}`;
}

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function readPendingWrite(): PendingPromptStudioWrite | null {
  try {
    const raw = browserStorage()?.getItem(PENDING_WRITE_STORAGE_KEY);
    if (raw === null || raw === undefined) return null;
    const value = JSON.parse(raw) as Partial<PendingPromptStudioWrite>;
    return typeof value.path === "string" &&
      typeof value.requestJson === "string" &&
      typeof value.commandId === "string"
      ? { path: value.path, requestJson: value.requestJson, commandId: value.commandId }
      : null;
  } catch {
    return null;
  }
}

function persistPendingWrite(value: PendingPromptStudioWrite | null): void {
  try {
    const storage = browserStorage();
    if (storage === undefined) return;
    if (value === null) storage.removeItem(PENDING_WRITE_STORAGE_KEY);
    else storage.setItem(PENDING_WRITE_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // localStorage只是恢复缓存；不可用时仍保留当前Controller内存中的命令身份。
  }
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  return text === "" ? undefined : (JSON.parse(text) as unknown);
}

function problemMessage(value: unknown, status: number): string {
  const problem =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const title = typeof problem["title"] === "string" ? problem["title"] : `HTTP ${String(status)}`;
  const code = typeof problem["code"] === "string" ? problem["code"] : "lifeos_prompt_failed";
  return `${code}: ${title}`;
}

/** Root-scoped Prompt Studio控制器；只按需读取，不进入Session轮询或DSH Settings事实。 */
export class PromptStudioController {
  private snapshot: PromptStudioState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly fetchImpl: typeof fetch;
  private abort: AbortController | undefined;
  private disposed = false;
  private pendingWrite: PendingPromptStudioWrite | null = readPendingWrite();

  constructor(fetchImpl?: typeof fetch) {
    const request = fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.fetchImpl = (...args) => request(...args);
  }

  getSnapshot = (): PromptStudioState => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    if (this.listeners.size === 1 && this.snapshot.status === "idle") void this.refresh();
    return () => this.listeners.delete(listener);
  };

  async refresh(): Promise<void> {
    if (this.disposed) return;
    this.abort?.abort(new DOMException("prompt studio refresh superseded", "AbortError"));
    const abort = new AbortController();
    this.abort = abort;
    this.publish({ ...this.snapshot, status: "loading", error: null });
    try {
      const [regions, fragments, sourceOpeners] = await Promise.all([
        this.request("/lifeos/prompts/regions", promptRegionsDtoSchema, undefined, abort.signal),
        this.request(
          "/lifeos/prompts/fragments?limit=100",
          promptFragmentPageDtoSchema,
          undefined,
          abort.signal,
        ),
        this.request(
          "/lifeos/prompts/source-openers",
          promptSourceOpenersResponseSchema,
          undefined,
          abort.signal,
        ),
      ]);
      this.publish({
        status: "ready",
        regions: regions.items,
        fragments: fragments.items,
        selected: this.snapshot.selected,
        viewedRevision: this.snapshot.viewedRevision,
        sourceOpeners: sourceOpeners.items,
        saving: false,
        error: null,
      });
    } catch (error) {
      if (abort.signal.aborted || this.disposed) return;
      this.publish({
        ...this.snapshot,
        status: "error",
        error: error instanceof Error ? error.message : "提示词工作台读取失败",
      });
    }
  }

  async select(promptFragmentId: string): Promise<void> {
    this.publish({ ...this.snapshot, saving: true, error: null });
    try {
      const selected = await this.request(
        `/lifeos/prompts/fragments/${encodeURIComponent(promptFragmentId)}`,
        promptFragmentDetailDtoSchema,
      );
      this.publish({
        ...this.snapshot,
        selected,
        viewedRevision: selected.currentRevision,
        saving: false,
        error: null,
      });
    } catch (error) {
      this.fail(error);
    }
  }

  closeDetail(): void {
    this.publish({ ...this.snapshot, selected: null, viewedRevision: null, error: null });
  }

  async viewRevision(promptFragmentRevisionId: string): Promise<void> {
    this.publish({ ...this.snapshot, saving: true, error: null });
    try {
      const viewedRevision = await this.request(
        `/lifeos/prompts/revisions/${encodeURIComponent(promptFragmentRevisionId)}`,
        promptFragmentRevisionDetailDtoSchema,
      );
      this.publish({ ...this.snapshot, viewedRevision, saving: false, error: null });
    } catch (error) {
      this.fail(error);
    }
  }

  async create(payload: CreatePromptFragmentPayload): Promise<void> {
    await this.write("/lifeos/prompts/fragments", { payload });
  }

  async copy(payload: CopyPromptFragmentPayload): Promise<void> {
    await this.write("/lifeos/prompts/copies", { payload });
  }

  async revise(payload: RevisePromptFragmentPayload): Promise<void> {
    const selected = this.snapshot.selected;
    if (selected === null || selected.fragment.ownerKind !== "principal") return;
    await this.write(
      `/lifeos/prompts/fragments/${encodeURIComponent(selected.fragment.promptFragmentId)}/revisions`,
      { expectedRevision: selected.fragment.revision, payload },
    );
  }

  async archive(payload: ChangePromptFragmentArchiveStatusPayload): Promise<void> {
    const selected = this.snapshot.selected;
    if (selected === null || selected.fragment.ownerKind !== "principal") return;
    await this.write(
      `/lifeos/prompts/fragments/${encodeURIComponent(selected.fragment.promptFragmentId)}/archive-status`,
      { expectedRevision: selected.fragment.revision, payload },
    );
  }

  async openSourceFile(relativePath: string, openerId: PromptSourceOpener["id"]): Promise<void> {
    try {
      await this.request("/lifeos/prompts/source-files/open", promptSourceOpenResponseSchema, {
        method: "POST",
        body: JSON.stringify({ relativePath, openerId }),
      });
      this.publish({ ...this.snapshot, error: null });
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.abort?.abort(new DOMException("prompt studio disposed", "AbortError"));
    this.listeners.clear();
  }

  private async write(path: string, request: Record<string, unknown>): Promise<void> {
    this.publish({ ...this.snapshot, saving: true, error: null });
    const requestJson = JSON.stringify(request);
    const pending = this.pendingWrite;
    if (pending !== null && (pending.path !== path || pending.requestJson !== requestJson)) {
      const error = new Error("上一提示词写入结果未知；只能原样重试，或刷新确认结果");
      this.fail(error);
      throw error;
    }
    const active = pending ?? { path, requestJson, commandId: commandId() };
    this.pendingWrite = active;
    persistPendingWrite(active);
    try {
      const result = await this.request(path, promptFragmentCommandResultDtoSchema, {
        method: "POST",
        body: JSON.stringify({ commandId: active.commandId, ...request }),
      });
      const refreshed = await this.request(
        "/lifeos/prompts/fragments?limit=100",
        promptFragmentPageDtoSchema,
      );
      this.clearPendingWrite(active.commandId);
      this.publish({
        ...this.snapshot,
        status: "ready",
        fragments: refreshed.items,
        selected: result.promptFragment,
        viewedRevision: result.promptFragment.currentRevision,
        saving: false,
        error: null,
      });
    } catch (error) {
      if (
        error instanceof PromptStudioHttpError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408 &&
        error.status !== 429
      ) {
        this.clearPendingWrite(active.commandId);
      }
      this.fail(error);
      throw error;
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
      ...(signal ? { signal } : {}),
    });
    const value = await responseJson(response);
    if (!response.ok)
      throw new PromptStudioHttpError(response.status, problemMessage(value, response.status));
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new Error("lifeos_prompt_contract_mismatch: 响应合同不匹配");
    return parsed.data;
  }

  private clearPendingWrite(commandIdToClear: string): void {
    if (this.pendingWrite?.commandId !== commandIdToClear) return;
    this.pendingWrite = null;
    persistPendingWrite(null);
  }

  private fail(error: unknown): void {
    this.publish({
      ...this.snapshot,
      saving: false,
      error: error instanceof Error ? error.message : "提示词操作失败",
    });
  }

  private publish(next: PromptStudioState): void {
    if (this.disposed) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
