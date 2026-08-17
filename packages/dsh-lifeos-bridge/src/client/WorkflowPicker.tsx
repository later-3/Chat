import { useEffect, useMemo, useState } from "react";
import {
  IconChevronDownOutline14,
  Menu,
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

export type WorkflowPickerProps = PropsRuntime<"conversation.input.left"> &
  InjectFace<WorkflowPickerInjected>;

const WORKFLOW_ID_PREFIX = "lifeos-workflow:";

const BLUEPRINT_LABEL: Record<LifeosWorkflowOption["blueprintKey"], string> = {
  planning: "规划",
  note: "笔记",
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
  const projection = state.projection;
  const selection = projection?.workflowSelection ?? null;
  const workflows = state.workflows;
  const locked = input.phase !== "plain" || state.selectingWorkflow;

  useEffect(() => {
    if (open && workflows === null) void loadWorkflows();
  }, [open, workflows, loadWorkflows]);

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

  const visualLabel =
    selection === null
      ? "规划"
      : (workflows?.find(
          (option) =>
            option.workflowDefinitionRevisionId === selection.workflowDefinitionRevisionId,
        )?.title ?? selection.title);
  const defaultPlanning = workflows?.find(
    (option) => option.blueprintKey === "planning" && option.ownerKind === "system",
  );
  const selectedId = `${WORKFLOW_ID_PREFIX}${
    selection?.workflowDefinitionRevisionId ?? defaultPlanning?.workflowDefinitionRevisionId ?? ""
  }`;

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
            aria-label={`选择工作流，当前：${selection?.title ?? "默认规划工作流"}`}
            aria-haspopup="menu"
            aria-expanded={open}
            title={selection?.title ?? "默认规划工作流"}
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
      {state.workflowError !== null && !open ? (
        <span className="lifeos-sr-only" role="alert" data-testid="lifeos-workflow-error">
          {state.workflowError}
        </span>
      ) : null}
    </span>
  );
}
