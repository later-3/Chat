import { describe, expect, it } from "vitest";
import { workflowRunViewDtoSchema, type WorkflowRunViewDto } from "@chat/contracts/public";
import {
  layoutWorkflowView,
  linearizedWorkflowView,
  WorkflowLayoutError,
} from "./layout-workflow-view.js";

const NOW = "2026-08-10T10:00:00.000Z";

interface TestNodeRunInput {
  readonly definitionNodeId?: string;
  readonly nodeType?: string;
  readonly title?: string;
  readonly kind?: "task" | "human_review" | "composite" | "product_commit";
  readonly optional?: boolean;
  readonly executionPath?: readonly {
    readonly containerNodeId: string;
    readonly iteration: number;
  }[];
  readonly attemptNumber?: number;
  readonly parentNodeRunId?: string;
  readonly status?:
    | "queued"
    | "running"
    | "waiting_human"
    | "succeeded"
    | "failed"
    | "skipped"
    | "cancelled"
    | "outcome_unknown";
  readonly revision?: number;
  readonly updatedAt?: string;
  readonly allowedActions?: readonly ("inspect" | "submit_decision")[];
}

function makeView(input: {
  readonly nodeIds: readonly string[];
  readonly edges: readonly {
    readonly from: string;
    readonly to: string;
    readonly kind?: "control" | "outcome" | "loop_back";
    readonly outcomeCode?: string;
  }[];
  readonly nodeRuns?: readonly TestNodeRunInput[];
}): WorkflowRunViewDto {
  const rawNodeRuns: readonly TestNodeRunInput[] = input.nodeRuns ?? input.nodeIds.map(() => ({}));
  return workflowRunViewDtoSchema.parse({
    schemaVersion: "chat-workflow-api.v1",
    productRunId: "run_layout1",
    workflowViewDefinitionId: "wvd_layout1",
    title: "布局测试工作流",
    viewHash: "a".repeat(64),
    sourceKind: "legacy_code",
    historyCompleteness: "complete",
    definitionNodes: input.nodeIds.map((definitionNodeId) => ({
      definitionNodeId,
      nodeType: definitionNodeId.includes("review")
        ? "human.plan_review"
        : definitionNodeId.includes("commit")
          ? "product.commit"
          : "test.task",
      nodeSchemaVersion: "1",
      title: definitionNodeId,
      kind: definitionNodeId.includes("review")
        ? "human_review"
        : definitionNodeId.includes("commit")
          ? "product_commit"
          : "task",
      optional: false,
    })),
    edges: input.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      kind: edge.kind ?? "control",
      ...(edge.outcomeCode === undefined ? {} : { outcomeCode: edge.outcomeCode }),
    })),
    nodeRuns: rawNodeRuns.map((partial, index) => ({
      workflowNodeRunId: `wnr_layout${String(index + 1)}`,
      definitionNodeId: partial.definitionNodeId ?? input.nodeIds[index],
      nodeType: partial.nodeType ?? "test.task",
      title: partial.title ?? partial.definitionNodeId ?? input.nodeIds[index],
      kind: partial.kind ?? "task",
      optional: partial.optional ?? false,
      executionPath: partial.executionPath ?? [],
      attemptNumber: partial.attemptNumber ?? 1,
      status: partial.status ?? "queued",
      revision: partial.revision ?? 1,
      updatedAt: partial.updatedAt ?? NOW,
      allowedActions: partial.allowedActions ?? ["inspect"],
      ...(partial.parentNodeRunId === undefined
        ? {}
        : { parentNodeRunId: partial.parentNodeRunId }),
    })),
    revision: 1,
    updatedAt: NOW,
    allowedActions: ["inspect_nodes"],
  });
}

function overlaps(
  left: ReturnType<typeof layoutWorkflowView>["nodes"][number],
  right: ReturnType<typeof layoutWorkflowView>["nodes"][number],
): boolean {
  return !(
    left.position.x + left.size.width <= right.position.x ||
    right.position.x + right.size.width <= left.position.x ||
    left.position.y + left.size.height <= right.position.y ||
    right.position.y + right.size.height <= left.position.y
  );
}

