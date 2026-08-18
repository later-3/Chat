import { TRACE_EVENT_NAMES, type ProductSnapshot, type WorkflowNodeRun } from "@chat/contracts";
import type { ApplicationDeps } from "./deps.js";
import { emitRunEvent } from "./trace-helpers.js";

/** 浏览器轨迹只公开Memory节点状态与计数摘要，不公开查询正文、快照正文或Provider载荷。 */
export function emitWorkflowMemoryNodeTrace(
  deps: ApplicationDeps,
  snapshot: ProductSnapshot,
  node: WorkflowNodeRun,
): void {
  if (node.nodeType !== "memory.query" && node.nodeType !== "memory.write") return;
  const attempt = Object.values(snapshot.entities.attempts).find(
    (candidate) => candidate.productRunId === node.productRunId && candidate.kind === "workflow",
  );
  if (attempt === undefined) return;
  const base = {
    productRunId: node.productRunId,
    attemptId: attempt.attemptId,
    workflowNodeRunId: node.workflowNodeRunId,
    definitionNodeId: node.definitionNodeId,
    nodeType: node.nodeType,
    ...(node.publicSummary !== undefined ? { publicSummary: node.publicSummary } : {}),
    ...(node.durationMs !== undefined ? { durationMs: node.durationMs } : {}),
  };
  if (node.status === "running") {
    emitRunEvent(deps, node.productRunId, {
      ...base,
      level: "info",
      eventName: TRACE_EVENT_NAMES.workflowMemoryNodeStarted,
      outcome: "unknown",
    });
  } else if (node.status === "succeeded" || node.status === "skipped") {
    emitRunEvent(deps, node.productRunId, {
      ...base,
      level: "info",
      eventName: TRACE_EVENT_NAMES.workflowMemoryNodeCompleted,
      outcome: "success",
      outcomeCode: node.outcomeCode ?? node.status,
    });
  } else if (node.status === "failed") {
    const code = node.outcomeCode ?? "memory.node_failed";
    emitRunEvent(deps, node.productRunId, {
      ...base,
      level: "warn",
      eventName: TRACE_EVENT_NAMES.workflowMemoryNodeFailed,
      outcome: "failure",
      outcomeCode: code,
      error: { code, type: "WorkflowMemoryNodeError" },
    });
  } else if (node.status === "outcome_unknown") {
    const code = node.outcomeCode ?? "memory.outcome_unknown";
    emitRunEvent(deps, node.productRunId, {
      ...base,
      level: "warn",
      eventName: TRACE_EVENT_NAMES.workflowMemoryNodeOutcomeUnknown,
      outcome: "unknown",
      outcomeCode: code,
      error: { code, type: "WorkflowMemoryNodeError" },
    });
  }
}
