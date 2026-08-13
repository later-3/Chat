import { useEffect, useMemo, useState } from "react";
import type {
  WorkflowBlueprintDto,
  WorkflowDefinitionPublishedDto,
  WorkflowResourceRefDto,
} from "@chat/contracts/public";
import {
  useWorkflowBlueprints,
  useWorkflowCatalog,
  useWorkflowDefinitions,
  useWorkflowResources,
  useWorkflowRunConfigSummary,
} from "../workflow/use-workflow-composer.js";
import type { WorkflowSelectionDraft } from "../workflow/run-config-draft.js";

type ResourceKind = "memory" | "project" | "rule" | "skill";
type Override = NonNullable<WorkflowSelectionDraft["runConfiguration"]>["overrides"][number];
type NoteCaptureInput = Extract<
  NonNullable<WorkflowSelectionDraft["businessInput"]>,
  { readonly kind: "note_capture" }
>;

export interface MessageTextSelection {
  readonly startUtf16: number;
  readonly endUtf16: number;
}

const RESOURCE_KIND_BY_NODE_TYPE: Readonly<Record<string, ResourceKind>> = {
  "context.memory": "memory",
  "context.project": "project",
  "policy.rules": "rule",
  "capability.skills": "skill",
};

const RESOURCE_LABEL: Readonly<Record<ResourceKind, string>> = {
  memory: "Memory",
  project: "项目",
  rule: "规则集",
  skill: "Skill",
};

function selectionFor(
  definition: WorkflowDefinitionPublishedDto,
  previous: WorkflowSelectionDraft | null,
): WorkflowSelectionDraft {
  if (
    previous?.workflowDefinitionRevisionId === definition.workflowDefinitionRevisionId &&
    previous.definitionSha256 === definition.definitionSha256
  ) {
    return previous;
  }
  return {
    kind: "published_revision",
    workflowDefinitionRevisionId: definition.workflowDefinitionRevisionId,
    definitionSha256: definition.definitionSha256,
    runConfiguration: { schemaVersion: "workflow-run-configuration.v1", overrides: [] },
    ...(definition.blueprintKey === "note"
      ? {
          businessInput: {
            kind: "note_capture" as const,
            source: { kind: "full_message" as const },
            defaultKind: "general" as const,
            suggestedTagLabels: [],
          },
        }
      : {}),
  };
}

function replaceOverride(
  selection: WorkflowSelectionDraft,
  next: Override,
): WorkflowSelectionDraft {
  const overrides = selection.runConfiguration?.overrides ?? [];
  const same = (candidate: Override) =>
    candidate.kind === next.kind && candidate.definitionNodeId === next.definitionNodeId;
  return {
    ...selection,
    runConfiguration: {
      schemaVersion: "workflow-run-configuration.v1",
      overrides: [...overrides.filter((candidate) => !same(candidate)), next],
    },
  };
}

function overrideFor(
  selection: WorkflowSelectionDraft,
  definitionNodeId: string,
  kind: Override["kind"],
): Override | undefined {
  return selection.runConfiguration?.overrides.find(
    (override) => override.definitionNodeId === definitionNodeId && override.kind === kind,
  );
}

function isOverrideAllowed(
  blueprint: WorkflowBlueprintDto | undefined,
  nodeType: string,
  field: "enabled" | "selection" | "reviewMode",
): boolean {
  return (
    blueprint?.perRunOverrides.some(
      (override) => override.nodeType === nodeType && override.fields.includes(field),
    ) ?? false
  );
}

/** 未来Catalog字段不能被当作通用JSON表单渲染。 */
export function isSupportedComposerField(field: unknown): boolean {
  if (
    typeof field !== "object" ||
    field === null ||
    typeof (field as { type?: unknown }).type !== "string"
  ) {
    return false;
  }
  return [
    "boolean",
    "enum_select",
    "review_mode",
    "bounded_integer",
    "short_text",
    "resource_selector",
    "rule_selector",
    "skill_selector",
    "note_source_selector",
    "tag_list",
  ].includes((field as { type: string }).type);
}

