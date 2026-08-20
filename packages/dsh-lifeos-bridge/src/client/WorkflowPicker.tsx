import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import {
  IconChevronDownOutline14,
  Menu,
  Modal,
  type MenuEntry,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { HostObservable, InjectFace, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { LifeosWorkflowOption, WorkflowSelection } from "../contracts.ts";
import type { LifeosClientState } from "./controller.ts";

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
  const configurable = selectedOption !== null && selectedOption.configurableNodes.length > 0;
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
        description="配置只影响后续发送，并随当前工作流选择保存；发送后会由Chat校验并冻结到本次运行。"
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
                {state.selectingWorkflow ? "正在应用…" : "应用"}
              </button>
            </div>
          </div>
        }
      >
        <section className="lifeos-workflow-config" data-testid="lifeos-workflow-config">
          {selectedOption?.configurableNodes.map((node) => (
            <article className="lifeos-workflow-config-node" key={node.definitionNodeId}>
              <header>
                <strong>{node.title}</strong>
              </header>
              {node.fields.map((field) => (
                <WorkflowConfigField
                  key={field.name}
                  nodeId={node.definitionNodeId}
                  field={field}
                  configuration={draftConfiguration}
                  setConfiguration={setDraftConfiguration}
                />
              ))}
            </article>
          ))}
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
  return <p className="lifeos-warning">“{field.label}”暂不支持在当前界面配置。</p>;
}