describe("Workflow View确定性LR布局", () => {
  it("六节点Planning主序列严格从左到右且相同输入字节级稳定", () => {
    const nodeIds = ["context", "plan", "review", "execute", "validate", "commit"];
    const view = makeView({
      nodeIds,
      edges: nodeIds.slice(1).map((to, index) => ({ from: nodeIds[index] ?? "", to })),
    });
    const first = layoutWorkflowView(view, "desktop");
    const second = layoutWorkflowView(view, "desktop");
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.nodes.map((node) => node.position.x)).toEqual(
      [...first.nodes.map((node) => node.position.x)].sort((left, right) => left - right),
    );
  });

  it("choice outcome按稳定枚举值分lane且主边向右", () => {
    const view = makeView({
      nodeIds: ["start", "choice", "branch_z", "branch_a", "commit"],
      edges: [
        { from: "start", to: "choice" },
        { from: "choice", to: "branch_z", kind: "outcome", outcomeCode: "zeta" },
        { from: "choice", to: "branch_a", kind: "outcome", outcomeCode: "alpha" },
        { from: "branch_z", to: "commit" },
        { from: "branch_a", to: "commit" },
      ],
    });
    const layout = layoutWorkflowView(view, "desktop");
    const alpha = layout.nodes.find((node) => node.definitionNode.definitionNodeId === "branch_a");
    const zeta = layout.nodes.find((node) => node.definitionNode.definitionNodeId === "branch_z");
    expect((alpha?.position.y ?? 0) < (zeta?.position.y ?? 0)).toBe(true);
    for (const edge of layout.edges.filter((candidate) => candidate.kind !== "loop_back")) {
      const source = layout.nodes.find((node) => node.id === edge.source);
      const target = layout.nodes.find((node) => node.id === edge.target);
      expect((target?.position.x ?? 0) > (source?.position.x ?? 0)).toBe(true);
    }
  });

  it("bounded loop只允许声明的回边向左并按iteration配对", () => {
    const view = makeView({
      nodeIds: ["start", "plan", "review", "commit"],
      edges: [
        { from: "start", to: "plan" },
        { from: "plan", to: "review" },
        { from: "review", to: "plan", kind: "loop_back", outcomeCode: "revise" },
        { from: "review", to: "commit", kind: "outcome", outcomeCode: "approve" },
      ],
      nodeRuns: [
        { definitionNodeId: "start" },
        { definitionNodeId: "plan", executionPath: [{ containerNodeId: "review", iteration: 1 }] },
        { definitionNodeId: "plan", executionPath: [{ containerNodeId: "review", iteration: 2 }] },
        {
          definitionNodeId: "review",
          executionPath: [{ containerNodeId: "review", iteration: 1 }],
        },
        {
          definitionNodeId: "review",
          executionPath: [{ containerNodeId: "review", iteration: 2 }],
        },
        { definitionNodeId: "commit" },
      ],
    });
    const layout = layoutWorkflowView(view, "desktop");
    const loopEdges = layout.edges.filter((edge) => edge.kind === "loop_back");
    expect(loopEdges).toHaveLength(1);
    expect(loopEdges[0]?.source).toBe("wnr_layout4");
    expect(loopEdges[0]?.target).toBe("wnr_layout3");
  });

  it("Composite子运行可折叠，线性fallback保留相同层级语义", () => {
    const view = makeView({
      nodeIds: ["execute", "commit"],
      edges: [{ from: "execute", to: "commit" }],
      nodeRuns: [
        { definitionNodeId: "execute", nodeType: "execute.plan" },
        {
          definitionNodeId: "execute",
          nodeType: "execute.plan_step",
          parentNodeRunId: "wnr_layout1" as never,
        },
        { definitionNodeId: "commit", nodeType: "product.commit", kind: "product_commit" },
      ],
    });
    const expanded = layoutWorkflowView(view, "desktop");
    expect(expanded.nodes.find((node) => node.id === "wnr_layout2")?.depth).toBe(1);
    expect(linearizedWorkflowView(view).find((node) => node.id === "wnr_layout2")?.depth).toBe(1);
    const collapsed = layoutWorkflowView(view, "desktop", new Set(["wnr_layout1"]));
    expect(collapsed.nodes.some((node) => node.id === "wnr_layout2")).toBe(false);
  });

  it("空、单节点与错误结构有明确边界", () => {
    const single = makeView({ nodeIds: ["only"], edges: [] });
    expect(layoutWorkflowView(single, "compact").nodes).toHaveLength(1);
    const dangling = makeView({ nodeIds: ["only"], edges: [] });
    const damaged = {
      ...dangling,
      edges: [{ from: "only", to: "missing", kind: "control" }],
    } as unknown as WorkflowRunViewDto;
    expect(() => layoutWorkflowView(damaged, "desktop")).toThrowError(WorkflowLayoutError);
  });

  it("多组合法DAG节点不重叠，所有control边总体向右", () => {
    for (let size = 2; size <= 24; size += 1) {
      const nodeIds = Array.from({ length: size }, (_, index) => `node_${String(index)}`);
      const view = makeView({
        nodeIds,
        edges: nodeIds.slice(1).map((to, index) => ({
          from: nodeIds[Math.max(0, Math.floor(index / 2))] ?? "node_0",
          to,
        })),
      });
      const layout = layoutWorkflowView(view, "compact");
      for (const [index, node] of layout.nodes.entries()) {
        for (const other of layout.nodes.slice(index + 1))
          expect(overlaps(node, other)).toBe(false);
      }
      for (const edge of layout.edges) {
        const source = layout.nodes.find((node) => node.id === edge.source);
        const target = layout.nodes.find((node) => node.id === edge.target);
        expect((target?.position.x ?? 0) > (source?.position.x ?? 0)).toBe(true);
      }
    }
  });
});
