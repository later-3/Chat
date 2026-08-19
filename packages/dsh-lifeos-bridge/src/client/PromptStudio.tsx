import { useEffect, useMemo, useState } from "react";
import type { InjectFace, HostObservable } from "@deepseek-ai/dsh-client-ui-slots";
import type { SettingsSectionOwnerProps } from "@deepseek-ai/dsh-client-ui-settings/client";
import type {
  PromptFragmentContent,
  PromptFragmentDetailDto,
  PromptFragmentSummaryDto,
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
}

export type PromptStudioProps = SettingsSectionOwnerProps & InjectFace<PromptStudioInjected>;
type MainTab = "regions" | "fragments";

interface EditorDraft {
  title: string;
  description: string;
  key: string;
  body: string;
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
  open,
}: {
  fragment: PromptFragmentSummaryDto;
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
        <code>{fragment.regionKey}</code>
        <code>v{fragment.currentRevisionNumber}</code>
        {fragment.status === "archived" ? <code>已归档</code> : null}
      </span>
    </button>
  );
}

function PromptDetail({
  state,
  closeDetail,
  viewRevision,
  copy,
  revise,
  archive,
}: Pick<PromptStudioProps, "closeDetail" | "viewRevision" | "copy" | "revise" | "archive"> & {
  state: PromptStudioState;
}) {
  const detail = state.selected!;
  const viewed = state.viewedRevision ?? detail.currentRevision;
  const isCurrent =
    viewed.promptFragmentRevisionId === detail.currentRevision.promptFragmentRevisionId;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditorDraft>(() => loadDraft(detail));

  useEffect(() => {
    setEditing(false);
    setDraft(loadDraft(detail));
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
          <dd>{viewed.regionKey}</dd>
        </div>
        <div>
          <dt>版本</dt>
          <dd>v{viewed.revision}</dd>
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
      ) : (
        <section className="lifeos-prompt-studio-content">
          {viewed.content.kind === "key_value" ? <strong>{viewed.content.key}</strong> : null}
          <pre>{contentText(viewed.content)}</pre>
        </section>
      )}

      <div className="lifeos-prompt-studio-actions">
        {detail.fragment.ownerKind === "system" ? (
          <button
            type="button"
            className="lifeos-primary"
            disabled={state.saving}
            onClick={() =>
              void copy({
                sourcePromptFragmentRevisionId: detail.currentRevision.promptFragmentRevisionId,
                sourceSha256: detail.currentRevision.sha256,
              }).catch(() => undefined)
            }
          >
            创建我的副本
          </button>
        ) : detail.fragment.status === "active" ? (
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
}: PromptStudioProps) {
  const state = usePromptStudio((value) => value);
  const [tab, setTab] = useState<MainTab>("fragments");
  const [regionFilter, setRegionFilter] = useState("all");
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState({
    regionKey: "background",
    title: "",
    key: "",
    body: "",
  });
  const createRegion = state.regions.find((region) => region.regionKey === createDraft.regionKey);
  const filtered = useMemo(
    () =>
      state.fragments.filter((item) => regionFilter === "all" || item.regionKey === regionFilter),
    [regionFilter, state.fragments],
  );

  if (state.selected !== null) {
    return (
      <PromptDetail
        state={state}
        closeDetail={closeDetail}
        viewRevision={viewRevision}
        copy={copy}
        revise={revise}
        archive={archive}
      />
    );
  }

  return (
    <section className="lifeos-prompt-studio" data-testid="lifeos-prompt-studio">
      <header className="lifeos-prompt-studio-header">
        <div>
          <h1>提示词</h1>
          <p>查看来源、创建副本并管理不可变版本。本阶段只管理，不改变模型运行。</p>
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
          {state.regions.map((region) => (
            <article key={region.regionKey}>
              <header>
                <strong>{region.title}</strong>
                <code>{region.regionKey}</code>
              </header>
              <p>{region.description}</p>
              <footer>
                <span>{region.userManageable ? "可管理" : "运行时只读"}</span>
                <span>→ {region.plannedPlacement}</span>
                <span>{region.availability === "active" ? "管理已启用" : "组装待接入"}</span>
                <code>{region.sourceRelativePath}</code>
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
              {state.regions
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
                    setCreateDraft({ regionKey: "background", title: "", key: "", body: "" });
                  })
                  .catch(() => undefined);
              }}
            >
              <label>
                区域
                <select
                  value={createDraft.regionKey}
                  onChange={(event) =>
                    setCreateDraft({ ...createDraft, regionKey: event.target.value })
                  }
                >
                  {state.regions
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
