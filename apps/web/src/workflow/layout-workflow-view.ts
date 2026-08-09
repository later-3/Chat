import type {
  WorkflowDefinitionNodeDto,
  WorkflowNodeRunSummaryDto,
  WorkflowRunViewDto,
} from "@chat/contracts/public";

export type WorkflowViewportClass = "desktop" | "compact";

export interface WorkflowLayoutNode {
  readonly id: string;
  readonly definitionNode: WorkflowDefinitionNodeDto;
  readonly nodeRun?: WorkflowNodeRunSummaryDto;
  readonly position: { readonly x: number; readonly y: number };
  readonly size: { readonly width: number; readonly height: number };
  readonly depth: number;
  readonly hasChildren: boolean;
}

export interface WorkflowLayoutEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: "control" | "outcome" | "loop_back" | "child";
  readonly outcomeCode?: string;
}

export interface WorkflowLayout {
  readonly nodes: readonly WorkflowLayoutNode[];
  readonly edges: readonly WorkflowLayoutEdge[];
  readonly width: number;
  readonly height: number;
}

export interface LinearWorkflowItem {
  readonly id: string;
  readonly definitionNode: WorkflowDefinitionNodeDto;
  readonly nodeRun?: WorkflowNodeRunSummaryDto;
  readonly depth: number;
  readonly hasChildren: boolean;
}

export class WorkflowLayoutError extends Error {
  constructor(readonly code: "duplicate_node" | "dangling_edge" | "cycle_without_loop_edge") {
    super(code);
    this.name = "WorkflowLayoutError";
  }
}

const DIMENSIONS: Record<
  WorkflowViewportClass,
  {
    readonly width: number;
    readonly height: number;
    readonly columnGap: number;
    readonly rowGap: number;
    readonly inset: number;
  }
> = {
  desktop: { width: 224, height: 120, columnGap: 104, rowGap: 48, inset: 32 },
  compact: { width: 196, height: 112, columnGap: 72, rowGap: 40, inset: 24 },
};

function executionPathKey(nodeRun: WorkflowNodeRunSummaryDto): string {
  return [
    ...nodeRun.executionPath.map(
      (segment) => `${segment.containerNodeId}:${String(segment.iteration).padStart(3, "0")}`,
    ),
    `attempt:${String(nodeRun.attemptNumber).padStart(3, "0")}`,
    nodeRun.workflowNodeRunId,
  ].join("/");
}

function assertGraph(view: WorkflowRunViewDto): ReadonlyMap<string, number> {
  const order = new Map<string, number>();
  for (const [index, node] of view.definitionNodes.entries()) {
    if (order.has(node.definitionNodeId)) throw new WorkflowLayoutError("duplicate_node");
    order.set(node.definitionNodeId, index);
  }
  for (const edge of view.edges) {
    if (!order.has(edge.from) || !order.has(edge.to)) {
      throw new WorkflowLayoutError("dangling_edge");
    }
  }
  return order;
}

/**
 * 对Definition做稳定拓扑排序。loop_back是已经声明的有界循环语义，不参与DAG排序；
 * 其余边若仍成环则DTO结构损坏，前端必须失败关闭，不能自行删边“修好”图。
 */
