import type { WorkflowRunViewDto } from "@chat/contracts/public";
import { linearizedWorkflowView } from "../../workflow/layout-workflow-view.js";
import {
  formatWorkflowDuration,
  workflowNodeTypeLabel,
  WORKFLOW_STATUS,
} from "../../workflow/workflow-presenters.js";

export function WorkflowLinearList({
  view,
  selectedNodeId,
  collapsedParentNodeRunIds,
  onSelect,
  onToggleChildren,
}: {
  readonly view: WorkflowRunViewDto;
  readonly selectedNodeId: string | null;
  readonly collapsedParentNodeRunIds: ReadonlySet<string>;
  readonly onSelect: (nodeId: string) => void;
  readonly onToggleChildren: (nodeId: string) => void;
}) {
  const items = linearizedWorkflowView(view, collapsedParentNodeRunIds);
  return (
    <ol className="workflow-linear-list" aria-label="工作流节点顺序">
      {items.map((item, index) => {
        const status = item.nodeRun === undefined ? null : WORKFLOW_STATUS[item.nodeRun.status];
        const duration = item.nodeRun === undefined ? null : formatWorkflowDuration(item.nodeRun);
        const title = item.nodeRun?.title ?? item.definitionNode.title;
        return (
          <li
            key={item.id}
            className="workflow-linear-item"
            data-tone={status?.tone ?? "neutral"}
            data-depth={item.depth > 0 ? "child" : "root"}
          >
            <span className="workflow-linear-index" aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </span>
            <button
              type="button"
              className="workflow-linear-select"
              aria-label={`${title}，${status?.label ?? "尚无运行实例"}，查看详情`}
              aria-pressed={selectedNodeId === item.id}
              data-workflow-node-id={item.id}
              onClick={() => onSelect(item.id)}
            >
              <span>
                <strong>{title}</strong>
                <small>
                  {workflowNodeTypeLabel(item.nodeRun?.nodeType ?? item.definitionNode.nodeType)}
                </small>
              </span>
              <span className="workflow-node-status" data-tone={status?.tone ?? "neutral"}>
                <span aria-hidden="true">{status?.symbol ?? "◇"}</span>
                {status?.label ?? "尚未开始"}
              </span>
              {duration !== null && <small>{duration}</small>}
            </button>
            {item.hasChildren && item.nodeRun !== undefined && (
              <button
                type="button"
                className="workflow-linear-toggle"
                aria-expanded={!collapsedParentNodeRunIds.has(item.id)}
                onClick={() => onToggleChildren(item.id)}
              >
                {collapsedParentNodeRunIds.has(item.id) ? "展开子步骤" : "收起子步骤"}
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}
