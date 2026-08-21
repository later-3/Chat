import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import {
  IconChevronDownOutline14,
  Menu,
  Modal,
  type MenuEntry,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { HostObservable, InjectFace, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import {
  agentKeySchema,
  agentProfileDtoSchema,
  agentProfilesDtoSchema,
  type AgentProfileDto,
} from "@chat/contracts/public";
import type { LifeosWorkflowOption, WorkflowSelection } from "../contracts.ts";
import { saveWorkflowAgentNodeConfigurationResponseSchema } from "../contracts.ts";
import type { LifeosClientState } from "./controller.ts";
import { browserCommandId, requestSameOriginJson } from "./same-origin-json.ts";

export interface WorkflowPickerInjected {
  hooks: { lifeos: HostObservable<LifeosClientState> };
  loadWorkflows: () => Promise<readonly LifeosWorkflowOption[] | null>;
  selectWorkflow: (selection: WorkflowSelection | null) => Promise<boolean>;
}

export type WorkflowPickerProps = Pick<PropsRuntime<"conversation.input.dock">, "input"> &
  InjectFace<WorkflowPickerInjected>;

const WORKFLOW_ID_PREFIX = "lifeos-workflow:";
const EMPTY_RUN_CONFIGURATION = {
  schemaVersion: "workflow-run-configuration.v1" as const,
  overrides: [],
};

const BLUEPRINT_LABEL: Record<LifeosWorkflowOption["blueprintKey"], string> = {
  planning: "规划",
  note: "笔记",
  direct: "执行 Agent",
};
const AGENT_LABEL: Record<LifeosWorkflowOption["agentNodes"][number]["agentKey"], string> = {
  planner: "规划 Agent",
  direct: "Pi Coding Agent · 直接执行",
  project_bootstrap: "项目初始化 Agent",
  coding_executor: "Pi Coding Agent · 规划步骤执行",
  note_extractor: "笔记提取 Agent",
};

/**
 * 发送前的Workflow选择表面。选择只是会话草稿：真正绑定发生在
 * 用户下一次发送消息时，由Chat命令边界重新校验published/active/Hash。
 */
export function WorkflowPicker({
  input,
  useLifeos,
  loadWorkflows,
  selectWorkflow,
}: WorkflowPickerProps) {
  const state = useLifeos((value) => value);
  const [open, setOpen] = useState(false);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [draftConfiguration, setDraftConfiguration] = useState(selectionConfiguration(null));
  const [agentProfiles, setAgentProfiles] = useState<readonly AgentProfileDto[] | null>(null);
  const [agentConfigurationStatus, setAgentConfigurationStatus] = useState<
    "ready" | "loading" | "saving"
  >("ready");
  const [agentConfigurationError, setAgentConfigurationError] = useState<string | null>(null);
  const projection = state.projection;
  const selection = projection?.workflowSelection ?? null;
  const workflows = state.workflows;
  const locked = input.phase !== "plain" || state.selectingWorkflow;

  useEffect(() => {
    if ((open || projection?.workflowSelection !== null) && workflows === null) {
      void loadWorkflows();
    }
  }, [open, projection?.workflowSelection, workflows, loadWorkflows]);

  useEffect(() => {
    if (configurationOpen) setDraftConfiguration(selectionConfiguration(selection));
  }, [configurationOpen, selection]);

  useEffect(() => {
    if (!configurationOpen || agentProfiles !== null) return;
    setAgentConfigurationStatus("loading");
    void requestSameOriginJson("/lifeos/agents", agentProfilesDtoSchema)
      .then((result) => {
        setAgentProfiles(result.items);
        setAgentConfigurationError(null);
        setAgentConfigurationStatus("ready");
      })
      .catch((cause: unknown) => {
        setAgentConfigurationError(cause instanceof Error ? cause.message : "Agent读取失败");
        setAgentConfigurationStatus("ready");
      });
  }, [configurationOpen, agentProfiles]);

  const items = useMemo<readonly MenuEntry[]>(() => {
    if (workflows === null) {
      return [
        {
          id: "lifeos-workflow-loading",
          label: state.workflowError ?? "正在读取可用工作流…",
          disabled: true,
        },
        ...(state.workflowError === null
          ? []
          : [{ id: "lifeos-workflow-retry", label: "重新加载" } satisfies MenuEntry]),
      ];
    }
    return workflows.map((option) => ({
      id: `${WORKFLOW_ID_PREFIX}${option.workflowDefinitionRevisionId}`,
      label: (
        <span className="lifeos-workflow-option-copy" title={option.description}>
          <span>{option.title}</span>
          <small>
            {BLUEPRINT_LABEL[option.blueprintKey]}
            {option.ownerKind === "system" ? " · 系统" : " · 自建"}
          </small>
        </span>
      ),
      disabled: state.selectingWorkflow,
    }));
  }, [state.selectingWorkflow, state.workflowError, workflows]);

  const choose = async (option: LifeosWorkflowOption): Promise<void> => {
    if (state.selectingWorkflow) return;
    if (
      selection !== null &&
      selection.workflowDefinitionRevisionId === option.workflowDefinitionRevisionId
    ) {
      setOpen(false);
      return;
    }
    if (
      await selectWorkflow({
        workflowDefinitionRevisionId: option.workflowDefinitionRevisionId,
        definitionSha256: option.definitionSha256,
        title: option.title,
        blueprintKey: option.blueprintKey,
        runConfiguration: EMPTY_RUN_CONFIGURATION,
      })
    ) {
      setOpen(false);
    }
  };

  const chooseId = (id: string): void => {
    if (id === "lifeos-workflow-retry") {
      void loadWorkflows();
      return;
    }
    const revisionId = id.startsWith(WORKFLOW_ID_PREFIX) ? id.slice(WORKFLOW_ID_PREFIX.length) : "";
    const option = workflows?.find(
      (candidate) => candidate.workflowDefinitionRevisionId === revisionId,
    );
    if (option !== undefined) void choose(option);
  };

  const defaultPlanning = workflows?.find((option) => option.isDefault);
  const defaultTitle = defaultPlanning?.title ?? "规划执行工作流";
  const visualLabel =
    selection === null
      ? defaultTitle
      : (workflows?.find(
          (option) =>
            option.workflowDefinitionRevisionId === selection.workflowDefinitionRevisionId,
        )?.title ?? selection.title);
  const selectedId = `${WORKFLOW_ID_PREFIX}${
    selection?.workflowDefinitionRevisionId ?? defaultPlanning?.workflowDefinitionRevisionId ?? ""
  }`;
  const selectedOption =
    workflows?.find(
      (option) =>
        option.workflowDefinitionRevisionId ===
        (selection?.workflowDefinitionRevisionId ?? defaultPlanning?.workflowDefinitionRevisionId),
    ) ?? null;
  const configurable =
    selectedOption !== null &&
    (selectedOption.configurableNodes.length > 0 || selectedOption.agentNodes.length > 0);
  const configuredCount = draftConfiguration.overrides.filter(
    (override) => override.kind === "node_config",
  ).length;
  const appliedOverrideCount = selection?.runConfiguration.overrides.length ?? 0;

  const applyConfiguration = async (): Promise<void> => {
    if (selectedOption === null) return;
    const next: WorkflowSelection = {
      workflowDefinitionRevisionId: selectedOption.workflowDefinitionRevisionId,
      definitionSha256: selectedOption.definitionSha256,
      title: selectedOption.title,
      blueprintKey: selectedOption.blueprintKey,
      runConfiguration: draftConfiguration,
    };
    if (await selectWorkflow(next)) setConfigurationOpen(false);
  };

  const saveAgentNode = async (
    node: LifeosWorkflowOption["agentNodes"][number],
    agentKey: LifeosWorkflowOption["agentNodes"][number]["agentKey"],
    promptOverrideMarkdown: string,
  ): Promise<void> => {
    if (selectedOption === null) return;
    setAgentConfigurationStatus("saving");
    setAgentConfigurationError(null);
    try {
      const result = await requestSameOriginJson(
        "/lifeos/workflow/agent-node-configurations",
        saveWorkflowAgentNodeConfigurationResponseSchema,
        {
          method: "POST",
          body: JSON.stringify({
            commandId: browserCommandId(),
            payload: {
              sourceWorkflowDefinitionRevisionId: selectedOption.workflowDefinitionRevisionId,
              sourceDefinitionSha256: selectedOption.definitionSha256,
              definitionNodeId: node.definitionNodeId,
              agentKey,
              ...(promptOverrideMarkdown.trim() === "" ? {} : { promptOverrideMarkdown }),
            },
          }),
        },
      );
      await loadWorkflows();
      const saved = result.workflow;
      if (
        await selectWorkflow({
          workflowDefinitionRevisionId: saved.workflowDefinitionRevisionId,
          definitionSha256: saved.definitionSha256,
          title: saved.title,
          blueprintKey: saved.blueprintKey,
          runConfiguration: EMPTY_RUN_CONFIGURATION,
        })
      ) {
        setConfigurationOpen(false);
      }
    } catch (cause) {
      setAgentConfigurationError(
        cause instanceof Error ? cause.message : "Workflow Agent配置保存失败",
      );
    } finally {
      setAgentConfigurationStatus("ready");
    }
  };

  const promoteAgentDefault = async (
    profile: AgentProfileDto,
    bodyMarkdown: string,
  ): Promise<boolean> => {
    setAgentConfigurationStatus("saving");
    setAgentConfigurationError(null);
    try {
      const revised = await requestSameOriginJson(
        `/lifeos/agents/${encodeURIComponent(profile.agentKey)}/prompt-revisions`,
        agentProfileDtoSchema,
        {
          method: "POST",
          body: JSON.stringify({
            commandId: browserCommandId(),
            payload: {
              expectedAggregateRevision: profile.systemPrompt.aggregateRevision,
              ...(profile.systemPrompt.source === "principal_override"
                ? {
                    currentRevisionId: profile.systemPrompt.promptFragmentRevisionId,
                    currentRevisionSha256: profile.systemPrompt.sha256,
                  }
                : {}),
              bodyMarkdown,
            },
          }),
        },
      );
      setAgentProfiles(
        (current) =>
          current?.map((item) => (item.agentKey === revised.agentKey ? revised : item)) ?? [
            revised,
          ],
      );
      return true;
    } catch (cause) {
      setAgentConfigurationError(
        cause instanceof Error ? cause.message : "Agent默认Prompt保存失败",
      );
      return false;
    } finally {
      setAgentConfigurationStatus("ready");
    }
  };

  return (
    <span className="lifeos-workflow" data-testid="lifeos-workflow-picker">
      <Menu
        open={open}
        side="top"
        align="start"
        portal
        dense
        compact
        items={items}
        selectedId={selectedId}
        onSelect={chooseId}
        onClose={() => setOpen(false)}
        anchor={
          <button
            type="button"
            className="lifeos-workflow-toggle"
            data-testid="lifeos-workflow-current"
            aria-label={`选择工作流，当前：${selection?.title ?? defaultTitle}`}
            aria-haspopup="menu"
            aria-expanded={open}
            title={selection?.title ?? defaultTitle}
            disabled={locked}
            onClick={() => setOpen((value) => !value)}
          >
            <span className="lifeos-workflow-label">{visualLabel}</span>
            <IconChevronDownOutline14
              className="lifeos-workflow-chevron"
              data-open={open ? "true" : "false"}
            />
          </button>
        }
      />
      {configurable ? (
        <button
          type="button"
          className="lifeos-workflow-config-toggle"
          data-testid="lifeos-workflow-config-open"
          disabled={locked}
          aria-label={`配置工作流：${visualLabel}`}
          title={`配置${visualLabel}`}
          onClick={() => setConfigurationOpen(true)}
        >
          <span>配置</span>
          {appliedOverrideCount === 0 ? null : <small>{appliedOverrideCount}</small>}
        </button>
      ) : null}
      <Modal
        open={configurationOpen}
        onClose={() => setConfigurationOpen(false)}
        title={`配置 · ${selectedOption?.title ?? visualLabel}`}
        closeLabel="关闭工作流配置"
        description="Agent默认值属于Chat；这里可为当前Workflow节点保存差异，也可只临时应用到本次会话。工具权限始终由Runtime锁定。"
        className="lifeos-workflow-config-modal"
        contentClassName="lifeos-workflow-config-content"
        footer={
          <div className="lifeos-workflow-config-footer">
            <span>
              {configuredCount === 0 ? "使用工作流默认值" : `已修改 ${configuredCount} 项`}
            </span>
            <div>
              <button
                type="button"
                disabled={state.selectingWorkflow}
                onClick={() => setDraftConfiguration(selectionConfiguration(null))}
              >
                恢复默认
              </button>
              <button
                type="button"
                className="lifeos-primary"
                disabled={state.selectingWorkflow}
                onClick={() => void applyConfiguration()}
              >
                {state.selectingWorkflow ? "正在应用…" : "应用到当前会话"}
              </button>
            </div>
          </div>
        }
      >
        <section className="lifeos-workflow-config" data-testid="lifeos-workflow-config">
          {agentConfigurationError === null ? null : (
            <p className="lifeos-error" role="alert">
              {agentConfigurationError}
            </p>
          )}
          {selectedOption?.agentNodes.map((node) => (
            <AgentNodeConfiguration
              key={`agent:${node.definitionNodeId}`}
              node={node}
              fields={
                selectedOption.configurableNodes.find(
                  (candidate) => candidate.definitionNodeId === node.definitionNodeId,
                )?.fields ?? []
              }
              configuration={draftConfiguration}
              setConfiguration={setDraftConfiguration}
              profiles={agentProfiles}
              busy={agentConfigurationStatus !== "ready"}
              onSave={saveAgentNode}
              onPromoteDefault={promoteAgentDefault}
            />
          ))}
          {selectedOption?.configurableNodes.map((node) => {
            const fields = node.fields.filter(
              (field) => !["agentKey", "agentPromptOverride"].includes(field.name),
            );
            return fields.length === 0 ? null : (
              <article className="lifeos-workflow-config-node" key={node.definitionNodeId}>
                <header>
                  <strong>{node.title} · 运行参数</strong>
                </header>
                {fields.map((field) => (
                  <WorkflowConfigField
                    key={field.name}
                    nodeId={node.definitionNodeId}
                    field={field}
                    configuration={draftConfiguration}
                    setConfiguration={setDraftConfiguration}
                  />
                ))}
              </article>
            );
          })}
        </section>
      </Modal>
      {state.workflowError !== null && !open ? (
        <span className="lifeos-sr-only" role="alert" data-testid="lifeos-workflow-error">
          {state.workflowError}
        </span>
      ) : null}
    </span>
  );
}

type RunConfiguration = WorkflowSelection["runConfiguration"];
type RunOverride = RunConfiguration["overrides"][number];
type NodeConfigOverride = Extract<RunOverride, { kind: "node_config" }>;
type ConfigField = LifeosWorkflowOption["configurableNodes"][number]["fields"][number];

function selectionConfiguration(selection: WorkflowSelection | null): RunConfiguration {
  return selection === null
    ? { schemaVersion: "workflow-run-configuration.v1", overrides: [] }
    : structuredClone(selection.runConfiguration);
}

function fieldValue(
  configuration: RunConfiguration,
  nodeId: string,
  field: ConfigField,
): boolean | string | number | undefined {
  const override = configuration.overrides.find(
    (candidate): candidate is NodeConfigOverride =>
      candidate.kind === "node_config" &&
      candidate.definitionNodeId === nodeId &&
      candidate.field === field.name,
  );
  if (override !== undefined) return override.value;
  return "defaultValue" in field ? field.defaultValue : undefined;
}

function withFieldValue(
  configuration: RunConfiguration,
  nodeId: string,
  field: ConfigField,
  value: boolean | string | number,
): RunConfiguration {
  const overrides = configuration.overrides.filter(
    (candidate) =>
      !(
        candidate.kind === "node_config" &&
        candidate.definitionNodeId === nodeId &&
        candidate.field === field.name
      ),
  );
  if (!("defaultValue" in field) || value !== field.defaultValue) {
    overrides.push({ kind: "node_config", definitionNodeId: nodeId, field: field.name, value });
  }
  return { schemaVersion: "workflow-run-configuration.v1", overrides };
}

function AgentNodeConfiguration({
  node,
  fields,
  configuration,
  setConfiguration,
  profiles,
  busy,
  onSave,
  onPromoteDefault,
}: {
  node: LifeosWorkflowOption["agentNodes"][number];
  fields: readonly ConfigField[];
  configuration: RunConfiguration;
  setConfiguration: Dispatch<SetStateAction<RunConfiguration>>;
  profiles: readonly AgentProfileDto[] | null;
  busy: boolean;
  onSave: (
    node: LifeosWorkflowOption["agentNodes"][number],
    agentKey: LifeosWorkflowOption["agentNodes"][number]["agentKey"],
    promptOverrideMarkdown: string,
  ) => Promise<void>;
  onPromoteDefault: (profile: AgentProfileDto, bodyMarkdown: string) => Promise<boolean>;
}) {
  const agentKeyField = fields.find(
    (field) => field.name === "agentKey" && field.type === "enum_select",
  ) as Extract<ConfigField, { options: readonly string[] }> | undefined;
  const promptField = fields.find(
    (field): field is Extract<ConfigField, { type: "long_text" }> =>
      field.name === "agentPromptOverride" && field.type === "long_text",
  );
  const parsedAgentKey = agentKeySchema.safeParse(
    agentKeyField === undefined
      ? node.agentKey
      : fieldValue(configuration, node.definitionNodeId, agentKeyField),
  );
  const agentKey = parsedAgentKey.success ? parsedAgentKey.data : node.agentKey;
  const profile = profiles?.find((candidate) => candidate.agentKey === agentKey) ?? null;
  const inheritedPrompt =
    profile?.systemPrompt.source === "runtime_default"
      ? ""
      : (profile?.systemPrompt.bodyMarkdown ?? "");
  const promptOverride =
    promptField === undefined
      ? (node.promptOverrideMarkdown ?? "")
      : String(fieldValue(configuration, node.definitionNodeId, promptField) ?? "");
  const effectivePrompt = promptOverride.trim() === "" ? inheritedPrompt : promptOverride;
  const hasRunOverride = configuration.overrides.some(
    (override) =>
      override.kind === "node_config" &&
      override.definitionNodeId === node.definitionNodeId &&
      ["agentKey", "agentPromptOverride"].includes(override.field),
  );
  const hasPromptRunOverride = configuration.overrides.some(
    (override) =>
      override.kind === "node_config" &&
      override.definitionNodeId === node.definitionNodeId &&
      override.field === "agentPromptOverride",
  );
  const sourceLabel = hasRunOverride
    ? hasPromptRunOverride && promptOverride.trim() === ""
      ? "本次会话：继承 Agent 默认"
      : "本次会话临时修改"
    : node.promptSource === "workflow_override"
      ? "工作流已修改"
      : "继承 Agent 默认";
  const setField = (field: ConfigField, value: string) =>
    setConfiguration((current) => withFieldValue(current, node.definitionNodeId, field, value));
  const persistentPrompt =
    profile !== null && effectivePrompt === inheritedPrompt ? "" : promptOverride;
  const persistentDirty =
    agentKey !== node.agentKey || persistentPrompt !== (node.promptOverrideMarkdown ?? "");

  return (
    <article
      className="lifeos-workflow-config-node lifeos-workflow-agent-binding"
      data-testid={`lifeos-workflow-agent-${node.definitionNodeId}`}
    >
      <header>
        <div>
          <small>Workflow Agent 节点</small>
          <strong>{node.title}</strong>
        </div>
        <span data-source={sourceLabel}>{sourceLabel}</span>
      </header>
      <div className="lifeos-workflow-agent-lineage">
        <span>Agent 默认模板</span>
        <i aria-hidden="true">→</i>
        <span>Workflow 节点实例</span>
        <i aria-hidden="true">→</i>
        <span>本次会话</span>
      </div>
      {agentKeyField === undefined ? (
        <dl>
          <div>
            <dt>Agent</dt>
            <dd>{AGENT_LABEL[agentKey]}</dd>
          </div>
        </dl>
      ) : (
        <label className="lifeos-workflow-agent-field">
          Agent 模板
          <select
            aria-label={`${node.title} Agent模板`}
            value={agentKey}
            disabled={busy}
            onChange={(event) => setField(agentKeyField, event.currentTarget.value)}
          >
            {agentKeyField.options.map((option) => {
              const parsed = agentKeySchema.safeParse(option);
              return parsed.success ? (
                <option key={option} value={option}>
                  {AGENT_LABEL[parsed.data]}
                </option>
              ) : null;
            })}
          </select>
        </label>
      )}
      {promptField === undefined ? null : (
        <label className="lifeos-workflow-agent-field lifeos-workflow-agent-prompt">
          节点自定义 System Prompt
          <small>
            留空表示继承 Agent 默认；Pi-backed
            Agent填写后会完整覆盖Pi默认，而不是追加。可只应用到本次会话，也可保存到Workflow。
          </small>
          <textarea
            aria-label={`${node.title} System Prompt`}
            value={effectivePrompt}
            maxLength={promptField.maximumLength}
            disabled={busy || profile === null}
            placeholder={
              profiles === null
                ? "正在读取 Agent 默认Prompt…"
                : profile?.systemPrompt.source === "runtime_default"
                  ? "当前继承 Pi 默认 System Prompt；需要替换时输入完整正文。"
                  : "输入节点Prompt"
            }
            onChange={(event) => setField(promptField, event.currentTarget.value)}
          />
        </label>
      )}
      <dl>
        <div>
          <dt>Profile</dt>
          <dd>
            <code>{node.profileVersion}</code>
          </dd>
        </div>
        <div>
          <dt>工具权限</dt>
          <dd>
            {node.toolPolicy.defaultTools.length === 0
              ? node.toolPolicy.summary
              : node.toolPolicy.defaultTools.join(" / ")}
          </dd>
        </div>
      </dl>
      <div className="lifeos-workflow-agent-actions">
        {promptField === undefined ? null : (
          <>
            <button
              type="button"
              disabled={busy || promptOverride === ""}
              onClick={() => setField(promptField, "")}
            >
              本次继承 Agent 默认
            </button>
            <button
              type="button"
              disabled={busy || !hasRunOverride}
              onClick={() => setField(promptField, promptField.defaultValue)}
            >
              恢复 Workflow 值
            </button>
          </>
        )}
        <button
          type="button"
          disabled={
            busy ||
            profile === null ||
            effectivePrompt.trim() === "" ||
            effectivePrompt === inheritedPrompt
          }
          onClick={() => {
            if (profile === null) return;
            void onPromoteDefault(profile, effectivePrompt).then((saved) => {
              if (saved && promptField !== undefined) setField(promptField, "");
            });
          }}
        >
          设为我的 Agent 默认（影响继承节点）
        </button>
        <button
          type="button"
          className="lifeos-primary"
          disabled={busy || profile === null || !persistentDirty}
          onClick={() => void onSave(node, agentKey, persistentPrompt)}
        >
          {busy ? "正在保存…" : "保存到 Workflow"}
        </button>
      </div>
    </article>
  );
}

function WorkflowConfigField({
  nodeId,
  field,
  configuration,
  setConfiguration,
}: {
  nodeId: string;
  field: ConfigField;
  configuration: RunConfiguration;
  setConfiguration: Dispatch<SetStateAction<RunConfiguration>>;
}) {
  const value = fieldValue(configuration, nodeId, field);
  const setValue = (next: boolean | string | number): void =>
    setConfiguration((current) => withFieldValue(current, nodeId, field, next));

  if (
    (field.type === "enum_select" || field.type === "review_mode") &&
    field.name === "promptReviewMode" &&
    field.options.includes("manual") &&
    field.options.includes("off")
  ) {
    const enabled = value !== "off";
    return (
      <div className="lifeos-workflow-config-field">
        <span>
          <strong>{field.label}</strong>
          <small>开启后，每次向模型发送完整请求前都会暂停等待确认。</small>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`${field.label}，当前${enabled ? "开启" : "关闭"}`}
          data-enabled={enabled ? "true" : "false"}
          className="lifeos-workflow-config-switch"
          onClick={() => setValue(enabled ? "off" : "manual")}
        >
          <span aria-hidden="true" />
          <em>{enabled ? "开启" : "关闭"}</em>
        </button>
      </div>
    );
  }
  if (field.type === "boolean") {
    return (
      <label className="lifeos-workflow-config-field">
        <span>
          <strong>{field.label}</strong>
        </span>
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => setValue(event.target.checked)}
        />
      </label>
    );
  }
  if (field.type === "enum_select" || field.type === "review_mode") {
    return (
      <label className="lifeos-workflow-config-field">
        <span>
          <strong>{field.label}</strong>
        </span>
        <select value={String(value)} onChange={(event) => setValue(event.target.value)}>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (field.type === "bounded_integer") {
    return (
      <label className="lifeos-workflow-config-field">
        <span>
          <strong>{field.label}</strong>
        </span>
        <input
          type="number"
          min={field.minimum}
          max={field.maximum}
          value={Number(value)}
          onChange={(event) => setValue(event.target.valueAsNumber)}
        />
      </label>
    );
  }
  if (field.type === "short_text" || field.type === "long_text") {
    return (
      <label className="lifeos-workflow-config-field">
        <span>
          <strong>{field.label}</strong>
        </span>
        {field.type === "long_text" ? (
          <textarea
            maxLength={field.maximumLength}
            value={String(value ?? "")}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
        ) : (
          <input
            type="text"
            maxLength={field.maximumLength}
            value={String(value ?? "")}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
        )}
      </label>
    );
  }
  return <p className="lifeos-warning">“{field.label}”暂不支持在当前界面配置。</p>;
}
