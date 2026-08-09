import { hashCanonical } from "./canonical-hash.js";

/** Domain保持对Zod/网络合同无依赖；Application在持久化边界执行合同解析。 */
export interface WorkflowViewNodeShape {
  readonly definitionNodeId: string;
  readonly nodeType: string;
  readonly nodeSchemaVersion: string;
  readonly title: string;
  readonly kind: "task" | "human_review" | "composite" | "product_commit";
  readonly optional: boolean;
  readonly parentDefinitionNodeId?: string | undefined;
}

export interface WorkflowViewEdgeShape {
  readonly from: string;
  readonly to: string;
  readonly kind: "control" | "outcome" | "loop_back";
  readonly outcomeCode?: string | undefined;
}

export interface WorkflowViewDefinitionShape {
  readonly schemaVersion: "workflow-view-definition.v1";
  readonly workflowViewDefinitionId: string;
  readonly title: string;
  readonly source:
    | {
        readonly kind: "legacy_code";
        readonly blueprintKey: string;
        readonly blueprintVersion: string;
      }
    | {
        readonly kind: "published_definition";
        readonly workflowDefinitionId: string;
        readonly definitionRevision: number;
        readonly definitionSha256: string;
        readonly blueprintKey: string;
        readonly blueprintVersion: string;
      };
  readonly nodes: readonly WorkflowViewNodeShape[];
  readonly edges: readonly WorkflowViewEdgeShape[];
  readonly sha256: string;
  readonly revision: 1;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const LEGACY_PLANNING_VIEW_ID = "wvd_planninglegacyv1";

const LEGACY_PLANNING_VIEW_CONTENT = {
  title: "规划、确认与执行",
  source: {
    kind: "legacy_code" as const,
    blueprintKey: "project-planning",
    blueprintVersion: "legacy.v1",
  },
  nodes: [
    {
      definitionNodeId: "context",
      nodeType: "context.compile",
      nodeSchemaVersion: "1",
      title: "整理上下文",
      kind: "task" as const,
      optional: false,
    },
    {
      definitionNodeId: "plan",
      nodeType: "agent.plan",
      nodeSchemaVersion: "1",
      title: "生成计划",
      kind: "task" as const,
      optional: false,
    },
    {
      definitionNodeId: "review",
      nodeType: "human.plan_review",
      nodeSchemaVersion: "1",
      title: "审核计划",
      kind: "human_review" as const,
      optional: false,
    },
    {
      definitionNodeId: "execute",
      nodeType: "execute.plan",
      nodeSchemaVersion: "1",
      title: "执行计划",
      kind: "composite" as const,
      optional: false,
    },
    {
      definitionNodeId: "validate",
      nodeType: "result.validate",
      nodeSchemaVersion: "1",
      title: "验证结果",
      kind: "task" as const,
      optional: false,
    },
    {
      definitionNodeId: "commit",
      nodeType: "product.commit",
      nodeSchemaVersion: "1",
      title: "提交结果",
      kind: "product_commit" as const,
      optional: false,
    },
  ],
  edges: [
    { from: "context", to: "plan", kind: "control" as const },
    { from: "plan", to: "review", kind: "control" as const },
    {
      from: "review",
      to: "plan",
      kind: "loop_back" as const,
      outcomeCode: "request_revision",
    },
    {
      from: "review",
      to: "execute",
      kind: "outcome" as const,
      outcomeCode: "approve",
    },
    { from: "execute", to: "validate", kind: "control" as const },
    { from: "validate", to: "commit", kind: "control" as const },
  ],
};

export function computeWorkflowViewDefinitionSha256(
  view: Pick<WorkflowViewDefinitionShape, "title" | "source" | "nodes" | "edges">,
): string {
  return hashCanonical("workflow-view-definition.v1", {
    title: view.title,
    source: view.source,
    nodes: view.nodes,
    edges: view.edges,
  });
}

/**
 * 当前硬编码Workflow的稳定产品视图。createdAt只记载首次物化时间，不进入语义Hash；
 * Factory内容变化必须同时改变blueprintVersion，历史对象绝不能被覆盖。
 */
export function createLegacyPlanningWorkflowView(createdAt: string): WorkflowViewDefinitionShape {
  // 不能把模块级golden对象的数组引用交给调用方，否则一次意外写入会改变后续Run的图。
  const content = {
    title: LEGACY_PLANNING_VIEW_CONTENT.title,
    source: { ...LEGACY_PLANNING_VIEW_CONTENT.source },
    nodes: LEGACY_PLANNING_VIEW_CONTENT.nodes.map((node) => ({ ...node })),
    edges: LEGACY_PLANNING_VIEW_CONTENT.edges.map((edge) => ({ ...edge })),
  };
  const sha256 = computeWorkflowViewDefinitionSha256(content);
  return {
    schemaVersion: "workflow-view-definition.v1",
    workflowViewDefinitionId: LEGACY_PLANNING_VIEW_ID,
    ...content,
    sha256,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  };
}

/** Schema负责单字段；这里固定跨节点图不变量，避免悬空边或不可达节点进入历史。 */
export function assertWorkflowViewDefinition(view: WorkflowViewDefinitionShape): void {
  const ids = new Set<string>();
  const nodesById = new Map<string, WorkflowViewNodeShape>();
  for (const node of view.nodes) {
    if (ids.has(node.definitionNodeId)) {
      throw new Error(`Workflow View存在重复节点:${node.definitionNodeId}`);
    }
    ids.add(node.definitionNodeId);
    nodesById.set(node.definitionNodeId, node);
  }
  for (const node of view.nodes) {
    if (node.parentDefinitionNodeId !== undefined) {
      const parent = nodesById.get(node.parentDefinitionNodeId);
      if (parent === undefined) {
        throw new Error(`Workflow View节点${node.definitionNodeId}父节点悬空`);
      }
      if (parent.definitionNodeId === node.definitionNodeId || parent.kind !== "composite") {
        throw new Error(`Workflow View节点${node.definitionNodeId}父子结构非法`);
      }

      const ancestors = new Set([node.definitionNodeId]);
      let cursor: WorkflowViewNodeShape | undefined = parent;
      while (cursor !== undefined) {
        if (ancestors.has(cursor.definitionNodeId)) {
          throw new Error(`Workflow View节点${node.definitionNodeId}父子结构成环`);
        }
        ancestors.add(cursor.definitionNodeId);
        cursor =
          cursor.parentDefinitionNodeId === undefined
            ? undefined
            : nodesById.get(cursor.parentDefinitionNodeId);
      }
    }
  }
  const edgeKeys = new Set<string>();
  for (const edge of view.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      throw new Error(`Workflow View边${edge.from}->${edge.to}端点悬空`);
    }
    if (
      (edge.kind === "outcome" || edge.kind === "loop_back") !==
      (edge.outcomeCode !== undefined)
    ) {
      throw new Error(`Workflow View边${edge.from}->${edge.to} outcome语义不完整`);
    }
    const edgeKey = `${edge.from}\u0000${edge.to}\u0000${edge.kind}\u0000${edge.outcomeCode ?? ""}`;
    if (edgeKeys.has(edgeKey)) {
      throw new Error(`Workflow View存在重复边:${edge.from}->${edge.to}`);
    }
    edgeKeys.add(edgeKey);
  }
  if (computeWorkflowViewDefinitionSha256(view) !== view.sha256) {
    throw new Error(`Workflow View ${view.workflowViewDefinitionId} Hash不一致`);
  }

