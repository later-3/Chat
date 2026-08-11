import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { WorkflowDefinitionNodeDto, WorkflowNodeRunSummaryDto } from "@chat/contracts/public";
import {
  formatWorkflowDuration,
  workflowNodeTypeLabel,
  WORKFLOW_STATUS,
} from "../../workflow/workflow-presenters.js";

export interface WorkflowNodeCardData extends Record<string, unknown> {
  readonly definitionNode: WorkflowDefinitionNodeDto;
  readonly nodeRun?: WorkflowNodeRunSummaryDto;
  readonly selected: boolean;
  readonly hasChildren: boolean;
  readonly childrenCollapsed: boolean;
  readonly onSelect: (nodeId: string) => void;
  readonly onToggleChildren: (nodeId: string) => void;
}

export type WorkflowCanvasNode = Node<WorkflowNodeCardData, "workflowNode">;

export function WorkflowNodeCard({ id, data }: NodeProps<WorkflowCanvasNode>) {
  const status = data.nodeRun === undefined ? null : WORKFLOW_STATUS[data.nodeRun.status];
  const duration = data.nodeRun === undefined ? null : formatWorkflowDuration(data.nodeRun);
  const iteration = data.nodeRun?.executionPath.at(-1)?.iteration;
  const title = data.nodeRun?.title ?? data.definitionNode.title;

  return (
    <article
      className="workflow-node-card"
      data-selected={data.selected}
      data-tone={status?.tone ?? "neutral"}
      data-workflow-node-id={id}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <button
        type="button"
        className="workflow-node-select"
        aria-label={`${title}，${status?.label ?? "尚无运行实例"}，查看详情`}
        aria-pressed={data.selected}
        onClick={() => data.onSelect(id)}
      >
        <span className="workflow-node-heading">
          <strong title={title}>{title}</strong>
          <span className="workflow-node-status" data-tone={status?.tone ?? "neutral"}>
            <span aria-hidden="true">{status?.symbol ?? "◇"}</span>
            {status?.label ?? "尚未开始"}
          </span>
        </span>
        <span className="workflow-node-type">
          {workflowNodeTypeLabel(data.nodeRun?.nodeType ?? data.definitionNode.nodeType)}
        </span>
        <span className="workflow-node-meta">
          {iteration !== undefined && <span>循环 {iteration}</span>}
          {(data.nodeRun?.attemptNumber ?? 1) > 1 && (
            <span>尝试 {data.nodeRun?.attemptNumber}</span>
          )}
          {duration !== null && <span>{duration}</span>}
          {data.definitionNode.optional && <span>可选</span>}
        </span>
      </button>
      {data.hasChildren && data.nodeRun !== undefined && (
        <button
          type="button"
          className="workflow-node-children-toggle nodrag nopan"
          aria-expanded={!data.childrenCollapsed}
          onClick={() => data.onToggleChildren(data.nodeRun?.workflowNodeRunId ?? id)}
        >
          {data.childrenCollapsed ? "展开步骤" : "收起步骤"}
        </button>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </article>
  );
}
