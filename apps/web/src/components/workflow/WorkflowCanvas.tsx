import { useEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, MarkerType, ReactFlow, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { WorkflowRunViewDto } from "@chat/contracts/public";
import {
  layoutWorkflowView,
  workflowStructureSignature,
  type WorkflowViewportClass,
} from "../../workflow/layout-workflow-view.js";
import { WorkflowNodeCard, type WorkflowCanvasNode } from "./WorkflowNodeCard.js";

const nodeTypes = { workflowNode: WorkflowNodeCard };

function edgeClassName(kind: string): string {
  return `workflow-edge workflow-edge-${kind.replaceAll("_", "-")}`;
}

export function WorkflowCanvas({
  view,
  viewportClass,
  selectedNodeId,
  collapsedParentNodeRunIds,
  onSelect,
  onToggleChildren,
}: {
  readonly view: WorkflowRunViewDto;
  readonly viewportClass: WorkflowViewportClass;
  readonly selectedNodeId: string | null;
  readonly collapsedParentNodeRunIds: ReadonlySet<string>;
  readonly onSelect: (nodeId: string) => void;
  readonly onToggleChildren: (nodeId: string) => void;
}) {
  const structureSignature = workflowStructureSignature(view);
  const previousStructure = useRef(structureSignature);
  const [structureChanged, setStructureChanged] = useState(false);
  const layout = useMemo(
    () => layoutWorkflowView(view, viewportClass, collapsedParentNodeRunIds),
    [view, viewportClass, collapsedParentNodeRunIds],
  );
  const nodes = useMemo<WorkflowCanvasNode[]>(
    () =>
      layout.nodes.map((node) => ({
        id: node.id,
        type: "workflowNode",
        position: node.position,
        width: node.size.width,
        height: node.size.height,
        draggable: false,
        connectable: false,
        selectable: false,
        focusable: false,
        data: {
          definitionNode: node.definitionNode,
          ...(node.nodeRun !== undefined ? { nodeRun: node.nodeRun } : {}),
          selected: selectedNodeId === node.id,
          hasChildren: node.hasChildren,
          childrenCollapsed: collapsedParentNodeRunIds.has(node.id),
          onSelect,
          onToggleChildren,
        },
      })),
    [collapsedParentNodeRunIds, layout.nodes, onSelect, onToggleChildren, selectedNodeId],
  );
  const edges = useMemo<Edge[]>(
    () =>
      layout.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        className: edgeClassName(edge.kind),
        label: edge.kind === "outcome" ? edge.outcomeCode : undefined,
        markerEnd: { type: MarkerType.ArrowClosed },
        animated: false,
        selectable: false,
        focusable: false,
      })),
    [layout.edges],
  );

  useEffect(() => {
    if (previousStructure.current !== structureSignature) {
      previousStructure.current = structureSignature;
      setStructureChanged(true);
    }
  }, [structureSignature]);

  return (
    <div className="workflow-canvas" aria-label="工作流横向运行图">
      {structureChanged && (
        <p className="workflow-structure-update" role="status">
          运行结构已更新。视口保持不变，可用“重置视图”查看完整结构。
        </p>
      )}
      <ReactFlow<WorkflowCanvasNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        edgesReconnectable={false}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        panOnDrag
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick={false}
        minZoom={0.35}
        maxZoom={1.5}
        fitView
        fitViewOptions={{ padding: 0.16, maxZoom: 1 }}
        aria-label="工作流运行画布；节点不可移动或连线，可缩放和平移"
      >
        <Background gap={24} size={1} />
        <Controls
          showInteractive={false}
          fitViewOptions={{ padding: 0.16, maxZoom: 1 }}
          aria-label="画布视图控制"
          onFitView={() => setStructureChanged(false)}
        />
      </ReactFlow>
    </div>
  );
}
