import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workflowRunViewDtoSchema } from "@chat/contracts/public";

const captured = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));

vi.mock("@xyflow/react", () => ({
  ReactFlow: (props: Record<string, unknown>) => {
    captured.props = props;
    return <div data-testid="react-flow-adapter" />;
  },
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  MarkerType: { ArrowClosed: "arrowclosed" },
  Position: { Left: "left", Right: "right" },
}));

import { WorkflowCanvas } from "./WorkflowCanvas.js";

const view = workflowRunViewDtoSchema.parse({
  schemaVersion: "chat-workflow-api.v1",
  productRunId: "run_canvas1",
  workflowViewDefinitionId: "wvd_canvas1",
  title: "Canvas适配测试",
  viewHash: "a".repeat(64),
  sourceKind: "legacy_code",
  historyCompleteness: "complete",
  definitionNodes: [
    {
      definitionNodeId: "start",
      nodeType: "test.start",
      nodeSchemaVersion: "1",
      title: "开始",
      kind: "task",
      optional: false,
    },
    {
      definitionNodeId: "finish",
      nodeType: "test.finish",
      nodeSchemaVersion: "1",
      title: "结束",
      kind: "task",
      optional: false,
    },
  ],
  edges: [{ from: "start", to: "finish", kind: "control" }],
  nodeRuns: [
    {
      workflowNodeRunId: "wnr_canvas1",
      definitionNodeId: "start",
      nodeType: "test.start",
      title: "开始",
      kind: "task",
      optional: false,
      executionPath: [],
      attemptNumber: 1,
      status: "running",
      revision: 1,
      updatedAt: "2026-08-10T10:00:00.000Z",
      allowedActions: ["inspect"],
    },
    {
      workflowNodeRunId: "wnr_canvas2",
      definitionNodeId: "finish",
      nodeType: "test.finish",
      title: "结束",
      kind: "task",
      optional: false,
      executionPath: [],
      attemptNumber: 1,
      status: "queued",
      revision: 1,
      updatedAt: "2026-08-10T10:00:00.000Z",
      allowedActions: ["inspect"],
    },
  ],
  revision: 2,
  updatedAt: "2026-08-10T10:00:00.000Z",
  allowedActions: ["inspect_nodes"],
});

afterEach(() => {
  captured.props = null;
});

describe("React Flow只读渲染边界", () => {
  it("显式关闭拖动、连线、选择、重连和删除，保留缩放平移", () => {
    render(
      <WorkflowCanvas
        view={view}
        viewportClass="desktop"
        selectedNodeId={null}
        collapsedParentNodeRunIds={new Set()}
        onSelect={vi.fn()}
        onToggleChildren={vi.fn()}
      />,
    );
    expect(captured.props).toMatchObject({
      nodesDraggable: false,
      nodesConnectable: false,
      nodesFocusable: false,
      edgesFocusable: false,
      elementsSelectable: false,
      edgesReconnectable: false,
      deleteKeyCode: null,
      selectionKeyCode: null,
      multiSelectionKeyCode: null,
      panOnDrag: true,
      zoomOnScroll: true,
      zoomOnPinch: true,
      zoomOnDoubleClick: false,
      fitView: true,
    });
  });

  it("只更新status不会改变LR坐标", () => {
    const onSelect = vi.fn();
    const rendered = render(
      <WorkflowCanvas
        view={view}
        viewportClass="desktop"
        selectedNodeId="wnr_canvas1"
        collapsedParentNodeRunIds={new Set()}
        onSelect={onSelect}
        onToggleChildren={vi.fn()}
      />,
    );
    const firstPositions = (captured.props?.nodes as { position: unknown }[]).map(
      (node) => node.position,
    );
    const refreshed = {
      ...view,
      nodeRuns: view.nodeRuns.map((node) =>
        node.workflowNodeRunId === "wnr_canvas1"
          ? { ...node, status: "succeeded" as const, revision: node.revision + 1 }
          : node,
      ),
      revision: view.revision + 1,
    };
    rendered.rerender(
      <WorkflowCanvas
        view={refreshed}
        viewportClass="desktop"
        selectedNodeId="wnr_canvas1"
        collapsedParentNodeRunIds={new Set()}
        onSelect={onSelect}
        onToggleChildren={vi.fn()}
      />,
    );
    expect((captured.props?.nodes as { position: unknown }[]).map((node) => node.position)).toEqual(
      firstPositions,
    );
  });
});
