import { useEffect, useMemo, useState } from "react";
import type { InjectFace, HostObservable } from "@deepseek-ai/dsh-client-ui-slots";
import type { SettingsSectionOwnerProps } from "@deepseek-ai/dsh-client-ui-settings/client";
import type {
  PromptFragmentContent,
  PromptFragmentScope,
  PromptFragmentDetailDto,
  PromptFragmentSummaryDto,
  PromptRegionDefinitionDto,
  CreatePromptFragmentPayload,
  CopyPromptFragmentPayload,
  RevisePromptFragmentPayload,
  ChangePromptFragmentArchiveStatusPayload,
} from "@chat/contracts/public";
import type { PromptStudioState } from "./prompt-studio-controller.ts";

export interface PromptStudioInjected {
  hooks: { promptStudio: HostObservable<PromptStudioState> };
  refresh: () => Promise<void>;
  select: (promptFragmentId: string) => Promise<void>;
  closeDetail: () => void;
  viewRevision: (promptFragmentRevisionId: string) => Promise<void>;
  create: (payload: CreatePromptFragmentPayload) => Promise<void>;
  copy: (payload: CopyPromptFragmentPayload) => Promise<void>;
  revise: (payload: RevisePromptFragmentPayload) => Promise<void>;
  archive: (payload: ChangePromptFragmentArchiveStatusPayload) => Promise<void>;
  openSourceFile: (
    relativePath: string,
    openerId: PromptStudioState["sourceOpeners"][number]["id"],
  ) => Promise<void>;
}

export type PromptStudioProps = SettingsSectionOwnerProps & InjectFace<PromptStudioInjected>;
type MainTab = "regions" | "fragments";

interface EditorDraft {
  title: string;
  description: string;
  key: string;
  body: string;
}

function scopeValue(scope: PromptFragmentScope): string {
  return scope.kind === "global" ? "global" : `workspace:${scope.rootId}`;
}

function scopeFromValue(value: string): PromptFragmentScope {
  return value === "global"
    ? { kind: "global" }
    : { kind: "workspace", rootId: value.slice("workspace:".length) as never };
}

function scopeLabel(scope: PromptFragmentScope, state: PromptStudioState): string {
  if (scope.kind === "global") return "全局";
  return (
    state.workspaces.find((workspace) => workspace.rootId === scope.rootId)?.title ?? scope.rootId
  );
}

function contentText(content: PromptFragmentContent): string {
  return content.kind === "markdown" ? content.bodyMarkdown : content.valueMarkdown;
}

function draftFrom(detail: PromptFragmentDetailDto): EditorDraft {
  const revision = detail.currentRevision;
  return {
    title: revision.title,
    description: revision.description ?? "",
    key: revision.content.kind === "key_value" ? revision.content.key : "",
    body: contentText(revision.content),
  };
}

function loadDraft(detail: PromptFragmentDetailDto): EditorDraft {
  const fallback = draftFrom(detail);
  try {
    const raw = localStorage.getItem(
      `chat.prompt-studio.draft.v1.${detail.fragment.promptFragmentId}`,
    );
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw) as Partial<EditorDraft>;
    return {
      title: typeof parsed.title === "string" ? parsed.title : fallback.title,
      description:
        typeof parsed.description === "string" ? parsed.description : fallback.description,
      key: typeof parsed.key === "string" ? parsed.key : fallback.key,
      body: typeof parsed.body === "string" ? parsed.body : fallback.body,
    };
  } catch {
    return fallback;
  }
}

function FragmentCard({
  fragment,
  region,
  scope,
  open,
}: {
  fragment: PromptFragmentSummaryDto;
  region: PromptRegionDefinitionDto | undefined;
  scope: string;
  open: () => void;
}) {
  return (
    <button type="button" className="lifeos-prompt-library-card" onClick={open}>
      <span className="lifeos-prompt-library-card-title">
        <strong>{fragment.title}</strong>
        <small data-kind={fragment.ownerKind}>
          {fragment.ownerKind === "system" ? "内置" : "我的"}
        </small>
      </span>
      <span>{fragment.description ?? "没有描述"}</span>
      <span className="lifeos-prompt-library-meta">
        <span>{region?.title ?? "未知区域"}</span>
        <code>{fragment.regionKey}</code>
        <code>v{fragment.currentRevisionNumber}</code>
        <code>{scope}</code>
        {fragment.status === "archived" ? <code>已归档</code> : null}
      </span>
    </button>
  );
}

