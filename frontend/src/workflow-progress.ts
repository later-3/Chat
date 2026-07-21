import type {
  ProductTraceEvent,
  WorkflowDefinition,
  WorkflowNodeStatus,
} from "./workflow-api";

export interface WorkflowNodeProgress {
  status: WorkflowNodeStatus;
  sequence: number;
  details: Record<string, unknown> | null;
}

export type WorkflowProgress = Record<string, WorkflowNodeProgress>;

export interface ExecutorActivity {
  executor_id?: unknown;
  status?: unknown;
  details?: unknown;
}

export function emptyWorkflowProgress(definition: WorkflowDefinition): WorkflowProgress {
  return Object.fromEntries(
    definition.nodes.map((node) => [
      node.id,
      { status: "idle" as const, sequence: 0, details: null },
    ]),
  );
}

export function applyExecutorActivity(
  progress: WorkflowProgress,
  activity: ExecutorActivity,
  sequence: number,
): WorkflowProgress {
  const executorId = typeof activity.executor_id === "string" ? activity.executor_id : null;
  const status = activity.status;
  if (
    !executorId ||
    !(executorId in progress) ||
    !["in_progress", "completed", "failed"].includes(String(status))
  ) {
    return progress;
  }
  const current = progress[executorId];
  if (sequence < current.sequence) return progress;
  const details =
    activity.details && typeof activity.details === "object"
      ? (activity.details as Record<string, unknown>)
      : null;
  return {
    ...progress,
    [executorId]: {
      status: status as WorkflowNodeStatus,
      sequence,
      details,
    },
  };
}

export function progressFromTrace(
  definition: WorkflowDefinition,
  trace: ProductTraceEvent[],
): WorkflowProgress {
  return trace.reduce(
    (progress, event) =>
      event.event_type === "workflow.node"
        ? applyExecutorActivity(progress, event.payload, event.sequence)
        : progress,
    emptyWorkflowProgress(definition),
  );
}