  const topLevelNodes = view.nodes.filter((node) => node.parentDefinitionNodeId === undefined);
  const incoming = new Map<string, number>(topLevelNodes.map((node) => [node.definitionNodeId, 0]));
  for (const edge of view.edges) {
    if (edge.kind !== "loop_back" && incoming.has(edge.to)) {
      incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    }
  }
  const entries = topLevelNodes.filter((node) => incoming.get(node.definitionNodeId) === 0);
  if (entries.length !== 1) {
    throw new Error("Workflow View必须有唯一主入口");
  }

  const childrenByParent = new Map<string, string[]>();
  for (const node of view.nodes) {
    if (node.parentDefinitionNodeId === undefined) continue;
    const children = childrenByParent.get(node.parentDefinitionNodeId) ?? [];
    children.push(node.definitionNodeId);
    childrenByParent.set(node.parentDefinitionNodeId, children);
  }
  const outgoing = new Map<string, string[]>();
  for (const edge of view.edges) {
    if (edge.kind === "loop_back") continue;
    const targets = outgoing.get(edge.from) ?? [];
    targets.push(edge.to);
    outgoing.set(edge.from, targets);
  }
  const reachable = new Set<string>();
  const pending = [entries[0]?.definitionNodeId].filter(
    (value): value is string => value !== undefined,
  );
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || reachable.has(current)) continue;
    reachable.add(current);
    pending.push(...(childrenByParent.get(current) ?? []), ...(outgoing.get(current) ?? []));
  }
  const unreachable = view.nodes.find((node) => !reachable.has(node.definitionNodeId));
  if (unreachable !== undefined) {
    throw new Error(`Workflow View节点${unreachable.definitionNodeId}不可达`);
  }
}
