import type { ZodType } from "zod";
import {
  promptConfigurationPreviewDtoSchema,
  promptFragmentPageDtoSchema,
  promptRegionsDtoSchema,
  promptTurnSelectionInputSchema,
  promptWorkspacesDtoSchema,
  type PromptConfigurationPreviewDto,
  type PromptCompositionMode,
  type PromptFragmentSummaryDto,
  type PromptRegionDefinitionDto,
  type PromptRegionCompositionInput,
  type PromptTurnSelectionInput,
  type PromptWorkspaceDto,
} from "@chat/contracts/public";
import {
  dshBridgeSendPreviewSchema,
  promptSelectionProjectionSchema,
  type DshBridgeSendPreview,
  type PromptSelectionProjection,
} from "../contracts.ts";

export interface PromptComposerState {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly regions: readonly PromptRegionDefinitionDto[];
  readonly fragments: readonly PromptFragmentSummaryDto[];
  readonly workspaces: readonly PromptWorkspaceDto[];
  readonly workspace: PromptSelectionProjection["workspace"];
  readonly selection: PromptTurnSelectionInput;
  readonly saving: boolean;
  readonly previewing: boolean;
  readonly configurationPreview: PromptConfigurationPreviewDto | null;
  readonly bridgeSendPreview: DshBridgeSendPreview | null;
  readonly error: string | null;
}

const EMPTY_SELECTION: PromptTurnSelectionInput = {
  schemaVersion: "prompt-turn-selection-input.v1",
  regions: [],
};

function storageKey(sessionId: string): string {
  return `chat.prompt-composer.selection.v1.${sessionId}`;
}

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function readSelection(sessionId: string, storage: Storage | undefined): PromptTurnSelectionInput {
  try {
    const raw = storage?.getItem(storageKey(sessionId));
    if (raw === null || raw === undefined) return EMPTY_SELECTION;
    const parsed = promptTurnSelectionInputSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : EMPTY_SELECTION;
  } catch {
    return EMPTY_SELECTION;
  }
}