function replaceNoteCaptureInput(
  selection: WorkflowSelectionDraft,
  next: NoteCaptureInput,
): WorkflowSelectionDraft {
  return { ...selection, businessInput: next };
}

async function sha256Text(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function NoteCaptureInputPanel({
  selection,
  messageText,
  messageSelection,
  disabled,
  onChange,
  onValidityChange,
}: {
  readonly selection: WorkflowSelectionDraft;
  readonly messageText: string;
  readonly messageSelection: MessageTextSelection | null;
  readonly disabled: boolean;
  readonly onChange: (next: WorkflowSelectionDraft) => void;
  readonly onValidityChange: (valid: boolean) => void;
}) {
  const noteInput: NoteCaptureInput =
    selection.businessInput?.kind === "note_capture"
      ? selection.businessInput
      : {
          kind: "note_capture",
          source: { kind: "full_message" },
          defaultKind: "general",
          suggestedTagLabels: [],
        };
  const [tagDraft, setTagDraft] = useState(noteInput.suggestedTagLabels?.join("、") ?? "");
  const [rangePending, setRangePending] = useState(false);
  const [rangeError, setRangeError] = useState<string | null>(null);

  useEffect(() => {
    const source = noteInput.source;
    if (source?.kind !== "selection") {
      onValidityChange(true);
      return;
    }
    const boundsValid =
      source.startUtf16 >= 0 &&
      source.endUtf16 > source.startUtf16 &&
      source.endUtf16 <= messageText.length &&
      !splitsSurrogatePair(messageText, source.startUtf16) &&
      !splitsSurrogatePair(messageText, source.endUtf16);
    if (!boundsValid) {
      setRangeError("消息已变化，冻结选区不再有效；请在消息输入框重新选择文字。");
      onValidityChange(false);
      return;
    }
    let cancelled = false;
    onValidityChange(false);
    void sha256Text(messageText.slice(source.startUtf16, source.endUtf16)).then((sha256) => {
      if (cancelled) return;
      const valid = sha256 === source.selectedTextSha256;
      setRangeError(valid ? null : "消息已变化，冻结选区不再有效；请在消息输入框重新选择文字。");
      onValidityChange(valid);
    });
    return () => {
      cancelled = true;
    };
  }, [messageText, noteInput.source, onValidityChange]);

  const liveRangeValid =
    messageSelection !== null &&
    messageSelection.startUtf16 >= 0 &&
    messageSelection.endUtf16 > messageSelection.startUtf16 &&
    messageSelection.endUtf16 <= messageText.length &&
    !splitsSurrogatePair(messageText, messageSelection.startUtf16) &&
    !splitsSurrogatePair(messageText, messageSelection.endUtf16);

  async function freezeRange(range: MessageTextSelection | null) {
    if (range === null || !liveRangeValid) {
      setRangeError("请先在下方消息输入框中选择一段完整文字。");
      return;
    }
    setRangePending(true);
    setRangeError(null);
    try {
      const selectedTextSha256 = await sha256Text(
        messageText.slice(range.startUtf16, range.endUtf16),
      );
      onChange(
        replaceNoteCaptureInput(selection, {
          ...noteInput,
          source: {
            kind: "selection",
            startUtf16: range.startUtf16,
            endUtf16: range.endUtf16,
            selectedTextSha256: selectedTextSha256 as never,
          },
        }),
      );
    } finally {
      setRangePending(false);
    }
  }

  return (
    <fieldset className="workflow-note-capture-config" disabled={disabled}>
      <legend>Note Capture 输入</legend>
      <div className="workflow-note-source-modes" role="radiogroup" aria-label="笔记来源">
        <label className="workflow-composer-option">
          <input
            type="radio"
            name="note-source-mode"
            checked={noteInput.source?.kind !== "selection"}
            onChange={() => {
              setRangeError(null);
              onChange(
                replaceNoteCaptureInput(selection, {
                  ...noteInput,
                  source: { kind: "full_message" },
                }),
              );
            }}
          />
          <span>完整消息</span>
        </label>
        <label className="workflow-composer-option">
          <input
            type="radio"
            name="note-source-mode"
            checked={noteInput.source?.kind === "selection"}
            onChange={() => void freezeRange(messageSelection)}
          />
          <span>消息输入框当前选区</span>
        </label>
      </div>
      <div className="workflow-note-range">
        <button
          type="button"
          disabled={!liveRangeValid || rangePending}
          onClick={() => void freezeRange(messageSelection)}
        >
          {rangePending
            ? "正在冻结…"
            : noteInput.source?.kind === "selection"
              ? "更新为当前选区"
              : "使用当前选区"}
        </button>
        <small>
          {messageSelection !== null
            ? `消息输入框已选择 UTF-16 ${String(messageSelection.startUtf16)}–${String(messageSelection.endUtf16)}。`
            : noteInput.source?.kind === "selection"
              ? `已冻结 ${String(noteInput.source.startUtf16)}–${String(noteInput.source.endUtf16)}；修改消息后需重新选择。`
              : "如需局部捕获，请先在下方消息输入框选择文字。"}
        </small>
        {rangeError !== null && <p role="alert">{rangeError}</p>}
      </div>
      <label className="workflow-picker">
        <span>默认 Note 类型</span>
        <select
          aria-label="默认 Note 类型"
          value={noteInput.defaultKind ?? "general"}
          onChange={(event) =>
            onChange(
              replaceNoteCaptureInput(selection, {
                ...noteInput,
                defaultKind: event.target.value as NoteCaptureInput["defaultKind"],
              }),
            )
          }
        >
          <option value="general">general</option>
          <option value="idea">idea</option>
          <option value="project_idea">project_idea</option>
          <option value="learning">learning</option>
        </select>
      </label>
      <label className="workflow-picker">
        <span>建议标签</span>
        <input
          aria-label="Note 建议标签"
          value={tagDraft}
          placeholder="用逗号或顿号分隔"
          onChange={(event) => {
            const draft = event.target.value;
            setTagDraft(draft);
            onChange(
              replaceNoteCaptureInput(selection, {
                ...noteInput,
                suggestedTagLabels: draft
                  .split(/[,，、]/u)
                  .map((item) => item.trim())
                  .filter(Boolean)
                  .slice(0, 20)
                  .map((item) => item.slice(0, 64)),
              }),
            );
          }}
        />
        <small>这里只提交显示标签建议；canonical key仍由服务端统一生成。</small>
      </label>
    </fieldset>
  );
}

function ResourcePicker({
  nodeId,
  resourceKind,
  selection,
  resources,
  disabled,
  onChange,
}: {
  readonly nodeId: string;
  readonly resourceKind: ResourceKind;
  readonly selection: WorkflowSelectionDraft;
  readonly resources: readonly WorkflowResourceRefDto[];
  readonly disabled: boolean;
  readonly onChange: (next: WorkflowSelectionDraft) => void;
}) {
  const current = overrideFor(selection, nodeId, "resource_selection");
  const selected = new Set(
    current?.kind === "resource_selection" ? current.selections.map((item) => item.resourceId) : [],
  );
  const choices = resources.filter((resource) => resource.resourceKind === resourceKind);

  function toggle(resource: WorkflowResourceRefDto) {
    const before = current?.kind === "resource_selection" ? current.selections : [];
    const nextSelections = selected.has(resource.resourceId)
      ? before.filter((item) => item.resourceId !== resource.resourceId)
      : [
          ...before,
          {
            resourceId: resource.resourceId,
            expectedRevision: resource.revision,
            expectedSha256: resource.sha256,
          },
        ];
    onChange(
      replaceOverride(selection, {
        kind: "resource_selection",
        definitionNodeId: nodeId as never,
        resourceKind,
        required: current?.kind === "resource_selection" ? current.required : false,
        selections: nextSelections,
      }),
    );
  }

  return (
    <fieldset className="workflow-composer-resources" disabled={disabled}>
      <legend>{RESOURCE_LABEL[resourceKind]}</legend>
      {choices.length === 0 ? (
        <p>暂无可选资源。未选择内容不会进入本次规划。</p>
      ) : (
        choices.map((resource) => (
          <label key={resource.resourceId} className="workflow-composer-option">
            <input
              type="checkbox"
              checked={selected.has(resource.resourceId)}
              disabled={resource.status !== "active"}
              onChange={() => toggle(resource)}
            />
            <span>
              <strong>{resource.label}</strong>
              <small>
                {resource.source} · r{resource.revision}
                {resource.status !== "active" ? " · 已归档，不能选择" : ""}
              </small>
            </span>
          </label>
        ))
      )}
    </fieldset>
  );
}

function definitionVersion(definition: WorkflowDefinitionPublishedDto): string {
  return `v${definition.definitionRevision} · ${definition.blueprintKey} ${definition.blueprintVersion}`;
}

export function WorkflowPicker({
  value,
  disabled,
  onChange,
}: {
  readonly value: WorkflowSelectionDraft | null;
  readonly disabled: boolean;
  readonly onChange: (next: WorkflowSelectionDraft) => void;
}) {
  const definitions = useWorkflowDefinitions();
  const selected = definitions.data?.definitions.find(
    (definition) => definition.workflowDefinitionRevisionId === value?.workflowDefinitionRevisionId,
  );
  const defaultDefinition = definitions.data?.definitions.find(
    (definition) => definition.ownerKind === "system" && definition.blueprintKey === "planning",
  );

  useEffect(() => {
    if (value === null && defaultDefinition !== undefined)
      onChange(selectionFor(defaultDefinition, null));
  }, [defaultDefinition, onChange, value]);

  if (definitions.isPending) return <p className="workflow-composer-note">正在读取可用工作流…</p>;
  if (definitions.isError || definitions.data === undefined) {
    return (
      <p className="workflow-composer-note">工作流配置暂不可用；你仍可使用兼容的默认规划发送。</p>
    );
  }

  return (
    <label className="workflow-picker">
      <span>工作流</span>
      <select
        aria-label="选择规划工作流"
        value={selected?.workflowDefinitionRevisionId ?? ""}
        disabled={disabled}
        onChange={(event) => {
          const next = definitions.data?.definitions.find(
            (definition) => definition.workflowDefinitionRevisionId === event.target.value,
          );
          if (next !== undefined) onChange(selectionFor(next, value));
        }}
      >
        <option value="" disabled>
          选择已发布工作流
        </option>
        {definitions.data.definitions.map((definition) => (
          <option
            key={definition.workflowDefinitionRevisionId}
            value={definition.workflowDefinitionRevisionId}
          >
            {definition.title}
          </option>
        ))}
      </select>
      {selected !== undefined && (
        <small>
          {selected.description}
          {selected.blueprintKey === "note"
            ? " · Note Capture 会先形成候选；人工确认或允许的策略确认后才成为正式笔记。"
            : ""}
        </small>
      )}
    </label>
  );
}

export function RunConfigPanel({
  selection,
  messageText = "",
  messageSelection = null,
  disabled,
  stale,
  onChange,
  onBlockedChange,
}: {
  readonly selection: WorkflowSelectionDraft | null;
  readonly messageText?: string;
  readonly messageSelection?: MessageTextSelection | null;
  readonly disabled: boolean;
  readonly stale: boolean;
  readonly onChange: (next: WorkflowSelectionDraft) => void;
  readonly onBlockedChange: (blocked: boolean) => void;
}) {
  const definitions = useWorkflowDefinitions();
  const catalog = useWorkflowCatalog();
  const blueprints = useWorkflowBlueprints();
  const resources = useWorkflowResources();
  const [noteSourceValid, setNoteSourceValid] = useState(true);
  const definition = definitions.data?.definitions.find(
    (item) => item.workflowDefinitionRevisionId === selection?.workflowDefinitionRevisionId,
  );
  const selected = selection === null || definition === undefined ? null : selection;
  const unknownField = useMemo(
    () =>
      definition?.nodes.some((node) =>
        node.publicConfigFields.some((field) => !isSupportedComposerField(field)),
      ) ?? false,
    [definition],
  );
  const catalogByType = useMemo(
    () => new Map((catalog.data?.nodes ?? []).map((node) => [node.nodeType, node])),
    [catalog.data],
  );
  const blueprint = blueprints.data?.blueprints.find(
    (item) =>
      item.blueprintKey === definition?.blueprintKey &&
      item.blueprintVersion === definition.blueprintVersion,
  );
  const configBlocked =
    selection !== null &&
    (definition === undefined ||
      stale ||
      unknownField ||
      catalog.isPending ||
      blueprints.isPending ||
      resources.isPending ||
      catalog.isError ||
      blueprints.isError ||
      resources.isError ||
      (definition?.blueprintKey === "note" && !noteSourceValid));

  useEffect(() => {
    onBlockedChange(configBlocked);
  }, [configBlocked, onBlockedChange]);

  if (selected === null || definition === undefined) return null;
  const lockedNodes = definition.nodes.filter((node) => {
    const risk = catalogByType.get(node.nodeType)?.riskPolicy;
    return risk === "human_decision" || risk === "external_effect" || risk === "product_commit";
  });
  const panelDisabled = disabled || configBlocked;

  return (
    <section className="run-config-panel" aria-label="本次运行配置">
      <div className="run-config-heading">
        <div>
          <h3>本次运行配置</h3>
          <p>
            {definitionVersion(definition)} · {definition.nodes.length} 个节点
          </p>
        </div>
        {stale && (
          <span className="workflow-composer-stale" role="status">
            版本已变化，请重新选择后发送
          </span>
        )}
      </div>
      {unknownField && (
        <p className="workflow-composer-error" role="alert">
          此工作流含当前版本不支持的配置字段，已禁止发送；请升级页面或改用其他工作流。
        </p>
      )}
      {(catalog.isPending || blueprints.isPending || resources.isPending) && (
        <p className="workflow-composer-note">
          正在读取允许的配置与资源；加载完成前不能发送配置草稿。
        </p>
      )}
      {(catalog.isError || blueprints.isError || resources.isError) && (
        <p className="workflow-composer-error" role="alert">
          配置资料读取失败，已禁止用草稿发送，避免提交过期或不完整选择。
        </p>
      )}
      {definition.blueprintKey === "note" && (
        <NoteCaptureInputPanel
          key={definition.workflowDefinitionRevisionId}
          selection={selected}
          messageText={messageText}
          messageSelection={messageSelection}
          disabled={panelDisabled}
          onChange={onChange}
          onValidityChange={setNoteSourceValid}
        />
      )}
      {definition.nodes.map((node) => {
        const enabled = overrideFor(selected, node.definitionNodeId, "node_enabled");
        const review = overrideFor(selected, node.definitionNodeId, "review_mode");
        const resourceKind = RESOURCE_KIND_BY_NODE_TYPE[node.nodeType];
        const reviewField = node.publicConfigFields.find(
          (field) => field.type === "review_mode",
        ) as
          | {
              readonly type: "review_mode";
              readonly label: string;
              readonly defaultValue: string;
              readonly options: readonly string[];
            }
          | undefined;
        const risk = catalogByType.get(node.nodeType)?.riskPolicy;
        const canToggle = node.optional && isOverrideAllowed(blueprint, node.nodeType, "enabled");
        const enabledValue =
          enabled?.kind === "node_enabled" ? enabled.enabled : node.defaultActivation === "enabled";
        return (
          <article key={node.definitionNodeId} className="workflow-config-node">
            <header>
              <div>
                <strong>{node.displayName}</strong>
                <small>{node.nodeType}</small>
              </div>
              {risk !== undefined && <span>{risk === "read_context" ? "读取上下文" : risk}</span>}
            </header>
            {canToggle && (
              <label className="workflow-composer-option">
                <input
                  type="checkbox"
                  checked={enabledValue}
                  disabled={panelDisabled}
                  onChange={(event) =>
                    onChange(
                      replaceOverride(selected, {
                        kind: "node_enabled",
                        definitionNodeId: node.definitionNodeId,
                        enabled: event.target.checked,
                      }),
                    )
                  }
                />
                <span>启用此可选步骤</span>
              </label>
            )}
            {resourceKind !== undefined &&
              isOverrideAllowed(blueprint, node.nodeType, "selection") && (
                <ResourcePicker
                  nodeId={node.definitionNodeId}
                  resourceKind={resourceKind}
                  selection={selected}
                  resources={resources.data?.resources ?? []}
                  disabled={panelDisabled || (canToggle && !enabledValue)}
                  onChange={onChange}
                />
              )}
            {reviewField !== undefined &&
              isOverrideAllowed(blueprint, node.nodeType, "reviewMode") && (
                <label className="workflow-picker">
                  <span>{reviewField.label}</span>
                  <select
                    aria-label={reviewField.label}
                    value={
                      review?.kind === "review_mode" ? review.reviewMode : reviewField.defaultValue
                    }
                    disabled={panelDisabled}
                    onChange={(event) =>
                      onChange(
                        replaceOverride(selected, {
                          kind: "review_mode",
                          definitionNodeId: node.definitionNodeId,
                          reviewMode: event.target.value as never,
                        }),
                      )
                    }
                  >
                    {reviewField.options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                  <small>高影响执行前，服务端仍会按实际计划和策略要求版本绑定的人为确认。</small>
                </label>
              )}
            {node.publicConfigFields
              .filter(
                (field) =>
                  field.type !== "review_mode" &&
                  ![
                    "resource_selector",
                    "rule_selector",
                    "skill_selector",
                    "note_source_selector",
                    "tag_list",
                    "enum_select",
                  ].includes(field.type),
              )
              .map((field) => (
                <p key={field.name} className="workflow-composer-note">
                  {field.label}：使用已发布工作流默认值（此版本不允许本次覆盖）。
                </p>
              ))}
          </article>
        );
      })}
      {lockedNodes.length > 0 && (
        <p className="workflow-composer-risk">
          {lockedNodes.map((node) => node.displayName).join("、")}
          不可跳过：它们涉及人工决定、外部影响或正式提交，必须由后端策略与版本绑定决定保护。
        </p>
      )}
      {blueprint !== undefined && (
        <p className="workflow-composer-note">
          审核策略由 {blueprint.title} 的已发布版本限定；浏览器只能提出有限选择。
          {definition.blueprintKey === "note"
            ? " 来源范围和建议标签随本次命令提交；来源Hash与canonical Tag仍由服务端复核和冻结。"
            : ""}
        </p>
      )}
    </section>
  );
}

export function WorkflowRunSummary({ productRunId }: { readonly productRunId: string }) {
  const summary = useWorkflowRunConfigSummary(productRunId);
  if (summary.isPending) return <p className="workflow-composer-note">正在读取本次运行配置摘要…</p>;
  if (summary.isError || summary.data === undefined) return null;
  return (
    <section className="workflow-run-summary" aria-label="已提交运行配置">
      <h3>已提交的运行配置</h3>
      <p>
        {summary.data.definition?.title ?? "兼容规划路径"} · {summary.data.nodeCount} 个节点
      </p>
      <ul>
        {summary.data.resourceSummary.map((resource, index) => (
          <li key={`${resource.definitionNodeId}:${resource.resourceKind}:${index}`}>
            {RESOURCE_LABEL[resource.resourceKind]}：
            {resource.resolution === "included"
              ? "已纳入"
              : `未纳入${resource.reason === undefined ? "" : `（${resource.reason}）`}`}
          </li>
        ))}
        {summary.data.reviewSummary.map((review) => (
          <li key={review.definitionNodeId}>
            审核：{review.mode}（{review.actor === "user" ? "用户选择" : "系统策略"}）
          </li>
        ))}
      </ul>
    </section>
  );
}
