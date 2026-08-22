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
  type AgentResources,
  type AgentVersion,
  type CreateAgentVersionPayload,
} from "@chat/contracts/public";
import type { LifeosWorkflowOption, WorkflowSelection } from "../contracts.ts";
import { saveWorkflowAgentNodeConfigurationResponseSchema } from "../contracts.ts";
import type { LifeosClientState } from "./controller.ts";
import { RuntimeResourceInventory } from "./RuntimeResourceInventory.tsx";
import { browserCommandId, requestSameOriginJson } from "./same-origin-json.ts";

export interface WorkflowPickerInjected {
  hooks: { lifeos: HostObservable<LifeosClientState> };
  loadWorkflows: () => Promise<readonly LifeosWorkflowOption[] | null>;
  selectWorkflow: (selection: WorkflowSelection | null) => Promise<boolean>;
  resolvePromptWorkspace: () => Promise<string | null>;
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
  resolvePromptWorkspace,
}: WorkflowPickerProps) {
  const state = useLifeos((value) => value);
  const [open, setOpen] = useState(false);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [draftConfiguration, setDraftConfiguration] = useState(selectionConfiguration(null));
  const [agentProfiles, setAgentProfiles] = useState<readonly AgentProfileDto[] | null>(null);
  const [agentProfileWorkspaceRootId, setAgentProfileWorkspaceRootId] = useState<string | null>(
    null,
  );
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
    if (!configurationOpen) return;
    let current = true;
    setAgentConfigurationStatus("loading");
    setAgentProfiles(null);
    void resolvePromptWorkspace()
      .then((workspaceRootId) => {
        if (!current) return null;
        setAgentProfileWorkspaceRootId(workspaceRootId);
        const path =
          workspaceRootId === null
            ? "/lifeos/agents"
            : `/lifeos/agents?workspaceRootId=${encodeURIComponent(workspaceRootId)}`;
        return requestSameOriginJson(path, agentProfilesDtoSchema);
      })
      .then((result) => {
        if (!current || result === null) return;
        setAgentProfiles(result.items);
        setAgentConfigurationError(null);
        setAgentConfigurationStatus("ready");
      })
      .catch((cause: unknown) => {
        if (!current) return;
        setAgentConfigurationError(cause instanceof Error ? cause.message : "Agent读取失败");
        setAgentConfigurationStatus("ready");
      });
    return () => {
      current = false;
    };
  }, [configurationOpen]);

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
  const configuredCount = draftConfiguration.overrides.length;
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
    version: AgentVersion | null,
    promptOverrideMarkdown?: string,
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
              ...(version === null
                ? {}
                : {
                    agentVersionId: version.agentVersionId,
                    agentVersionSha256: version.sha256,
                  }),
              ...(promptOverrideMarkdown?.trim() ? { promptOverrideMarkdown } : {}),
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

  const createAgentVersion = async (
    profile: AgentProfileDto,
    payload: CreateAgentVersionPayload,
  ): Promise<AgentVersion | null> => {
    setAgentConfigurationStatus("saving");
    setAgentConfigurationError(null);
    try {
      const revised = await requestSameOriginJson(
        `/lifeos/agents/${encodeURIComponent(profile.agentKey)}/versions`,
        agentProfileDtoSchema,
        {
          method: "POST",
          body: JSON.stringify({
            commandId: browserCommandId(),
            payload,
          }),
        },
      );
      setAgentProfiles(
        (current) =>
          current?.map((item) => (item.agentKey === revised.agentKey ? revised : item)) ?? [
            revised,
          ],
      );
      const previousIds = new Set(profile.versions.map((version) => version.agentVersionId));
      return revised.versions.find((version) => !previousIds.has(version.agentVersionId)) ?? null;
    } catch (cause) {
      setAgentConfigurationError(cause instanceof Error ? cause.message : "Agent Version创建失败");
      return null;
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
        description="选择不可变Agent Version，或临时调整Prompt、工具和运行时资源。可用能力与具体调用审批分离。"
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
          <p className="lifeos-workflow-agent-scope" data-testid="lifeos-workflow-agent-scope">
            {agentProfileWorkspaceRootId === null
              ? "Agent能力作用域：Chat全局 / 空Workspace"
              : `Agent能力作用域：${agentProfileWorkspaceRootId}（来自当前DSH Session）`}
          </p>
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
              workspaceRootId={agentProfileWorkspaceRootId}
              busy={agentConfigurationStatus !== "ready"}
              onSave={saveAgentNode}
              onCreateVersion={createAgentVersion}
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
type AgentConfigurationOverride = Extract<RunOverride, { kind: "agent_configuration" }>;
type ConfigField = LifeosWorkflowOption["configurableNodes"][number]["fields"][number];

const INHERIT_AGENT_RESOURCES: AgentResources = {
  contextFiles: "inherit_runtime_default",
  skills: "inherit_runtime_default",
  promptTemplates: "inherit_runtime_default",
  extensions: "inherit_runtime_default",
};

const WORKFLOW_RESOURCE_LABEL: Readonly<Record<keyof AgentResources, string>> = {
  contextFiles: "上下文文件",
  skills: "Skills",
  promptTemplates: "Prompt Templates",
  extensions: "Extensions",
};

function runtimeToolNames(names: readonly string[]): string[] {
  return [...names];
}

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

function withAgentConfiguration(
  configuration: RunConfiguration,
  nodeId: string,
  override: AgentConfigurationOverride | null,
): RunConfiguration {
  const overrides = configuration.overrides.filter(
    (candidate) =>
      !(candidate.kind === "agent_configuration" && candidate.definitionNodeId === nodeId),
  );
  if (override !== null) overrides.push(override);
  return { schemaVersion: "workflow-run-configuration.v1", overrides };
}

function AgentNodeConfiguration({
  node,
  fields,
  configuration,
  setConfiguration,
  profiles,
  workspaceRootId,
  busy,
  onSave,
  onCreateVersion,
}: {
  node: LifeosWorkflowOption["agentNodes"][number];
  fields: readonly ConfigField[];
  configuration: RunConfiguration;
  setConfiguration: Dispatch<SetStateAction<RunConfiguration>>;
  profiles: readonly AgentProfileDto[] | null;
  workspaceRootId: string | null;
  busy: boolean;
  onSave: (
    node: LifeosWorkflowOption["agentNodes"][number],
    agentKey: LifeosWorkflowOption["agentNodes"][number]["agentKey"],
    version: AgentVersion | null,
    promptOverrideMarkdown?: string,
  ) => Promise<void>;
  onCreateVersion: (
    profile: AgentProfileDto,
    payload: CreateAgentVersionPayload,
  ) => Promise<AgentVersion | null>;
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
  const inheritedLegacyPrompt =
    profile?.systemPrompt.source === "runtime_default"
      ? ""
      : (profile?.systemPrompt.bodyMarkdown ?? "");
  const legacyPromptOverride =
    promptField === undefined
      ? (node.promptOverrideMarkdown ?? "")
      : String(fieldValue(configuration, node.definitionNodeId, promptField) ?? "");
  const effectiveLegacyPrompt =
    legacyPromptOverride.trim() === "" ? inheritedLegacyPrompt : legacyPromptOverride;
  const hasLegacyOverride = configuration.overrides.some(
    (override) =>
      override.kind === "node_config" &&
      override.definitionNodeId === node.definitionNodeId &&
      override.field === "agentPromptOverride",
  );
  const agentOverride = configuration.overrides.find(
    (override): override is AgentConfigurationOverride =>
      override.kind === "agent_configuration" &&
      override.definitionNodeId === node.definitionNodeId,
  );
  const workflowVersion =
    profile?.versions.find((version) => version.agentVersionId === node.agentVersionId) ?? null;
  const selectedVersion =
    agentOverride?.configurationMode === "version"
      ? (profile?.versions.find(
          (version) => version.agentVersionId === agentOverride.agentVersionId,
        ) ?? null)
      : agentOverride?.configurationMode === "temporary"
        ? agentOverride.basedOnVersionId === undefined
          ? null
          : (profile?.versions.find(
              (version) => version.agentVersionId === agentOverride.basedOnVersionId,
            ) ?? null)
        : workflowVersion;
  const defaultVariant = profile?.runtimeBaseline?.variants[0] ?? null;
  const runtimeVariantKey =
    agentOverride?.configurationMode === "temporary"
      ? agentOverride.runtime.baseVariantKey
      : (selectedVersion?.runtime.baseVariantKey ?? defaultVariant?.variantKey ?? "");
  const runtimeVariant =
    profile?.runtimeBaseline?.variants.find(
      (variant) => variant.variantKey === runtimeVariantKey,
    ) ?? defaultVariant;
  const systemPrompt =
    agentOverride?.configurationMode === "temporary"
      ? agentOverride.systemPrompt
      : selectedVersion?.systemPrompt.mode === "replace"
        ? {
            mode: "replace" as const,
            bodyMarkdown: selectedVersion.systemPrompt.bodyMarkdown,
          }
        : { mode: "inherit_runtime" as const };
  const enabledToolNames =
    agentOverride?.configurationMode === "temporary"
      ? agentOverride.enabledToolNames
      : (selectedVersion?.enabledToolNames ??
        runtimeToolNames(runtimeVariant?.enabledToolNames ?? []));
  const resources =
    agentOverride?.configurationMode === "temporary"
      ? agentOverride.resources
      : (selectedVersion?.resources ?? INHERIT_AGENT_RESOURCES);
  const sourceLabel =
    profile?.runtimeBaseline === undefined
      ? hasLegacyOverride
        ? "本次会话临时修改"
        : node.promptSource === "workflow_override"
          ? "Workflow已修改"
          : "继承Agent默认"
      : agentOverride?.configurationMode === "temporary"
        ? "本次会话临时配置"
        : agentOverride?.configurationMode === "version"
          ? "本次会话选择Version"
          : workflowVersion === null
            ? "Workflow继承Pi默认"
            : `Workflow绑定 v${workflowVersion.version}`;
  const setField = (field: ConfigField, value: string) =>
    setConfiguration((current) => withFieldValue(current, node.definitionNodeId, field, value));
  const setAgentOverride = (override: AgentConfigurationOverride | null): void =>
    setConfiguration((current) => withAgentConfiguration(current, node.definitionNodeId, override));
  const currentTemporary = () => ({
    runtime: { kind: "pi_coding_agent" as const, baseVariantKey: runtimeVariantKey },
    systemPrompt,
    enabledToolNames,
    resources,
    ...(selectedVersion === null
      ? {}
      : {
          basedOnVersionId: selectedVersion.agentVersionId,
          basedOnVersionSha256: selectedVersion.sha256,
        }),
  });
  const updateTemporary = (patch: Partial<ReturnType<typeof currentTemporary>>): void => {
    setAgentOverride({
      kind: "agent_configuration",
      definitionNodeId: node.definitionNodeId,
      configurationMode: "temporary",
      ...currentTemporary(),
      ...patch,
    });
  };
  const isRuntimeBaseline =
    selectedVersion === null &&
    systemPrompt.mode === "inherit_runtime" &&
    JSON.stringify(enabledToolNames) ===
      JSON.stringify(runtimeToolNames(runtimeVariant?.enabledToolNames ?? [])) &&
    Object.values(resources).every((mode) => mode === "inherit_runtime_default");
  const persistentDirty =
    agentKey !== node.agentKey ||
    agentOverride !== undefined ||
    (node.agentVersionId !== undefined && selectedVersion === null) ||
    (profile?.runtimeBaseline === undefined &&
      legacyPromptOverride !== (node.promptOverrideMarkdown ?? ""));

  const savePersistent = async (): Promise<void> => {
    if (profile === null) return;
    if (profile.runtimeBaseline === undefined) {
      await onSave(
        node,
        agentKey,
        null,
        effectiveLegacyPrompt === inheritedLegacyPrompt ? "" : legacyPromptOverride,
      );
      return;
    }
    if (agentOverride?.configurationMode === "version") {
      const version = profile.versions.find(
        (candidate) => candidate.agentVersionId === agentOverride.agentVersionId,
      );
      if (version !== undefined) await onSave(node, agentKey, version);
      return;
    }
    if (agentOverride?.configurationMode !== "temporary") {
      await onSave(node, agentKey, workflowVersion);
      return;
    }
    if (isRuntimeBaseline) {
      await onSave(node, agentKey, null);
      return;
    }
    const temporary = currentTemporary();
    const created = await onCreateVersion(profile, {
      title: `${node.title} · Workflow配置`,
      description: `从${selectedVersion?.title ?? "Pi默认基线"}保存的Workflow Agent配置`,
      scope:
        selectedVersion?.scope ??
        (workspaceRootId === null
          ? { kind: "global" }
          : { kind: "workspace", rootId: workspaceRootId }),
      runtime: temporary.runtime,
      systemPrompt: temporary.systemPrompt,
      enabledToolNames: temporary.enabledToolNames,
      resources: temporary.resources,
      ...(selectedVersion === null
        ? {}
        : {
            basedOnVersionId: selectedVersion.agentVersionId,
            basedOnVersionSha256: selectedVersion.sha256,
          }),
    });
    if (created !== null) {
      // 两个公开命令没有伪装成原子事务：Version一旦创建就先成为当前草稿的精确引用。
      // 后续Workflow保存若失败，用户重试只会复用该ID+Hash，不会再制造重复Version。
      setAgentOverride({
        kind: "agent_configuration",
        definitionNodeId: node.definitionNodeId,
        configurationMode: "version",
        agentVersionId: created.agentVersionId,
        agentVersionSha256: created.sha256,
      });
      await onSave(node, agentKey, created);
    }
  };

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
        <span>Pi默认基线</span>
        <i aria-hidden="true">→</i>
        <span>Agent Version / Workflow节点</span>
        <i aria-hidden="true">→</i>
        <span>本次会话</span>
      </div>
      {runtimeVariant === null ? null : (
        <RuntimeResourceInventory inventory={runtimeVariant.resourceInventory} />
      )}
      {agentKeyField === undefined ? (
        <dl>
          <div>
            <dt>Agent</dt>
            <dd>{AGENT_LABEL[agentKey]}</dd>
          </div>
        </dl>
      ) : (
        <label className="lifeos-workflow-agent-field">
          Agent 类型
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
      {profile?.runtimeBaseline === undefined ||
      !profile.allowedActions.includes("create_version") ||
      runtimeVariant === null ? (
        profile?.runtimeBaseline !== undefined ? (
          <p>当前节点只展示真实Runtime基线，尚未开放Agent Version创建或执行配置。</p>
        ) : promptField === undefined ? (
          <p>该Agent继续使用其Catalog默认能力。</p>
        ) : (
          <label className="lifeos-workflow-agent-field lifeos-workflow-agent-prompt">
            旧节点自定义 System Prompt（兼容）
            <small>此类Agent尚未接入Pi Coding Agent Version；留空继承Agent Catalog默认。</small>
            <textarea
              aria-label={`${node.title} System Prompt`}
              value={effectiveLegacyPrompt}
              maxLength={promptField.maximumLength}
              disabled={busy || profile === null}
              onChange={(event) => setField(promptField, event.currentTarget.value)}
            />
          </label>
        )
      ) : (
        <section
          className="lifeos-workflow-agent-version"
          data-testid="lifeos-workflow-agent-version"
        >
          <label className="lifeos-workflow-agent-field">
            Agent Version
            <select
              aria-label={`${node.title} Agent Version`}
              value={
                agentOverride?.configurationMode === "temporary"
                  ? "__temporary__"
                  : (selectedVersion?.agentVersionId ?? "__runtime__")
              }
              disabled={busy}
              onChange={(event) => {
                if (event.currentTarget.value === "__runtime__") {
                  if (workflowVersion === null) setAgentOverride(null);
                  else
                    setAgentOverride({
                      kind: "agent_configuration",
                      definitionNodeId: node.definitionNodeId,
                      configurationMode: "temporary",
                      runtime: {
                        kind: "pi_coding_agent",
                        baseVariantKey: defaultVariant?.variantKey ?? "pi_cli_default",
                      },
                      systemPrompt: { mode: "inherit_runtime" },
                      enabledToolNames: runtimeToolNames(defaultVariant?.enabledToolNames ?? []),
                      resources: INHERIT_AGENT_RESOURCES,
                    });
                  return;
                }
                const version = profile.versions.find(
                  (candidate) => candidate.agentVersionId === event.currentTarget.value,
                );
                if (version === undefined) return;
                if (version.agentVersionId === workflowVersion?.agentVersionId)
                  setAgentOverride(null);
                else
                  setAgentOverride({
                    kind: "agent_configuration",
                    definitionNodeId: node.definitionNodeId,
                    configurationMode: "version",
                    agentVersionId: version.agentVersionId,
                    agentVersionSha256: version.sha256,
                  });
              }}
            >
              <option value="__runtime__">Pi 默认基线</option>
              {agentOverride?.configurationMode === "temporary" ? (
                <option value="__temporary__">本次会话临时配置</option>
              ) : null}
              {profile.versions.map((version) => (
                <option value={version.agentVersionId} key={version.agentVersionId}>
                  v{version.version} · {version.title}
                </option>
              ))}
            </select>
          </label>
          <label className="lifeos-workflow-agent-field">
            Pi Runtime Variant
            <select
              aria-label={`${node.title} Pi Runtime Variant`}
              value={runtimeVariant.variantKey}
              disabled={busy}
              onChange={(event) => {
                const variant = profile.runtimeBaseline?.variants.find(
                  (candidate) => candidate.variantKey === event.currentTarget.value,
                );
                if (variant === undefined) return;
                updateTemporary({
                  runtime: { kind: "pi_coding_agent", baseVariantKey: variant.variantKey },
                  enabledToolNames: runtimeToolNames(variant.enabledToolNames),
                });
              }}
            >
              {profile.runtimeBaseline.variants.map((variant) => (
                <option value={variant.variantKey} key={variant.variantKey}>
                  {variant.title}
                </option>
              ))}
            </select>
          </label>
          <label className="lifeos-workflow-agent-field lifeos-workflow-agent-prompt">
            完整 System Prompt
            <select
              aria-label={`${node.title} Prompt模式`}
              value={systemPrompt.mode}
              disabled={busy}
              onChange={(event) =>
                updateTemporary({
                  systemPrompt:
                    event.currentTarget.value === "inherit_runtime"
                      ? { mode: "inherit_runtime" }
                      : {
                          mode: "replace",
                          bodyMarkdown: runtimeVariant.piSystemPrompt.bodyMarkdown,
                        },
                })
              }
            >
              <option value="inherit_runtime">继承Pi运行时默认</option>
              <option value="replace">完整替换</option>
            </select>
            {systemPrompt.mode === "replace" ? (
              <textarea
                aria-label={`${node.title} System Prompt`}
                value={systemPrompt.bodyMarkdown}
                disabled={busy}
                onChange={(event) =>
                  updateTemporary({
                    systemPrompt: {
                      mode: "replace",
                      bodyMarkdown: event.currentTarget.value,
                    },
                  })
                }
              />
            ) : (
              <pre>{runtimeVariant.piSystemPrompt.bodyMarkdown}</pre>
            )}
          </label>
          <fieldset className="lifeos-workflow-agent-capabilities">
            <legend>可选工具目录</legend>
            <small>目录来自当前Runtime Variant；默认勾选与具体调用审批分离。</small>
            <div>
              {runtimeVariant.tools.map((tool) => (
                <label key={tool.name} title={tool.description}>
                  <input
                    type="checkbox"
                    checked={enabledToolNames.includes(tool.name)}
                    disabled={busy}
                    onChange={(event) =>
                      updateTemporary({
                        enabledToolNames: event.currentTarget.checked
                          ? runtimeVariant.tools
                              .map((candidate) => candidate.name)
                              .filter(
                                (candidate) =>
                                  enabledToolNames.includes(candidate) || candidate === tool.name,
                              )
                          : enabledToolNames.filter((candidate) => candidate !== tool.name),
                      })
                    }
                  />
                  <code>{tool.name}</code>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="lifeos-workflow-agent-capabilities">
            <legend>运行时资源</legend>
            <small>本版按整类继承或禁用；上方真实清单暂不支持逐项选择。</small>
            <div>
              {(Object.keys(WORKFLOW_RESOURCE_LABEL) as Array<keyof AgentResources>).map(
                (resource) => (
                  <label key={resource}>
                    <input
                      type="checkbox"
                      checked={resources[resource] === "inherit_runtime_default"}
                      disabled={busy}
                      onChange={(event) =>
                        updateTemporary({
                          resources: {
                            ...resources,
                            [resource]: event.currentTarget.checked
                              ? "inherit_runtime_default"
                              : "disabled",
                          },
                        })
                      }
                    />
                    {WORKFLOW_RESOURCE_LABEL[resource]}
                  </label>
                ),
              )}
            </div>
          </fieldset>
        </section>
      )}
      <dl>
        <div>
          <dt>Profile</dt>
          <dd>
            <code>{node.profileVersion}</code>
          </dd>
        </div>
        <div>
          <dt>Agent Version</dt>
          <dd>
            {selectedVersion === null ? (
              "Pi默认基线"
            ) : (
              <>
                v{selectedVersion.version} · {selectedVersion.title} ·{" "}
                <code>{selectedVersion.agentVersionId}</code> · SHA{" "}
                <code>{selectedVersion.sha256.slice(0, 12)}</code>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>可用能力</dt>
          <dd>
            {enabledToolNames.length === 0 ? node.toolPolicy.summary : enabledToolNames.join(" / ")}
          </dd>
        </div>
      </dl>
      <div className="lifeos-workflow-agent-actions">
        <button
          type="button"
          disabled={
            busy ||
            (profile?.runtimeBaseline === undefined
              ? !hasLegacyOverride
              : agentOverride === undefined)
          }
          onClick={() => {
            if (profile?.runtimeBaseline === undefined && promptField !== undefined) {
              setField(promptField, promptField.defaultValue);
              return;
            }
            setAgentOverride(null);
          }}
        >
          恢复 Workflow 值
        </button>
        <button
          type="button"
          className="lifeos-primary"
          disabled={busy || profile === null || !persistentDirty}
          onClick={() => void savePersistent()}
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
