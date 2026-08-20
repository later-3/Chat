import { useEffect, useMemo, useState } from "react";
import { Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { HostObservable, InjectFace, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {
  PromptCompositionMode,
  PromptFragmentSummaryDto,
  PromptRegionDefinitionDto,
} from "@chat/contracts/public";
import type { PromptComposerState } from "./prompt-composer-controller.ts";

export interface PromptComposerInjected {
  hooks: { promptComposer: HostObservable<PromptComposerState> };
  load: () => Promise<void>;
  setMode: (regionKey: string, mode: PromptCompositionMode) => void;
  toggleRevision: (fragment: PromptFragmentSummaryDto) => void;
  reset: () => void;
  preview: (text: string) => Promise<unknown>;
  clearPreview: () => void;
}

export type PromptComposerProps = PropsRuntime<"conversation.input.left"> &
  InjectFace<PromptComposerInjected>;

const MODE_LABEL: Record<PromptCompositionMode, string> = {
  default: "默认",
  replace: "覆盖",
  append: "追加",
};

const MODE_DESCRIPTION: Record<PromptCompositionMode, string> = {
  default: "使用当前工作流 Prompt Profile 的默认组件。",
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
}: {
  fragment: PromptFragmentSummaryDto;
  selected: boolean;
  disabled: boolean;
  toggle: () => void;
}) {
  return (
    <label className="lifeos-prompt-choice" data-selected={selected ? "true" : "false"}>
      <input type="checkbox" checked={selected} disabled={disabled} onChange={toggle} />
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
  );
}

function ScopeGroup({
  title,
  hint,
  fragments,
  selectedIds,
  disabled,
  toggleRevision,
}: {
  title: string;
  hint: string;
  fragments: readonly PromptFragmentSummaryDto[];
  selectedIds: ReadonlySet<string>;
  disabled: boolean;
  toggleRevision: PromptComposerInjected["toggleRevision"];
}) {
  return (
    <section className="lifeos-prompt-scope-group">
      <header>
        <strong>{title}</strong>
        <span>{hint}</span>
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
}: {
  region: PromptRegionDefinitionDto;
  state: PromptComposerState;
  locked: boolean;
  setMode: PromptComposerInjected["setMode"];
  toggleRevision: PromptComposerInjected["toggleRevision"];
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
          disabled={locked || mode === "default"}
          toggleRevision={toggleRevision}
        />
        <ScopeGroup
          title="当前 Workspace"
          hint={state.workspace?.title ?? "当前会话尚未映射"}
          fragments={workspace}
          selectedIds={selectedIds}
          disabled={locked || mode === "default" || state.workspace === null}
          toggleRevision={toggleRevision}
        />
      </div>
    </article>
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
  load,
  setMode,
  toggleRevision,
  reset,
  preview,
  clearPreview,
}: PromptComposerProps) {
  const state = usePromptComposer((value) => value);
  const [open, setOpen] = useState(false);
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
    clearPreview();
    setOpen(false);
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
                disabled={state.previewing || input.draft.trim() === ""}
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
              />
            ))}
          </div>
          <Preview state={state} />
        </section>
      </Modal>
    </>
  );
}
