export type WorkflowCallProgressPhase =
  | "reserving_session"
  | "starting_run"
  | "workflow_stage"
  | "agent"
  | "child_tool";

export interface WorkflowCallProgress {
  readonly callId: string;
  readonly workflowId: string;
  readonly workflowInvocationId: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly status: "starting" | "running";
  readonly phase: WorkflowCallProgressPhase;
  readonly stageId?: string;
  readonly agentId?: string;
  readonly childToolName?: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly elapsedMs: number;
}

interface WorkflowCallProgressBase {
  readonly callId: string;
  readonly workflowId: string;
  readonly workflowInvocationId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly startedAt: string;
}

export interface WorkflowCallProgressForwarder {
  readonly stop: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventSummary(value: unknown): Pick<
  WorkflowCallProgress,
  "phase" | "stageId" | "agentId" | "childToolName"
> | undefined {
  if (!isRecord(value) || !isRecord(value.stage) || typeof value.stage.stageId !== "string") {
    return undefined;
  }
  const stageId = value.stage.stageId;
  const agentId = typeof value.stage.agentId === "string" ? value.stage.agentId : undefined;
  if (value.type === "stage_start" || value.type === "review_required") {
    return { phase: "workflow_stage", stageId, ...(agentId === undefined ? {} : { agentId }) };
  }
  if (value.type !== "agent_event" || !isRecord(value.event) || typeof value.event.type !== "string") {
    return undefined;
  }
  if (value.event.type === "agent_start" || value.event.type === "agent_end"
    || value.event.type === "auto_retry_start" || value.event.type === "auto_retry_end") {
    return { phase: "agent", stageId, ...(agentId === undefined ? {} : { agentId }) };
  }
  if ((value.event.type === "tool_execution_start" || value.event.type === "tool_execution_end")
    && typeof value.event.toolName === "string") {
    return {
      phase: "child_tool",
      stageId,
      ...(agentId === undefined ? {} : { agentId }),
      childToolName: value.event.toolName,
    };
  }
  return undefined;
}

/**
 * Bridges only safe lifecycle summaries from a child Run's durable stream.
 * Child messages, thinking, Tool arguments, and Tool results never cross this boundary.
 */
export function forwardWorkflowCallProgress(input: {
  readonly readable: ReadableStream<string>;
  readonly base: WorkflowCallProgressBase;
  readonly onProgress: (progress: WorkflowCallProgress) => void;
  readonly onError?: (error: unknown) => void;
}): WorkflowCallProgressForwarder {
  const reader = input.readable.getReader();
  let stopped = false;
  let buffered = "";

  const publishLine = (line: string) => {
    if (line.trim() === "") return;
    const summary = eventSummary(JSON.parse(line) as unknown);
    if (summary === undefined) return;
    const updatedAt = new Date().toISOString();
    input.onProgress({
      ...input.base,
      status: "running",
      ...summary,
      updatedAt,
      elapsedMs: Math.max(0, Date.parse(updatedAt) - Date.parse(input.base.startedAt)),
    });
  };

  const finished = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += value;
        let newline = buffered.indexOf("\n");
        while (newline !== -1) {
          publishLine(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf("\n");
        }
      }
      publishLine(buffered);
    } catch (error) {
      if (!stopped) input.onError?.(error);
    }
  })();

  return {
    stop: async () => {
      stopped = true;
      await reader.cancel().catch(() => {});
      await finished;
    },
  };
}
