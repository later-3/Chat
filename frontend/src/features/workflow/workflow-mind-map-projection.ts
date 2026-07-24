import type { ProductTraceEvent, WorkflowDefinition } from "./workflow-api.js";
import {
  actualWorkflowPath,
  routeDecisionsFromTrace,
  type WorkflowPathNode,
  type WorkflowRouteDecision,
} from "./workflow-route-projection.js";

export interface MindMapProjection {
  decision: WorkflowRouteDecision | null;
  decisionNode: WorkflowPathNode | null;
  beforeDecision: WorkflowPathNode[];
  afterSelectedTarget: WorkflowPathNode[];
}

/**
 * Projects the persisted Trace onto a compact mind-map layout without inventing
 * nodes. The selected target remains in the branch column, while subsequent
 * executed nodes form the downstream column.
 */
export function buildMindMapProjection(
  workflow: WorkflowDefinition,
  trace: ProductTraceEvent[],
): MindMapProjection {
  const path = actualWorkflowPath(workflow, trace);
  const decision = routeDecisionsFromTrace(workflow, trace)[0] ?? null;
  if (!decision) {
    return {
      decision: null,
      decisionNode: null,
      beforeDecision: path,
      afterSelectedTarget: [],
    };
  }
  const decisionIndex = path.findIndex((node) => node.id === decision.nodeId);
  const selectedTargetIndex = path.findIndex(
    (node, index) => index > decisionIndex && node.id === decision.selectedTarget,
  );
  return {
    decision,
    decisionNode: decisionIndex >= 0 ? path[decisionIndex] : null,
    beforeDecision: decisionIndex >= 0 ? path.slice(0, decisionIndex) : path,
    afterSelectedTarget:
      selectedTargetIndex >= 0
        ? path.slice(selectedTargetIndex + 1)
        : decisionIndex >= 0
          ? path.slice(decisionIndex + 1)
          : [],
  };
}
