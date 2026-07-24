import type { ProductTraceEvent, WorkflowDefinition, WorkflowNodeStatus } from "./workflow-api.js";

export interface WorkflowNodeProgress {
  status: WorkflowNodeStatus;
  sequence: number;
  details: Record<string, unknown> | null;
}

export interface WorkflowNodeContent {
  actor: string | null;
  contentType: string | null;
  publicInput: unknown;
  publicOutput: unknown;
  occurredAt: string;
  sequence: number;
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
    !["in_progress", "waiting_approval", "completed", "failed", "abandoned", "skipped"].includes(
      String(status),
    )
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

export function nodeContentFromTrace(
  definition: WorkflowDefinition,
  trace: ProductTraceEvent[],
): Record<string, WorkflowNodeContent | null> {
  const result = Object.fromEntries(definition.nodes.map((node) => [node.id, null])) as Record<
    string,
    WorkflowNodeContent | null
  >;
  for (const event of trace) {
    if (event.event_type !== "workflow.node.content") continue;
    const executorId = event.payload.executor_id;
    if (typeof executorId !== "string" || !(executorId in result)) continue;
    result[executorId] = {
      actor: typeof event.payload.actor === "string" ? event.payload.actor : null,
      contentType:
        typeof event.payload.content_type === "string" ? event.payload.content_type : null,
      publicInput: event.payload.public_input,
      publicOutput: event.payload.public_output,
      occurredAt: event.created_at,
      sequence: event.sequence,
    };
  }
  return result;
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
