import { nodeContentFromTrace, progressFromTrace } from "../../workflow-progress.js";
import type {
  ProductTraceEvent,
  WorkflowDefinition,
  WorkflowEdgeDefinition,
} from "./workflow-api.js";

export interface WorkflowRouteOption {
  branchId: string;
  label: string;
  target: string;
  condition: string;
  actual: unknown;
  matched: boolean | null;
  selected: boolean;
  reason: string;
}

export interface WorkflowRouteDecision {
  nodeId: string;
  decisionKind: string;
  selectionMode: string;
  selectedBranch: string;
  selectedTarget: string;
  selectionReason: string;
  facts: Record<string, unknown>;
  options: WorkflowRouteOption[];
  evidence: "persisted_evaluation" | "legacy_trace";
}

export interface WorkflowPathNode {
  id: string;
  label: string;
  kind: string;
  sequence: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseRouteOption(value: unknown): WorkflowRouteOption | null {
  if (!isRecord(value)) return null;
  const branchId = readString(value.branch_id);
  const label = readString(value.label);
  const target = readString(value.target);
  const condition = readString(value.condition);
  const reason = readString(value.reason);
  if (!branchId || !label || !target || !condition || !reason) return null;
  return {
    branchId,
    label,
    target,
    condition,
    actual: value.actual,
    matched: typeof value.matched === "boolean" ? value.matched : null,
    selected: value.selected === true,
    reason,
  };
}

function parsePersistedDecision(nodeId: string, value: unknown): WorkflowRouteDecision | null {
  if (!isRecord(value) || !Array.isArray(value.options)) return null;
  const options = value.options.map(parseRouteOption);
  if (options.some((option) => option === null)) return null;
  const selectedBranch = readString(value.selected_branch);
  const selectedTarget = readString(value.selected_target);
  const selectionReason = readString(value.selection_reason);
  if (!selectedBranch || !selectedTarget || !selectionReason) return null;
  return {
    nodeId,
    decisionKind: readString(value.decision_kind) ?? "switch_case",
    selectionMode: readString(value.selection_mode) ?? "first_match",
    selectedBranch,
    selectedTarget,
    selectionReason,
    facts: isRecord(value.facts) ? value.facts : {},
    options: options as WorkflowRouteOption[],
    evidence: "persisted_evaluation",
  };
}

function actualForLegacyEdge(
  edge: WorkflowEdgeDefinition,
  publicInput: Record<string, unknown>,
  publicOutput: Record<string, unknown>,
): unknown {
  const condition = edge.condition ?? "";
  if (condition.includes("query_kind")) return publicInput.query_kind ?? "未设置";
  if (condition.includes("scenario"))
    return publicInput.scenario ?? publicOutput.scenario ?? "未设置";
  if (condition.includes("needs_plan")) return publicInput.needs_plan ?? "未设置";
  if (condition.includes("Default")) return true;
  return "旧Trace未记录";
}

function legacyDecision(
  definition: WorkflowDefinition,
  nodeId: string,
  publicInput: unknown,
  publicOutput: Record<string, unknown>,
): WorkflowRouteDecision | null {
  const selectedBranch = readString(publicOutput.branch);
  if (!selectedBranch) return null;
  const edges = definition.edges.filter((edge) => edge.source === nodeId);
  const selectedEdge = edges.find((edge) => edge.branch_id === selectedBranch);
  if (!selectedEdge) return null;
  const input = isRecord(publicInput) ? publicInput : {};
  const options = edges.map((edge) => {
    const selected = edge === selectedEdge;
    return {
      branchId: edge.branch_id ?? edge.target,
      label: edge.label ?? edge.target,
      target: edge.target,
      condition: edge.condition ?? "无条件",
      actual: actualForLegacyEdge(edge, input, publicOutput),
      matched: selected ? true : null,
      selected,
      reason: selected
        ? "旧版Trace保存了最终分支；当前视图按同版本Workflow Definition还原目标边。"
        : "本轮没有走这条边；旧版Trace未逐项保存该条件的求值结果。",
    } satisfies WorkflowRouteOption;
  });
  return {
    nodeId,
    decisionKind: "maf_switch_case",
    selectionMode: "first_match",
    selectedBranch,
    selectedTarget: selectedEdge.target,
    selectionReason:
      "这是旧版Trace：最终分支有持久事实，逐项条件说明使用同版本Definition兼容显示。",
    facts: {
      "intent.query_kind": input.query_kind ?? "未设置",
      "state.scenario": input.scenario ?? publicOutput.scenario ?? "未设置",
      "needs_plan(state)": input.needs_plan ?? "未设置",
    },
    options,
    evidence: "legacy_trace",
  };
}

export function routeDecisionsFromTrace(
  definition: WorkflowDefinition,
  trace: ProductTraceEvent[],
): WorkflowRouteDecision[] {
  const contents = nodeContentFromTrace(definition, trace);
  return definition.nodes.flatMap((node) => {
    const outgoing = definition.edges.filter((edge) => edge.source === node.id);
    if (node.kind !== "decision" && outgoing.length < 2) return [];
    const content = contents[node.id];
    if (!content || !isRecord(content.publicOutput)) return [];
    const persisted = parsePersistedDecision(node.id, content.publicOutput.route_decision);
    return [
      persisted ?? legacyDecision(definition, node.id, content.publicInput, content.publicOutput),
    ].filter((value): value is WorkflowRouteDecision => value !== null);
  });
}

function reachableNodeIds(definition: WorkflowDefinition, start: string): Set<string> {
  const result = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId || result.has(nodeId)) continue;
    result.add(nodeId);
    for (const edge of definition.edges) {
      if (edge.source === nodeId && !result.has(edge.target)) queue.push(edge.target);
    }
  }
  return result;
}

export function unselectedBranchNodeIds(
  definition: WorkflowDefinition,
  trace: ProductTraceEvent[],
  decisions: WorkflowRouteDecision[],
): Set<string> {
  const progress = progressFromTrace(definition, trace);
  const executed = new Set(
    Object.entries(progress)
      .filter(([, value]) => value.status !== "idle")
      .map(([nodeId]) => nodeId),
  );
  const result = new Set<string>();
  for (const decision of decisions) {
    const selectedReachable = reachableNodeIds(definition, decision.selectedTarget);
    for (const option of decision.options) {
      if (option.selected) continue;
      for (const nodeId of reachableNodeIds(definition, option.target)) {
        if (!executed.has(nodeId) && !selectedReachable.has(nodeId)) result.add(nodeId);
      }
    }
  }
  return result;
}

export function actualWorkflowPath(
  definition: WorkflowDefinition,
  trace: ProductTraceEvent[],
): WorkflowPathNode[] {
  const progress = progressFromTrace(definition, trace);
  return definition.nodes
    .flatMap((node) => {
      const nodeProgress = progress[node.id];
      if (!nodeProgress || nodeProgress.status === "idle") return [];
      return [{ id: node.id, label: node.label, kind: node.kind, sequence: nodeProgress.sequence }];
    })
    .sort((left, right) => left.sequence - right.sequence);
}
