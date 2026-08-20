import { useEffect, useMemo, useState } from "react";
import { Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { HostObservable, InjectFace, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {
  CreatePromptFragmentPayload,
  PromptCompositionMode,
  PromptFragmentScope,
  PromptFragmentSummaryDto,
  PromptRegionDefinitionDto,
} from "@chat/contracts/public";
import type { PromptComposerState } from "./prompt-composer-controller.ts";
import { PromptFragmentDetail, type PromptStudioInjected } from "./PromptStudio.tsx";

export type PromptComposerInjected = Omit<PromptStudioInjected, "hooks"> & {
  hooks: {
    promptComposer: HostObservable<PromptComposerState>;
    promptStudio: PromptStudioInjected["hooks"]["promptStudio"];
  };
  load: () => Promise<void>;
  setMode: (regionKey: string, mode: PromptCompositionMode) => void;
  toggleRevision: (fragment: PromptFragmentSummaryDto) => void;
  reset: () => void;
  preview: (text: string) => Promise<unknown>;
  clearPreview: () => void;
};

export type PromptComposerProps = PropsRuntime<"conversation.input.left"> &
  InjectFace<PromptComposerInjected>;

const MODE_LABEL: Record<PromptCompositionMode, string> = {
  default: "默认",
  replace: "覆盖",
  append: "追加",
};

const MODE_DESCRIPTION: Record<PromptCompositionMode, string> = {
  default: "使用当前工作流 Prompt Profile 的默认组件；直接勾选下面的组件会自动切换为追加。",
  replace: "只使用下面勾选的精确版本，替换这个区域的默认组件。",
  append: "保留默认组件，并在后面按列表顺序追加勾选的精确版本。",
};

function PromptIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <path
        d="M3 2.75h7.2l2.8 2.8v7.7H3zM10 2.75v3h3M5.25 8h5.5M5.25 10.5h4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function shortHash(value: string): string {
  return value.slice(0, 8);
}

function FragmentOption({
  fragment,
  selected,
  disabled,
  toggle,
  open,
}: {
  fragment: PromptFragmentSummaryDto;
  selected: boolean;
  disabled: boolean;
  toggle: () => void;
  open: () => void;
}) {
  return (
    <div className="lifeos-prompt-choice-row" data-selected={selected ? "true" : "false"}>
      <label className="lifeos-prompt-choice">
        <input
          type="checkbox"
          checked={selected}
          disabled={disabled}
          aria-label={`选择${fragment.title}`}
          onChange={toggle}
        />
        <span className="lifeos-prompt-choice-copy">
          <strong>{fragment.title}</strong>
          <small>{fragment.description ?? "没有说明"}</small>
          <span>
            <code>v{fragment.currentRevisionNumber}</code>
            <code>{shortHash(fragment.currentRevisionSha256)}</code>
            <code>{fragment.ownerKind === "system" ? "Git 内置" : "我的组件"}</code>
          </span>
        </span>
      </label>
      <button type="button" disabled={disabled} onClick={open}>
        查看
      </button>
    </div>
  );
}

function ScopeGroup({
  title,
  hint,
  fragments,
  selectedIds,
  disabled,
  toggleRevision,
  openFragment,
  createFragment,
}: {
  title: string;
  hint: string;
  fragments: readonly PromptFragmentSummaryDto[];
  selectedIds: ReadonlySet<string>;
  disabled: boolean;
  toggleRevision: PromptComposerInjected["toggleRevision"];
  openFragment: (fragment: PromptFragmentSummaryDto) => void;
  createFragment: () => void;
}) {
  return (
    <section className="lifeos-prompt-scope-group">
      <header>
        <div>
          <strong>{title}</strong>
          <span>{hint}</span>
        </div>
        <button type="button" disabled={disabled} onClick={createFragment}>
          新建
        </button>
      </header>
      {fragments.length === 0 ? (
        <p>这个作用域当前没有可选组件。</p>
      ) : (
        <div>
          {fragments.map((fragment) => (
            <FragmentOption
              key={fragment.promptFragmentId}
              fragment={fragment}
              selected={selectedIds.has(fragment.currentRevisionId)}
              disabled={disabled}
              toggle={() => toggleRevision(fragment)}
              open={() => openFragment(fragment)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function RegionCard({
  region,
  state,
  locked,
  setMode,
  toggleRevision,
  openFragment,
  createFragment,
}: {
  region: PromptRegionDefinitionDto;
  state: PromptComposerState;
  locked: boolean;
  setMode: PromptComposerInjected["setMode"];
  toggleRevision: PromptComposerInjected["toggleRevision"];
  openFragment: (fragment: PromptFragmentSummaryDto) => void;
  createFragment: (
    region: PromptRegionDefinitionDto,
    scope: PromptFragmentScope,
    scopeTitle: string,
  ) => void;
}) {
  const composition = state.selection.regions.find((item) => item.regionKey === region.regionKey);
  const mode = composition?.mode ?? "default";
  const selectedIds = new Set(
    composition?.selected.map((item) => item.promptFragmentRevisionId) ?? [],
  );
  const available = state.fragments.filter(
    (fragment) =>
      fragment.regionKey === region.regionKey &&
      fragment.status !== "archived" &&
      (fragment.scope.kind === "global" ||
        (state.workspace !== null &&
          fragment.scope.kind === "workspace" &&
          fragment.scope.rootId === state.workspace.rootId)),
  );
  const global = available.filter((fragment) => fragment.scope.kind === "global");
  const workspace = available.filter((fragment) => fragment.scope.kind === "workspace");
  const noChoice = available.length === 0;

  return (
    <article
      className="lifeos-prompt-region-card"
      data-testid={`lifeos-prompt-region-${region.regionKey}`}
    >
      <header>
        <div>
          <strong>{region.title}</strong>
          <code>{region.regionKey}</code>
        </div>
        <span>{region.plannedPlacement === "system" ? "System" : "Messages"}</span>
      </header>
      <p>{region.description}</p>
      <div className="lifeos-prompt-mode" role="group" aria-label={`${region.title}组装方式`}>
        {(["default", "replace", "append"] as const).map((candidate) => (
          <button
            key={candidate}
            type="button"
            aria-pressed={mode === candidate}
            disabled={locked || (candidate !== "default" && noChoice)}
            onClick={() => setMode(region.regionKey, candidate)}
          >
            {MODE_LABEL[candidate]}
          </button>
        ))}
      </div>
      <p className="lifeos-prompt-mode-help">{MODE_DESCRIPTION[mode]}</p>
      <div className="lifeos-prompt-scope-list">
        <ScopeGroup
          title="全局"
          hint="可用于任何 Workspace"
          fragments={global}
          selectedIds={selectedIds}
          disabled={locked}
          toggleRevision={toggleRevision}
          openFragment={openFragment}
          createFragment={() => createFragment(region, { kind: "global" }, "全局")}
        />
        <ScopeGroup
          title="当前 Workspace"
          hint={state.workspace?.title ?? "当前会话尚未映射"}
          fragments={workspace}
          selectedIds={selectedIds}
          disabled={locked || state.workspace === null}
          toggleRevision={toggleRevision}
          openFragment={openFragment}
          createFragment={() => {
            if (state.workspace === null) return;
            createFragment(
              region,
              { kind: "workspace", rootId: state.workspace.rootId },
              state.workspace.title,
            );
          }}
        />
      </div>
    </article>
  );
}

interface CreateTarget {
  readonly region: PromptRegionDefinitionDto;
  readonly scope: PromptFragmentScope;
  readonly scopeTitle: string;
}

function PromptQuickCreate({
  target,
  saving,
  create,
  cancel,
  created,
}: {
  target: CreateTarget;
  saving: boolean;
  create: PromptComposerInjected["create"];
  cancel: () => void;
  created: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [key, setKey] = useState("");
  const [body, setBody] = useState("");

  useEffect(() => {
    setTitle("");
    setDescription("");
    setKey("");
    setBody("");
  }, [target.region.regionKey, target.scope.kind, target.scopeTitle]);

  const submit = async () => {
    const payload: CreatePromptFragmentPayload = {
      scope: target.scope,
      regionKey: target.region.regionKey,
      title,
      ...(description.trim() === "" ? {} : { description }),
      content:
        target.region.contentKind === "key_value"
          ? { kind: "key_value", key, valueMarkdown: body }
          : { kind: "markdown", bodyMarkdown: body },
    };
    await create(payload);
    created();
  };

  return (
    <form
      className="lifeos-prompt-studio-editor lifeos-prompt-quick-create"
      onSubmit={(event) => {
        event.preventDefault();
        void submit().catch(() => undefined);
      }}
    >
      <p>
        新组件将保存到 <strong>{target.scopeTitle}</strong>，并固定属于“
        {target.region.title}”区域。
      </p>
      <label>
        名称
        <input value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label>
        说明（可选）
        <input value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>
      {target.region.contentKind === "key_value" ? (
        <label>
          Key
          <input value={key} onChange={(event) => setKey(event.target.value)} />
        </label>
      ) : null}
      <label>
        Markdown 内容
        <textarea value={body} onChange={(event) => setBody(event.target.value)} />
      </label>
      <div className="lifeos-prompt-studio-actions">
        <button type="button" onClick={cancel}>
          取消
        </button>
        <button
          type="submit"
          className="lifeos-primary"
          disabled={
            saving ||
            title.trim() === "" ||
            body.trim() === "" ||
            (target.region.contentKind === "key_value" && key.trim() === "")
          }
        >
          {saving ? "保存中…" : "创建组件"}
        </button>
      </div>
    </form>
  );
}

function Preview({ state }: { state: PromptComposerState }) {
  const preview = state.preview;
  if (preview === null) return null;
  return (
    <section className="lifeos-prompt-compose-preview" data-testid="lifeos-prompt-preview">
      <header>
        <div>
          <strong>前端发送前语义预览</strong>
          <span>不是最终 Provider HTTP 请求；最终原始请求仍在 Prompt Review 审核。</span>
        </div>
        <code>{shortHash(preview.sha256)}</code>
      </header>
      <div className="lifeos-prompt-preview-regions">
        {preview.regions.map((region) => (
          <details key={region.regionKey} open={region.fragments.length > 0}>
            <summary>
              <span>
                <strong>{region.title}</strong>
                <code>{region.regionKey}</code>
              </span>
              <small>
                {MODE_LABEL[region.mode]} · {region.fragments.length} 个组件
              </small>
            </summary>
            <div className="lifeos-prompt-preview-sources">
              {region.fragments.length === 0 ? (
                <span>这个区域最终为空。</span>
              ) : (
                region.fragments.map((fragment) => (
                  <span key={fragment.promptFragmentRevisionId}>
                    {fragment.title} · v{fragment.revision} · {shortHash(fragment.sha256)}
                  </span>
                ))
              )}
            </div>
            <pre>{region.renderedText === "" ? "（空）" : region.renderedText}</pre>
          </details>
        ))}
      </div>
      <details className="lifeos-prompt-preview-final">
        <summary>查看编译后的 User Prompt</summary>
        <pre>{preview.userPrompt}</pre>
      </details>
    </section>
  );
}

/** 每次发送前都可打开；Region之间互不影响，各自拥有默认/覆盖/追加选择。 */
export function PromptComposer({
  input,
  usePromptComposer,
  usePromptStudio,
  load,
  setMode,
  toggleRevision,
  reset,
  preview,
  clearPreview,
  select,
  closeDetail,
  viewRevision,
  create,
  copy,
  revise,
  archive,
  openSourceFile,
}: PromptComposerProps) {
  const state = usePromptComposer((value) => value);
  const studioState = usePromptStudio((value) => value);
  const [open, setOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [createTarget, setCreateTarget] = useState<CreateTarget | null>(null);
  const locked = input.phase !== "plain";
  const regions = useMemo(
    () =>
      state.regions
        .filter((region) => region.userManageable && region.availability === "active")
        .sort((left, right) => left.stableOrder - right.stableOrder),
    [state.regions],
  );
  const selectedCount = state.selection.regions.reduce(
    (total, region) => total + region.selected.length,
    0,
  );

  useEffect(() => {
    if (open && state.status === "idle") void load();
  }, [load, open, state.status]);

  const close = () => {
    setManagerOpen(false);
    setCreateTarget(null);
    closeDetail();
    clearPreview();
    setOpen(false);
  };

  const closeManager = () => {
    setManagerOpen(false);
    setCreateTarget(null);
    closeDetail();
  };

  const openFragment = (fragment: PromptFragmentSummaryDto) => {
    closeDetail();
    setCreateTarget(null);
    setManagerOpen(true);
    void select(fragment.promptFragmentId);
  };

  const openCreate = (
    region: PromptRegionDefinitionDto,
    scope: PromptFragmentScope,
    scopeTitle: string,
  ) => {
    closeDetail();
    setCreateTarget({ region, scope, scopeTitle });
    setManagerOpen(true);
  };

  return (
    <>
      <button
        type="button"
        className="lifeos-prompt-composer-toggle"
        data-testid="lifeos-prompt-composer-open"
        aria-label={`配置本轮提示词，已选择 ${selectedCount} 个组件`}
        title={`配置本轮提示词，已选择 ${selectedCount} 个组件`}
        onClick={() => setOpen(true)}
      >
        <PromptIcon />
        <span>提示词</span>
        <span className="lifeos-prompt-composer-count" aria-hidden="true">
          {selectedCount}
        </span>
      </button>
      <Modal
        open={open}
        onClose={close}
        title="本轮提示词"
        closeLabel="关闭本轮提示词"
        description="每个区域独立选择默认、覆盖或追加；勾选会冻结当前精确 Revision 与 Hash。"
        className="lifeos-prompt-composer-modal"
        contentClassName="lifeos-prompt-composer-content"
        footer={
          <div className="lifeos-prompt-composer-footer">
            <span>
              {state.saving
                ? "正在保存选择…"
                : locked
                  ? "当前正在发送，只能查看"
                  : `${selectedCount} 个显式组件`}
            </span>
            <div>
              <button type="button" disabled={locked || state.saving} onClick={reset}>
                全部恢复默认
              </button>
              <button
                type="button"
                className="lifeos-primary"
                title={
                  input.draft.trim() === ""
                    ? "请先关闭面板，在主输入框输入本轮消息"
                    : "预览当前输入与区域选择的组装结果"
                }
                disabled={state.previewing || locked}
                onClick={() => void preview(input.draft)}
              >
                {state.previewing ? "正在预览…" : "预览本轮组装"}
              </button>
            </div>
          </div>
        }
      >
        <section className="lifeos-prompt-composer" data-testid="lifeos-prompt-composer">
          <div className="lifeos-prompt-composer-context">
            <div>
              <span>当前 Workspace</span>
              <strong>{state.workspace?.title ?? "未映射"}</strong>
              {state.workspace === null ? null : <code>{state.workspace.rootId}</code>}
            </div>
            <small>
              {state.workspaces.length} 个已配置 Workspace · 当前输入 {input.draft.length} 字符
            </small>
          </div>
          <p className="lifeos-prompt-composer-scope-note">
            当前首版只在“执行
            Agent（逐次提示词审核）”工作流发送时生效；切换到规划类工作流时会保留本会话草稿，但不会把这些选择传入该运行。
          </p>
          {state.error === null ? null : (
            <p className="lifeos-error" role="alert" data-testid="lifeos-prompt-composer-error">
              {state.error}
            </p>
          )}
          {state.status === "loading" && state.regions.length === 0 ? (
            <p className="lifeos-context-empty">正在读取区域、组件与会话选择…</p>
          ) : null}
          {state.status === "error" && state.regions.length === 0 ? (
            <button type="button" onClick={() => void load()}>
              重新加载
            </button>
          ) : null}
          <div className="lifeos-prompt-region-compose-list">
            {regions.map((region) => (
              <RegionCard
                key={region.regionKey}
                region={region}
                state={state}
                locked={locked || state.saving}
                setMode={setMode}
                toggleRevision={toggleRevision}
                openFragment={openFragment}
                createFragment={openCreate}
              />
            ))}
          </div>
          <Preview state={state} />
        </section>
      </Modal>
      <Modal
        open={managerOpen}
        onClose={closeManager}
        title={createTarget === null ? "查看或修改提示词组件" : "新建提示词组件"}
        closeLabel="关闭提示词组件管理"
        description="这里的写入会保存为版本化的 Chat 产品事实；Git 内置组件保持只读，可创建副本后修改。"
        className="lifeos-prompt-manager-modal"
        contentClassName="lifeos-prompt-composer-content"
      >
        {studioState.error === null ? null : (
          <p className="lifeos-error" role="alert">
            {studioState.error}
          </p>
        )}
        {createTarget !== null ? (
          <PromptQuickCreate
            target={createTarget}
            saving={studioState.saving}
            create={create}
            cancel={closeManager}
            created={() => setCreateTarget(null)}
          />
        ) : studioState.selected === null ? (
          <p className="lifeos-context-empty">
            {studioState.saving ? "正在读取组件正文与来源…" : "组件尚未加载。"}
          </p>
        ) : (
          <PromptFragmentDetail
            state={studioState}
            closeDetail={closeManager}
            viewRevision={viewRevision}
            copy={copy}
            revise={revise}
            archive={archive}
            openSourceFile={openSourceFile}
          />
        )}
      </Modal>
    </>
  );
}