function persistSelection(
  sessionId: string,
  storage: Storage | undefined,
  selection: PromptTurnSelectionInput,
): void {
  try {
    storage?.setItem(storageKey(sessionId), JSON.stringify(selection));
  } catch {
    // 浏览器缓存只是未发送草稿恢复；不可用时，Bridge会话投影仍是权威选择事实。
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
  const code =
    typeof problem["code"] === "string" ? problem["code"] : "lifeos_prompt_selection_failed";
  return `${code}: ${title}`;
}

function regionSelection(
  selection: PromptTurnSelectionInput,
  regionKey: string,
): PromptRegionCompositionInput {
  return (
    selection.regions.find((item) => item.regionKey === regionKey) ?? {
      regionKey,
      mode: "default",
      selected: [],
    }
  );
}

function replaceRegion(
  selection: PromptTurnSelectionInput,
  next: PromptRegionCompositionInput,
): PromptTurnSelectionInput {
  const regions = selection.regions.filter((item) => item.regionKey !== next.regionKey);
  if (next.mode !== "default") regions.push(next);
  return { ...selection, regions };
}

/**
 * 每个DSH Session独立持有一份Prompt选择草稿。浏览器缓存只负责页面恢复；每次有效
 * 修改都按顺序PUT到Bridge，避免并发点击造成较早响应覆盖较新选择。
 */
export class PromptComposerController {
  private snapshot: PromptComposerState;
  private readonly listeners = new Set<() => void>();
  private readonly fetchImpl: typeof fetch;
  private readonly storage: Storage | undefined;
  private abort: AbortController | undefined;
  private disposed = false;
  private pendingSelection: PromptTurnSelectionInput | null = null;
  private staging: Promise<void> | undefined;

  constructor(
    readonly sessionId: string,
    fetchImpl?: typeof fetch,
    storage?: Storage,
  ) {
    const request = fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.fetchImpl = (...args) => request(...args);
    this.storage = storage ?? browserStorage();
    this.snapshot = {
      status: "idle",
      regions: [],
      fragments: [],
      workspaces: [],
      workspace: null,
      selection: readSelection(sessionId, this.storage),
      saving: false,
      previewing: false,
      configurationPreview: null,
      bridgeSendPreview: null,
      error: null,
    };
  }

  getSnapshot = (): PromptComposerState => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** 打开面板时按需读取目录和服务端会话草稿，不进入Product Run轮询。 */
  async load(): Promise<void> {
    if (this.disposed) return;
    this.abort?.abort(new DOMException("prompt composer load superseded", "AbortError"));
    const abort = new AbortController();
    this.abort = abort;
    this.publish({ ...this.snapshot, status: "loading", error: null });
    try {
      const [regions, fragments, workspaces, projection] = await Promise.all([
        this.request("/lifeos/prompts/regions", promptRegionsDtoSchema, undefined, abort.signal),
        this.request(
          "/lifeos/prompts/fragments?limit=100",
          promptFragmentPageDtoSchema,
          undefined,
          abort.signal,
        ),
        this.request(
          "/lifeos/prompts/workspaces",
          promptWorkspacesDtoSchema,
          undefined,
          abort.signal,
        ),
        this.request(
          `/lifeos/sessions/${encodeURIComponent(this.sessionId)}/prompt-selection`,
          promptSelectionProjectionSchema,
          undefined,
          abort.signal,
        ),
      ]);
      persistSelection(this.sessionId, this.storage, projection.promptSelection);
      this.publish({
        status: "ready",
        regions: regions.items,
        fragments: fragments.items,
        workspaces: workspaces.items,
        workspace: projection.workspace,
        selection: projection.promptSelection,
        saving: false,
        previewing: false,
        configurationPreview: null,
        bridgeSendPreview: null,
        error: null,
      });
    } catch (error) {
      if (abort.signal.aborted || this.disposed) return;
      this.publish({
        ...this.snapshot,
        status: "error",
        error: error instanceof Error ? error.message : "提示词选择读取失败",
      });
    }
  }

  setMode(regionKey: string, mode: PromptCompositionMode): void {
    if (this.disposed) return;
    const current = regionSelection(this.snapshot.selection, regionKey);
    if (current.mode === mode) return;
    if (mode === "default") {
      this.commit(replaceRegion(this.snapshot.selection, { regionKey, mode, selected: [] }));
      return;
    }
    const selected =
      current.selected.length > 0
        ? current.selected
        : this.visibleFragments(regionKey)
            .slice(0, 1)
            .map((fragment) => ({
              promptFragmentRevisionId: fragment.currentRevisionId,
              sha256: fragment.currentRevisionSha256,
            }));
    if (selected.length === 0) return;
    this.commit(replaceRegion(this.snapshot.selection, { regionKey, mode, selected }));
  }

  toggleRevision(fragment: PromptFragmentSummaryDto): void {
    if (this.disposed) return;
    const current = regionSelection(this.snapshot.selection, fragment.regionKey);
    const exists = current.selected.some(
      (item) => item.promptFragmentRevisionId === fragment.currentRevisionId,
    );
    const selected = exists
      ? current.selected.filter(
          (item) => item.promptFragmentRevisionId !== fragment.currentRevisionId,
        )
      : [
          ...current.selected,
          {
            promptFragmentRevisionId: fragment.currentRevisionId,
            sha256: fragment.currentRevisionSha256,
          },
        ];
    if (selected.length === 0) {
      this.commit(
        replaceRegion(this.snapshot.selection, {
          regionKey: fragment.regionKey,
          mode: "default",
          selected: [],
        }),
      );
      return;
    }
    const ordered = this.visibleFragments(fragment.regionKey)
      .filter((candidate) =>
        selected.some((item) => item.promptFragmentRevisionId === candidate.currentRevisionId),
      )
      .map((candidate) => ({
        promptFragmentRevisionId: candidate.currentRevisionId,
        sha256: candidate.currentRevisionSha256,
      }));
    this.commit(
      replaceRegion(this.snapshot.selection, {
        regionKey: fragment.regionKey,
        mode: current.mode === "default" ? "append" : current.mode,
        selected: ordered,
      }),
    );
  }

  reset(): void {
    const selection: PromptTurnSelectionInput = {
      schemaVersion: "prompt-turn-selection-input.v1",
      ...(this.snapshot.workspace === null
        ? {}
        : { workspaceRootId: this.snapshot.workspace.rootId }),
      regions: [],
    };
    this.commit(selection);
  }

  async previewConfiguration(): Promise<PromptConfigurationPreviewDto | null> {
    if (this.disposed) return null;
    this.publish({
      ...this.snapshot,
      previewing: true,
      configurationPreview: null,
      error: null,
    });
    try {
      const configurationPreview = await this.request(
        "/lifeos/prompts/configuration-previews",
        promptConfigurationPreviewDtoSchema,
        {
          method: "POST",
          body: JSON.stringify({ selection: this.snapshot.selection }),
        },
      );
      this.publish({
        ...this.snapshot,
        previewing: false,
        configurationPreview,
        error: null,
      });
      return configurationPreview;
    } catch (error) {
      this.publish({
        ...this.snapshot,
        previewing: false,
        configurationPreview: null,
        error: error instanceof Error ? error.message : "提示词配置预览失败",
      });
      return null;
    }
  }

  async previewBridgeSend(text: string): Promise<DshBridgeSendPreview | null> {
    const normalized = text.trim();
    if (normalized === "" || this.disposed) {
      this.publish({ ...this.snapshot, error: "请先输入本轮消息，再预览组装结果" });
      return null;
    }
    this.publish({
      ...this.snapshot,
      previewing: true,
      bridgeSendPreview: null,
      error: null,
    });
    try {
      const bridgeSendPreview = await this.request(
        `/lifeos/sessions/${encodeURIComponent(this.sessionId)}/bridge-send-previews`,
        dshBridgeSendPreviewSchema,
        {
          method: "POST",
          body: JSON.stringify({ text: normalized }),
        },
      );
      this.publish({
        ...this.snapshot,
        previewing: false,
        bridgeSendPreview,
        error: null,
      });
      return bridgeSendPreview;
    } catch (error) {
      this.publish({
        ...this.snapshot,
        previewing: false,
        bridgeSendPreview: null,
        error: error instanceof Error ? error.message : "DSH Bridge发送预览失败",
      });
      return null;
    }
  }

  clearPreviews(): void {
    this.publish({
      ...this.snapshot,
      configurationPreview: null,
      bridgeSendPreview: null,
      error: null,
    });
  }

  dispose(): void {
    this.disposed = true;
    this.abort?.abort(new DOMException("prompt composer disposed", "AbortError"));
    this.listeners.clear();
  }

  private visibleFragments(regionKey: string): readonly PromptFragmentSummaryDto[] {
    const rootId = this.snapshot.workspace?.rootId;
    return this.snapshot.fragments.filter(
      (fragment) =>
        fragment.regionKey === regionKey &&
        fragment.status !== "archived" &&
        (fragment.scope.kind === "global" ||
          (rootId !== undefined &&
            fragment.scope.kind === "workspace" &&
            fragment.scope.rootId === rootId)),
    );
  }

  private commit(selection: PromptTurnSelectionInput): void {
    const normalized = promptTurnSelectionInputSchema.parse(selection);
    persistSelection(this.sessionId, this.storage, normalized);
    this.pendingSelection = normalized;
    this.publish({
      ...this.snapshot,
      selection: normalized,
      saving: true,
      configurationPreview: null,
      bridgeSendPreview: null,
      error: null,
    });
    this.staging ??= this.flushSelection().finally(() => {
      this.staging = undefined;
      if (this.pendingSelection !== null && !this.disposed) {
        this.staging = this.flushSelection().finally(() => {
          this.staging = undefined;
        });
      }
    });
  }

  private async flushSelection(): Promise<void> {
    while (!this.disposed && this.pendingSelection !== null) {
      const selection = this.pendingSelection;
      this.pendingSelection = null;
      try {
        const projection = await this.request(
          `/lifeos/sessions/${encodeURIComponent(this.sessionId)}/prompt-selection`,
          promptSelectionProjectionSchema,
          {
            method: "PUT",
            body: JSON.stringify({ promptSelection: selection }),
          },
        );
        if (this.pendingSelection === null) {
          persistSelection(this.sessionId, this.storage, projection.promptSelection);
          this.publish({
            ...this.snapshot,
            workspace: projection.workspace,
            selection: projection.promptSelection,
            saving: false,
            error: null,
          });
        }
      } catch (error) {
        this.publish({
          ...this.snapshot,
          saving: false,
          error: error instanceof Error ? error.message : "提示词选择保存失败",
        });
        return;
      }
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
      credentials: "same-origin",
      headers,
      ...(signal === undefined ? {} : { signal }),
    });
    const value = await responseJson(response);
    if (!response.ok) throw new Error(problemMessage(value, response.status));
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new Error("lifeos_prompt_contract_mismatch: 响应合同不匹配");
    return parsed.data;
  }

  private publish(next: PromptComposerState): void {
    if (this.disposed) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