function topologicalDefinitions(
  view: WorkflowRunViewDto,
  definitionOrder: ReadonlyMap<string, number>,
): readonly WorkflowDefinitionNodeDto[] {
  const indegree = new Map(view.definitionNodes.map((node) => [node.definitionNodeId, 0]));
  const outgoing = new Map(
    view.definitionNodes.map((node) => [
      node.definitionNodeId,
      [] as WorkflowDefinitionNodeDto["definitionNodeId"][],
    ]),
  );
  for (const edge of view.edges) {
    if (edge.kind === "loop_back") continue;
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const ready = view.definitionNodes
    .filter((node) => indegree.get(node.definitionNodeId) === 0)
    .sort(
      (left, right) =>
        (definitionOrder.get(left.definitionNodeId) ?? 0) -
        (definitionOrder.get(right.definitionNodeId) ?? 0),
    );
  const result: WorkflowDefinitionNodeDto[] = [];
  while (ready.length > 0) {
    const current = ready.shift();
    if (current === undefined) break;
    result.push(current);
    for (const nextId of outgoing.get(current.definitionNodeId) ?? []) {
      const nextIndegree = (indegree.get(nextId) ?? 0) - 1;
      indegree.set(nextId, nextIndegree);
      if (nextIndegree === 0) {
        const next = view.definitionNodes[definitionOrder.get(nextId) ?? -1];
        if (next !== undefined) {
          ready.push(next);
          ready.sort(
            (left, right) =>
              (definitionOrder.get(left.definitionNodeId) ?? 0) -
              (definitionOrder.get(right.definitionNodeId) ?? 0),
          );
        }
      }
    }
  }
  if (result.length !== view.definitionNodes.length) {
    throw new WorkflowLayoutError("cycle_without_loop_edge");
  }
  return result;
}

function definitionRanks(
  view: WorkflowRunViewDto,
  orderedDefinitions: readonly WorkflowDefinitionNodeDto[],
): ReadonlyMap<string, number> {
  const ranks = new Map<string, number>();
  for (const node of orderedDefinitions) {
    const incoming = view.edges.filter(
      (edge) => edge.kind !== "loop_back" && edge.to === node.definitionNodeId,
    );
    ranks.set(
      node.definitionNodeId,
      incoming.reduce((rank, edge) => Math.max(rank, (ranks.get(edge.from) ?? -1) + 1), 0),
    );
  }
  return ranks;
}

function visibleRuns(
  view: WorkflowRunViewDto,
  collapsedParentNodeRunIds: ReadonlySet<string>,
): readonly WorkflowNodeRunSummaryDto[] {
  const byId = new Map(view.nodeRuns.map((nodeRun) => [nodeRun.workflowNodeRunId, nodeRun]));
  return view.nodeRuns.filter((nodeRun) => {
    let parentId = nodeRun.parentNodeRunId;
    const visited = new Set<string>();
    while (parentId !== undefined) {
      if (collapsedParentNodeRunIds.has(parentId)) return false;
      if (visited.has(parentId)) throw new WorkflowLayoutError("cycle_without_loop_edge");
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentNodeRunId;
    }
    return true;
  });
}

function depthOf(
  nodeRun: WorkflowNodeRunSummaryDto | undefined,
  byRunId: ReadonlyMap<string, WorkflowNodeRunSummaryDto>,
): number {
  let depth = 0;
  let parentId = nodeRun?.parentNodeRunId;
  const visited = new Set<string>();
  while (parentId !== undefined && !visited.has(parentId)) {
    visited.add(parentId);
    depth += 1;
    parentId = byRunId.get(parentId)?.parentNodeRunId;
  }
  return depth;
}

function createDisplayItems(
  view: WorkflowRunViewDto,
  orderedDefinitions: readonly WorkflowDefinitionNodeDto[],
  collapsedParentNodeRunIds: ReadonlySet<string>,
): readonly Omit<WorkflowLayoutNode, "position" | "size">[] {
  const visible = visibleRuns(view, collapsedParentNodeRunIds);
  const byRunId = new Map(view.nodeRuns.map((nodeRun) => [nodeRun.workflowNodeRunId, nodeRun]));
  const children = new Set(
    view.nodeRuns.flatMap((nodeRun) =>
      nodeRun.parentNodeRunId === undefined ? [] : [nodeRun.parentNodeRunId],
    ),
  );
  const items: Omit<WorkflowLayoutNode, "position" | "size">[] = [];
  for (const definition of orderedDefinitions) {
    const runs = visible
      .filter((nodeRun) => nodeRun.definitionNodeId === definition.definitionNodeId)
      .sort((left, right) => executionPathKey(left).localeCompare(executionPathKey(right)));
    if (runs.length === 0) {
      items.push({
        id: `definition:${definition.definitionNodeId}`,
        definitionNode: definition,
        depth: 0,
        hasChildren: false,
      });
      continue;
    }
    for (const nodeRun of runs) {
      items.push({
        id: nodeRun.workflowNodeRunId,
        definitionNode: definition,
        nodeRun,
        depth: depthOf(nodeRun, byRunId),
        hasChildren: children.has(nodeRun.workflowNodeRunId),
      });
    }
  }
  return items;
}

function pairSemanticEdge(
  sourceItems: readonly WorkflowLayoutNode[],
  targetItems: readonly WorkflowLayoutNode[],
  kind: "control" | "outcome" | "loop_back",
): readonly { readonly source: string; readonly target: string }[] {
  if (sourceItems.length === 0 || targetItems.length === 0) return [];
  if (kind === "loop_back") {
    const pairs: { source: string; target: string }[] = [];
    for (const source of sourceItems) {
      const sourceIteration = source.nodeRun?.executionPath.at(-1)?.iteration;
      const next = targetItems.find(
        (target) => target.nodeRun?.executionPath.at(-1)?.iteration === (sourceIteration ?? 0) + 1,
      );
      if (next !== undefined) pairs.push({ source: source.id, target: next.id });
    }
    return pairs.length > 0
      ? pairs
      : [{ source: sourceItems.at(-1)?.id ?? "", target: targetItems[0]?.id ?? "" }];
  }
  const pairs: { source: string; target: string }[] = [];
  for (const source of sourceItems) {
    const sourceIteration = source.nodeRun?.executionPath.at(-1)?.iteration;
    const sameIteration = targetItems.find(
      (target) => target.nodeRun?.executionPath.at(-1)?.iteration === sourceIteration,
    );
    if (sameIteration !== undefined && sourceIteration !== undefined) {
      pairs.push({ source: source.id, target: sameIteration.id });
    }
  }
  return pairs.length > 0
    ? pairs
    : [{ source: sourceItems.at(-1)?.id ?? "", target: targetItems[0]?.id ?? "" }];
}

function createLayoutEdges(
  view: WorkflowRunViewDto,
  nodes: readonly WorkflowLayoutNode[],
): readonly WorkflowLayoutEdge[] {
  const edges: WorkflowLayoutEdge[] = [];
  for (const [index, semanticEdge] of view.edges.entries()) {
    const sources = nodes.filter(
      (node) => node.definitionNode.definitionNodeId === semanticEdge.from && node.depth === 0,
    );
    const targets = nodes.filter(
      (node) => node.definitionNode.definitionNodeId === semanticEdge.to && node.depth === 0,
    );
    for (const [pairIndex, pair] of pairSemanticEdge(
      sources,
      targets,
      semanticEdge.kind,
    ).entries()) {
      if (pair.source === "" || pair.target === "") continue;
      edges.push({
        id: `semantic:${String(index)}:${String(pairIndex)}:${pair.source}:${pair.target}`,
        source: pair.source,
        target: pair.target,
        kind: semanticEdge.kind,
        ...(semanticEdge.outcomeCode !== undefined
          ? { outcomeCode: semanticEdge.outcomeCode }
          : {}),
      });
    }
  }
  const childrenByParent = new Map<string, WorkflowLayoutNode[]>();
  for (const node of nodes) {
    const parentId = node.nodeRun?.parentNodeRunId;
    if (parentId === undefined) continue;
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(node);
    childrenByParent.set(parentId, siblings);
  }
  for (const [parentId, children] of childrenByParent) {
    children.sort((left, right) => left.id.localeCompare(right.id));
    for (const [index, child] of children.entries()) {
      edges.push({
        id: `child:${parentId}:${String(index)}:${child.id}`,
        source: index === 0 ? parentId : (children[index - 1]?.id ?? parentId),
        target: child.id,
        kind: "child",
      });
    }
  }
  return edges;
}

/**
 * Workflow View的确定性LR布局。position只属于浏览器展示：函数输入不含status文案，
 * 同一结构Hash与viewport class会得到相同坐标，绝不回写Definition或Product Store。
 */
export function layoutWorkflowView(
  view: WorkflowRunViewDto,
  viewportClass: WorkflowViewportClass,
  collapsedParentNodeRunIds: ReadonlySet<string> = new Set(),
): WorkflowLayout {
  const definitionOrder = assertGraph(view);
  const orderedDefinitions = topologicalDefinitions(view, definitionOrder);
  const ranks = definitionRanks(view, orderedDefinitions);
  const metrics = DIMENSIONS[viewportClass];
  const displayItems = createDisplayItems(view, orderedDefinitions, collapsedParentNodeRunIds);
  const displayOrder = new Map(displayItems.map((item, index) => [item.id, index]));
  const outcomeLane = new Map(
    view.definitionNodes.map((node) => {
      const outcomes = view.edges
        .filter(
          (edge) =>
            edge.kind === "outcome" &&
            edge.to === node.definitionNodeId &&
            edge.outcomeCode !== undefined,
        )
        .map((edge) => edge.outcomeCode ?? "")
        .sort();
      return [node.definitionNodeId, outcomes[0] ?? ""] as const;
    }),
  );
  const rowOrder = [...displayItems].sort((left, right) => {
    const leftRank = ranks.get(left.definitionNode.definitionNodeId) ?? 0;
    const rightRank = ranks.get(right.definitionNode.definitionNodeId) ?? 0;
    if (leftRank !== rightRank) return leftRank - rightRank;
    const outcome = (outcomeLane.get(left.definitionNode.definitionNodeId) ?? "").localeCompare(
      outcomeLane.get(right.definitionNode.definitionNodeId) ?? "",
    );
    return outcome !== 0
      ? outcome
      : (displayOrder.get(left.id) ?? 0) - (displayOrder.get(right.id) ?? 0);
  });
  const rowByRank = new Map<number, number>();
  const rowById = new Map<string, number>();
  for (const item of rowOrder) {
    const rank = ranks.get(item.definitionNode.definitionNodeId) ?? 0;
    const row = rowByRank.get(rank) ?? 0;
    rowByRank.set(rank, row + 1);
    rowById.set(item.id, row);
  }
  const nodes = displayItems.map<WorkflowLayoutNode>((item) => {
    const rank = ranks.get(item.definitionNode.definitionNodeId) ?? 0;
    const row = rowById.get(item.id) ?? 0;
    return {
      ...item,
      position: {
        x: metrics.inset + rank * (metrics.width + metrics.columnGap) + item.depth * metrics.inset,
        y: metrics.inset + row * (metrics.height + metrics.rowGap),
      },
      size: { width: metrics.width, height: metrics.height },
    };
  });
  const maxRank = Math.max(0, ...ranks.values());
  const maxRows = Math.max(1, ...rowByRank.values());
  return {
    nodes,
    edges: createLayoutEdges(view, nodes),
    width: metrics.inset * 2 + (maxRank + 1) * metrics.width + maxRank * metrics.columnGap,
    height: metrics.inset * 2 + maxRows * metrics.height + (maxRows - 1) * metrics.rowGap,
  };
}

/** 顺序列表与Canvas消费同一拓扑顺序，作为手机、键盘和无Canvas的等价路径。 */
export function linearizedWorkflowView(
  view: WorkflowRunViewDto,
  collapsedParentNodeRunIds: ReadonlySet<string> = new Set(),
): readonly LinearWorkflowItem[] {
  const definitionOrder = assertGraph(view);
  const orderedDefinitions = topologicalDefinitions(view, definitionOrder);
  return createDisplayItems(view, orderedDefinitions, collapsedParentNodeRunIds).map((item) => ({
    id: item.id,
    definitionNode: item.definitionNode,
    ...(item.nodeRun !== undefined ? { nodeRun: item.nodeRun } : {}),
    depth: item.depth,
    hasChildren: item.hasChildren,
  }));
}

/** 状态刷新不改变该签名；只有结构、实例或层级变化才触发布局重算提示。 */
export function workflowStructureSignature(view: WorkflowRunViewDto): string {
  return [
    view.viewHash,
    ...view.nodeRuns
      .map(
        (nodeRun) =>
          `${nodeRun.workflowNodeRunId}:${nodeRun.definitionNodeId}:${nodeRun.parentNodeRunId ?? "root"}:${executionPathKey(nodeRun)}`,
      )
      .sort(),
  ].join("|");
}