function SourceOpenMenu({
  relativePath,
  openers,
  label,
  openSourceFile,
}: {
  relativePath: string;
  openers: PromptStudioState["sourceOpeners"];
  label: string;
  openSourceFile: PromptStudioInjected["openSourceFile"];
}) {
  if (openers.length === 0) {
    return <span className="lifeos-prompt-source-unavailable">本机打开不可用</span>;
  }
  return (
    <details className="lifeos-prompt-source-open-menu">
      <summary>{label}</summary>
      <div>
        {openers.map((opener) => (
          <button
            key={opener.id}
            type="button"
            onClick={() => void openSourceFile(relativePath, opener.id).catch(() => undefined)}
          >
            {opener.label}
          </button>
        ))}
      </div>
    </details>
  );
}

export function PromptFragmentDetail({
  state,
  closeDetail,
  viewRevision,
  copy,
  revise,
  archive,
  openSourceFile,
}: Pick<
  PromptStudioProps,
  "closeDetail" | "viewRevision" | "copy" | "revise" | "archive" | "openSourceFile"
> & {
  state: PromptStudioState;
}) {
  const detail = state.selected!;
  const viewed = state.viewedRevision ?? detail.currentRevision;
  const isCurrent =
    viewed.promptFragmentRevisionId === detail.currentRevision.promptFragmentRevisionId;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditorDraft>(() => loadDraft(detail));
  const [copyScope, setCopyScope] = useState(() => scopeValue(detail.fragment.scope));
  const region = state.regions.find((item) => item.regionKey === viewed.regionKey);

  useEffect(() => {
    setEditing(false);
    setDraft(loadDraft(detail));
    setCopyScope(scopeValue(detail.fragment.scope));
  }, [detail.fragment.promptFragmentId, detail.fragment.currentRevisionSha256]);

  useEffect(() => {
    if (!editing || detail.fragment.ownerKind !== "principal") return;
    localStorage.setItem(
      `chat.prompt-studio.draft.v1.${detail.fragment.promptFragmentId}`,
      JSON.stringify(draft),
    );
  }, [detail.fragment.ownerKind, detail.fragment.promptFragmentId, draft, editing]);

  const save = async () => {
    const content: PromptFragmentContent =
      detail.currentRevision.content.kind === "key_value"
        ? { kind: "key_value", key: draft.key, valueMarkdown: draft.body }
        : { kind: "markdown", bodyMarkdown: draft.body };
    await revise({
      currentRevisionId: detail.fragment.currentRevisionId,
      currentRevisionSha256: detail.fragment.currentRevisionSha256,
      revision: {
        regionKey: detail.currentRevision.regionKey,
        title: draft.title,
        ...(draft.description.trim() === "" ? {} : { description: draft.description }),
        content,
      },
    });
    localStorage.removeItem(`chat.prompt-studio.draft.v1.${detail.fragment.promptFragmentId}`);
    setEditing(false);
  };

  return (
    <div className="lifeos-prompt-studio-detail">
      <button type="button" className="lifeos-prompt-studio-back" onClick={closeDetail}>
        ← 返回组件列表
      </button>
      <header>
        <div>
          <small>
            {detail.fragment.ownerKind === "system" ? "Git 内置组件" : "我的版本化组件"}
          </small>
          <h2>{detail.fragment.title}</h2>
        </div>
        <span>
          {detail.fragment.status === "builtin"
            ? "只读"
            : detail.fragment.status === "active"
              ? "使用中"
              : "已归档"}
        </span>
      </header>

      <dl className="lifeos-prompt-studio-facts">
        <div>
          <dt>区域</dt>
          <dd className="lifeos-prompt-region-reference">
            <strong>{region?.title ?? "未知区域"}</strong>
            <code>{viewed.regionKey}</code>
          </dd>
        </div>
        <div>
          <dt>版本</dt>
          <dd>v{viewed.revision}</dd>
        </div>
        <div>
          <dt>作用域</dt>
          <dd>{scopeLabel(detail.fragment.scope, state)}</dd>
        </div>
        <div>
          <dt>Revision</dt>
          <dd>
            <code>{viewed.promptFragmentRevisionId}</code>
          </dd>
        </div>
        <div>
          <dt>Hash</dt>
          <dd>
            <code>{viewed.sha256}</code>
          </dd>
        </div>
        {viewed.sourceRelativePath === undefined ? null : (
          <div>
            <dt>来源文件</dt>
            <dd>
              <code>{viewed.sourceRelativePath}</code>
            </dd>
          </div>
        )}
      </dl>

      <section className="lifeos-prompt-studio-versions" aria-label="历史版本">
        <strong>版本</strong>
        <div>
          {detail.revisions.map((revision) => (
            <button
              key={revision.promptFragmentRevisionId}
              type="button"
              aria-pressed={viewed.promptFragmentRevisionId === revision.promptFragmentRevisionId}
              onClick={() => void viewRevision(revision.promptFragmentRevisionId)}
            >
              v{revision.revision}
            </button>
          ))}
        </div>
      </section>

      {viewed.sourceRelativePath !== undefined ? (
        <section className="lifeos-prompt-source-file" aria-label="来源文件原文">
          <header>
            <div>
              <span>
                {detail.fragment.ownerKind === "system" ? "Git 来源文件" : "受管 Markdown 文件"}
              </span>
              <strong>文件原文</strong>
              <p>
                <code>{viewed.sourceRelativePath}</code>
              </p>
            </div>
            <SourceOpenMenu
              relativePath={viewed.sourceRelativePath}
              openers={state.sourceOpeners}
              label="打开文件"
              openSourceFile={openSourceFile}
            />
          </header>
          {viewed.content.kind === "key_value" ? <strong>{viewed.content.key}</strong> : null}
          <pre>{contentText(viewed.content)}</pre>
        </section>
      ) : null}

      {editing ? (
        <section className="lifeos-prompt-studio-editor">
          <label>
            名称
            <input
              value={draft.title}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            />
          </label>
          <label>
            说明
            <input
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </label>
          {detail.currentRevision.content.kind === "key_value" ? (
            <label>
              Key
              <input
                value={draft.key}
                onChange={(event) => setDraft({ ...draft, key: event.target.value })}
              />
            </label>
          ) : null}
          <label>
            Markdown
            <textarea
              value={draft.body}
              onChange={(event) => setDraft({ ...draft, body: event.target.value })}
            />
          </label>
          <p>草稿保存在当前浏览器；“保存新版本”后才成为 Chat 产品事实。</p>
          <div className="lifeos-prompt-studio-actions">
            <button
              type="button"
              onClick={() => {
                setDraft(draftFrom(detail));
                setEditing(false);
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="lifeos-primary"
              disabled={state.saving || draft.title.trim() === "" || draft.body.trim() === ""}
              onClick={() => void save().catch(() => undefined)}
            >
              {state.saving ? "保存中…" : "保存为新版本"}
            </button>
          </div>
        </section>
      ) : viewed.sourceRelativePath === undefined ? (
        <section className="lifeos-prompt-studio-content">
          {viewed.content.kind === "key_value" ? <strong>{viewed.content.key}</strong> : null}
          <pre>{contentText(viewed.content)}</pre>
        </section>
      ) : null}

      <div className="lifeos-prompt-studio-actions">
        <label className="lifeos-prompt-copy-scope">
          副本保存到
          <select value={copyScope} onChange={(event) => setCopyScope(event.target.value)}>
            <option value="global">全局</option>
            {state.workspaces.map((workspace) => (
              <option key={workspace.rootId} value={`workspace:${workspace.rootId}`}>
                Workspace · {workspace.title}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={state.saving}
          onClick={() =>
            void copy({
              sourcePromptFragmentRevisionId: viewed.promptFragmentRevisionId,
              sourceSha256: viewed.sha256,
              destinationScope: scopeFromValue(copyScope),
            }).catch(() => undefined)
          }
        >
          基于 v{viewed.revision} 创建副本
        </button>
        {detail.fragment.ownerKind === "system" ? null : detail.fragment.status === "active" ? (
          <>
            <button
              type="button"
              disabled={!isCurrent || state.saving}
              onClick={() => setEditing(true)}
            >
              编辑当前版本
            </button>
            <button
              type="button"
              disabled={state.saving}
              onClick={() =>
                void archive({
                  currentRevisionId: detail.fragment.currentRevisionId,
                  currentRevisionSha256: detail.fragment.currentRevisionSha256,
                  targetStatus: "archived",
                }).catch(() => undefined)
              }
            >
              归档
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={state.saving}
            onClick={() =>
              void archive({
                currentRevisionId: detail.fragment.currentRevisionId,
                currentRevisionSha256: detail.fragment.currentRevisionSha256,
                targetStatus: "active",
              }).catch(() => undefined)
            }
          >
            恢复
          </button>
        )}
      </div>
    </div>
  );
}

export function PromptStudio({
  usePromptStudio,
  refresh,
  select,
  closeDetail,
  viewRevision,
  create,
  copy,
  revise,
  archive,
  openSourceFile,
}: PromptStudioProps) {
  const state = usePromptStudio((value) => value);
  const [tab, setTab] = useState<MainTab>("fragments");
  const [regionFilter, setRegionFilter] = useState("all");
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState({
    scope: "global",
    regionKey: "background",
    title: "",
    key: "",
    body: "",
  });
  const createRegion = state.regions.find((region) => region.regionKey === createDraft.regionKey);
  const contextRegions = useMemo(
    () => state.regions.filter((region) => region.category !== "identity"),
    [state.regions],
  );
  const filtered = useMemo(
    () =>
      state.fragments.filter(
        (item) =>
          item.regionKey !== "agent_identity" &&
          (regionFilter === "all" || item.regionKey === regionFilter),
      ),
    [regionFilter, state.fragments],
  );
  const fragmentCountByRegion = useMemo(() => {
    const counts = new Map<string, number>();
    for (const fragment of state.fragments.filter((item) => item.regionKey !== "agent_identity")) {
      counts.set(fragment.regionKey, (counts.get(fragment.regionKey) ?? 0) + 1);
    }
    return counts;
  }, [state.fragments]);
  const regionByKey = useMemo(
    () => new Map(state.regions.map((region) => [region.regionKey, region])),
    [state.regions],
  );

  if (state.selected !== null) {
    return (
      <PromptFragmentDetail
        state={state}
        closeDetail={closeDetail}
        viewRevision={viewRevision}
        copy={copy}
        revise={revise}
        archive={archive}
        openSourceFile={openSourceFile}
      />
    );
  }

  return (
    <section className="lifeos-prompt-studio" data-testid="lifeos-prompt-studio">
      <header className="lifeos-prompt-studio-header">
        <div>
          <h1>提示词</h1>
          <p>管理会话与Workspace上下文组件；Agent自己的System Prompt请使用独立“Agent”设置。</p>
        </div>
        <button type="button" disabled={state.status === "loading"} onClick={() => void refresh()}>
          刷新
        </button>
      </header>
      <nav className="lifeos-prompt-studio-tabs" aria-label="提示词工作台">
        <button
          type="button"
          aria-selected={tab === "fragments"}
          onClick={() => setTab("fragments")}
        >
          提示词组件
        </button>
        <button type="button" aria-selected={tab === "regions"} onClick={() => setTab("regions")}>
          区域说明
        </button>
      </nav>
      {state.error === null ? null : (
        <p className="lifeos-prompt-studio-error" role="alert">
          {state.error}
        </p>
      )}
      {state.status === "loading" && state.fragments.length === 0 ? (
        <p className="lifeos-prompt-studio-empty">正在读取…</p>
      ) : null}

      {tab === "regions" ? (
        <div className="lifeos-prompt-region-list">
          {contextRegions.map((region) => (
            <article key={region.regionKey}>
              <header>
                <strong>{region.title}</strong>
                <code>{region.regionKey}</code>
              </header>
              <p>{region.description}</p>
              <footer>
                <div className="lifeos-prompt-region-meta">
                  <span>{region.userManageable ? "可管理" : "运行时只读"}</span>
                  <span>→ {region.plannedPlacement}</span>
                  <span>{region.availability === "active" ? "管理已启用" : "组装待接入"}</span>
                  <code>{region.sourceRelativePath}</code>
                </div>
                <div className="lifeos-prompt-region-actions">
                  <SourceOpenMenu
                    relativePath={region.sourceRelativePath}
                    openers={state.sourceOpeners}
                    label="打开配置文件"
                    openSourceFile={openSourceFile}
                  />
                  <button
                    type="button"
                    disabled={(fragmentCountByRegion.get(region.regionKey) ?? 0) === 0}
                    aria-label={`查看${region.title}区域的组件`}
                    onClick={() => {
                      setRegionFilter(region.regionKey);
                      setTab("fragments");
                    }}
                  >
                    查看 {fragmentCountByRegion.get(region.regionKey) ?? 0} 个组件
                  </button>
                </div>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <>
          <div className="lifeos-prompt-library-toolbar">
            <select
              aria-label="按区域筛选"
              value={regionFilter}
              onChange={(event) => setRegionFilter(event.target.value)}
            >
              <option value="all">全部区域</option>
              {contextRegions
                .filter((region) => region.userManageable)
                .map((region) => (
                  <option key={region.regionKey} value={region.regionKey}>
                    {region.title}
                  </option>
                ))}
            </select>
            <button type="button" onClick={() => setCreating((value) => !value)}>
              新建组件
            </button>
          </div>
          {creating ? (
            <form
              className="lifeos-prompt-studio-editor"
              onSubmit={(event) => {
                event.preventDefault();
                void create({
                  scope: scopeFromValue(createDraft.scope),
                  regionKey: createDraft.regionKey,
                  title: createDraft.title,
                  content:
                    createRegion?.contentKind === "key_value"
                      ? {
                          kind: "key_value",
                          key: createDraft.key,
                          valueMarkdown: createDraft.body,
                        }
                      : { kind: "markdown", bodyMarkdown: createDraft.body },
                })
                  .then(() => {
                    setCreating(false);
                    setCreateDraft({
                      scope: "global",
                      regionKey: "background",
                      title: "",
                      key: "",
                      body: "",
                    });
                  })
                  .catch(() => undefined);
              }}
            >
              <label>
                保存到
                <select
                  value={createDraft.scope}
                  onChange={(event) =>
                    setCreateDraft({ ...createDraft, scope: event.target.value })
                  }
                >
                  <option value="global">全局 · 所有 Workspace 可用</option>
                  {state.workspaces.map((workspace) => (
                    <option key={workspace.rootId} value={`workspace:${workspace.rootId}`}>
                      Workspace · {workspace.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                区域
                <select
                  value={createDraft.regionKey}
                  onChange={(event) =>
                    setCreateDraft({ ...createDraft, regionKey: event.target.value })
                  }
                >
                  {contextRegions
                    .filter((region) => region.userManageable && region.contentKind !== "runtime")
                    .map((region) => (
                      <option key={region.regionKey} value={region.regionKey}>
                        {region.title}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                名称
                <input
                  value={createDraft.title}
                  onChange={(event) =>
                    setCreateDraft({ ...createDraft, title: event.target.value })
                  }
                />
              </label>
              {createRegion?.contentKind === "key_value" ? (
                <label>
                  Key
                  <input
                    value={createDraft.key}
                    onChange={(event) =>
                      setCreateDraft({ ...createDraft, key: event.target.value })
                    }
                  />
                </label>
              ) : null}
              <label>
                Markdown
                <textarea
                  value={createDraft.body}
                  onChange={(event) => setCreateDraft({ ...createDraft, body: event.target.value })}
                />
              </label>
              <div className="lifeos-prompt-studio-actions">
                <button type="button" onClick={() => setCreating(false)}>
                  取消
                </button>
                <button
                  type="submit"
                  className="lifeos-primary"
                  disabled={
                    state.saving ||
                    createDraft.title.trim() === "" ||
                    (createRegion?.contentKind === "key_value" && createDraft.key.trim() === "") ||
                    createDraft.body.trim() === ""
                  }
                >
                  创建
                </button>
              </div>
            </form>
          ) : null}
          <div className="lifeos-prompt-library-list">
            {filtered.map((fragment) => (
              <FragmentCard
                key={fragment.promptFragmentId}
                fragment={fragment}
                region={regionByKey.get(fragment.regionKey)}
                scope={scopeLabel(fragment.scope, state)}
                open={() => void select(fragment.promptFragmentId)}
              />
            ))}
          </div>
          {state.status === "ready" && filtered.length === 0 ? (
            <p className="lifeos-prompt-studio-empty">这个区域还没有组件。</p>
          ) : null}
        </>
      )}
    </section>
  );
}
