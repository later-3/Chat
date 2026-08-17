import type { ExecutionTraceDto, PiTraceActivityDto } from "@chat/contracts/public";
import type {
  ConversationNodeContext,
  ConversationNodeDefinition,
  ToolCallBlock,
} from "@deepseek-ai/dsh-client-runtime/client";
import { LIFEOS_EXECUTION_TRACE_EVENT } from "../execution-trace-events.ts";

type PublicStatus =
  | ExecutionTraceDto["run"]["status"]
  | ExecutionTraceDto["workflow"]["nodeRuns"][number]["status"]
  | PiTraceActivityDto["status"]
  | "queued"
  | "running"
  | "retrying"
  | "completed"
  | "waiting"
  | "received"
  | "disposed"
  | "sleeping";

interface BlockInput {
  readonly callId: string;
  readonly name: string;
  readonly status: PublicStatus;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly details: Record<string, string | number | boolean>;
  readonly summary?: string;
  readonly subCalls?: readonly ToolCallBlock[];
  readonly seq: number;
}

function instant(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRunning(status: PublicStatus): boolean {
  return [
    "pending",
    "queued",
    "running",
    "waiting_human",
    "retrying",
    "waiting",
    "received",
    "sleeping",
  ].includes(status);
}

function isError(status: PublicStatus): boolean {
  return ["failed", "cancelled", "outcome_unknown"].includes(status);
}

function block(input: BlockInput): ToolCallBlock {
  const startedAt = instant(input.startedAt);
  const subCalls = input.subCalls ?? [];
  const argsRaw = JSON.stringify(input.details);
  if (isRunning(input.status)) {
    return {
      callId: input.callId,
      name: input.name,
      argsRaw,
      turn: 0,
      step: 0,
      time: startedAt,
      callView: null,
      subCalls,
    };
  }
  const errored = isError(input.status);
  return {
    kind: "tool-result",
    seq: input.seq,
    time: instant(input.completedAt ?? input.startedAt),
    callId: input.callId,
    call: { name: input.name, argsRaw },
    callTime: startedAt,
    content:
      input.summary === undefined || input.summary.trim() === ""
        ? []
        : [{ type: "text", text: input.summary }],
    isError: errored,
    ...(errored ? { error: { name: "ExecutionFailed", code: input.status } } : {}),
    callView: null,
    resultView: null,
    subCalls,
  };
}

function callStart(value: ToolCallBlock): number {
  return "kind" in value ? (value.callTime ?? value.time) : value.time;
}

function ordered(values: readonly ToolCallBlock[]): ToolCallBlock[] {
  return [...values].sort((left, right) => callStart(left) - callStart(right));
}

function activityBlock(
  activity: PiTraceActivityDto,
  children: readonly PiTraceActivityDto[],
  seq: number,
): ToolCallBlock {
  const details: Record<string, string | number | boolean> = {
    kind: activity.kind,
    status: activity.status,
  };
  if (activity.provider !== undefined) details.provider = activity.provider;
  if (activity.model !== undefined) details.model = activity.model;
  if (activity.toolName !== undefined) details.tool = activity.toolName;
  if (activity.tokenUsage !== undefined) {
    details.promptTokens = activity.tokenUsage.promptTokens;
    details.completionTokens = activity.tokenUsage.completionTokens;
    details.totalTokens = activity.tokenUsage.totalTokens;
  }
  if (activity.durationMs !== undefined) details.durationMs = activity.durationMs;
  if (activity.errorCode !== undefined) details.errorCode = activity.errorCode;
  return block({
    callId: `lifeos-${activity.activityKey}`,
    name: activity.label,
    status: activity.status,
    startedAt: activity.startedAt,
    ...(activity.completedAt === undefined ? {} : { completedAt: activity.completedAt }),
    details,
    subCalls: ordered(children.map((child) => activityBlock(child, [], seq))),
    seq,
  });
}

function nodeKind(nodeType: string): PiTraceActivityDto["nodeKind"] | undefined {
  if (nodeType === "agent.plan") return "planner";
  if (nodeType.startsWith("execute.")) return "executor";
  if (nodeType.includes("note") && nodeType.startsWith("agent.")) return "note_capture";
  return undefined;
}

function workflowNodeBlocks(trace: ExecutionTraceDto, seq: number): ToolCallBlock[] {
  const assignments = assignAgents(trace);
  return trace.workflow.nodeRuns.map((node) => {
    const children = (assignments.get(String(node.workflowNodeRunId)) ?? []).map((agent) =>
      activityBlock(
        agent,
        trace.piActivities.filter((activity) => activity.parentActivityKey === agent.activityKey),
        seq,
      ),
    );
    const details: Record<string, string | number | boolean> = {
      nodeType: node.nodeType,
      status: node.status,
      attempt: node.attemptNumber,
    };
    if (node.durationMs !== undefined) details.durationMs = node.durationMs;
    if (node.outcomeCode !== undefined) details.outcome = node.outcomeCode;
    if (node.error !== undefined) details.errorCode = node.error.code;
    return block({
      callId: `lifeos-node-${String(node.workflowNodeRunId)}`,
      name: node.title,
      status: node.status,
      startedAt: node.startedAt ?? node.updatedAt,
      ...(node.finishedAt === undefined ? {} : { completedAt: node.finishedAt }),
      details,
      ...(node.publicSummary === undefined ? {} : { summary: node.publicSummary }),
      subCalls: ordered(children),
      seq,
    });
  });
}

function assignAgents(
  trace: ExecutionTraceDto,
): ReadonlyMap<string, readonly PiTraceActivityDto[]> {
  const assignments = new Map<string, PiTraceActivityDto[]>();
  const agents = trace.piActivities.filter((activity) => activity.kind === "agent");
  for (const agent of agents) {
    const agentStartedAt = instant(agent.startedAt);
    const candidates = trace.workflow.nodeRuns
      .map((node, index) => ({ node, index }))
      .filter(({ node }) => nodeKind(node.nodeType) === agent.nodeKind)
      .map(({ node, index }) => {
        const start = instant(node.startedAt ?? node.updatedAt);
        const end = instant(node.finishedAt ?? node.updatedAt);
        return {
          node,
          index,
          contains:
            agentStartedAt >= Math.min(start, end) && agentStartedAt <= Math.max(start, end),
          duration: Math.abs(end - start),
          distance: Math.abs(agentStartedAt - start),
          // Executor优先落到实际Plan Step，不被外层execute.plan容器吞掉。
          specificity: node.nodeType === "execute.plan_step" ? 0 : 1,
        };
      })
      .sort(
        (left, right) =>
          Number(right.contains) - Number(left.contains) ||
          left.specificity - right.specificity ||
          left.duration - right.duration ||
          left.distance - right.distance ||
          left.index - right.index,
      );
    const selected = candidates[0]?.node;
    if (selected === undefined) continue;
    const key = String(selected.workflowNodeRunId);
    const assigned = assignments.get(key) ?? [];
    assigned.push(agent);
    assignments.set(key, assigned);
  }
  return assignments;
}

function runtimeBlock(trace: ExecutionTraceDto, seq: number): ToolCallBlock | undefined {
  if (trace.runtime.availability !== "available") return undefined;
  const spans = trace.runtime.spans
    .filter((span) => span.kind !== "run")
    .map((span) =>
      block({
        callId: `lifeos-${span.spanKey}`,
        name: span.name,
        status: span.status,
        startedAt: span.startedAt ?? span.createdAt,
        ...(span.completedAt === undefined ? {} : { completedAt: span.completedAt }),
        details: {
          kind: span.kind,
          status: span.status,
          durationMs: span.durationMs,
          ...(span.attempt === undefined ? {} : { attempt: span.attempt }),
        },
        seq,
      }),
    );
  return block({
    callId: "lifeos-vercel-workflow-runtime",
    name: "Vercel Workflow Runtime",
    status: trace.runtime.runtimeStatus,
    startedAt: trace.runtime.startedAt ?? trace.runtime.createdAt,
    ...(trace.runtime.completedAt === undefined ? {} : { completedAt: trace.runtime.completedAt }),
    details: {
      status: trace.runtime.runtimeStatus,
      events: trace.runtime.eventCount,
      durationMs: trace.runtime.durationMs,
      truncated: trace.runtime.truncated,
    },
    subCalls: ordered(spans),
    seq,
  });
}

export function executionTraceRoot(trace: ExecutionTraceDto, seq: number): ToolCallBlock {
  const runtime = runtimeBlock(trace, seq);
  return block({
    callId: `lifeos-workflow-${String(trace.productRunId)}`,
    name: `Chat Workflow · ${trace.workflow.title}`,
    status: trace.run.status,
    startedAt: trace.run.createdAt,
    ...(isRunning(trace.run.status) ? {} : { completedAt: trace.run.updatedAt }),
    details: { status: trace.run.status, phase: trace.run.phase },
    subCalls: ordered([
      ...workflowNodeBlocks(trace, seq),
      ...(runtime === undefined ? [] : [runtime]),
    ]),
    seq,
  });
}

export const executionTraceDefinition: ConversationNodeDefinition<ExecutionTraceDto> = {
  kind: "lifeos-execution-trace",
  target: "trajectory",
  match: (event) =>
    event.type === LIFEOS_EXECUTION_TRACE_EVENT
      ? { id: String(event.data.trace.productRunId), role: event.data.eventKind }
      : null,
  start: (_context, match) => {
    if (match.event.type !== LIFEOS_EXECUTION_TRACE_EVENT) {
      throw new Error("lifeos execution trace start requires its session event");
    }
    return match.event.data.trace;
  },
  update: (context, match) =>
    match.event.type === LIFEOS_EXECUTION_TRACE_EVENT ? match.event.data.trace : context.state,
  buildViewNode: (context: ConversationNodeContext<ExecutionTraceDto>) => {
    const last = context.matches.at(-1);
    if (last === undefined || context.state === undefined) return null;
    return {
      key: context.key,
      kind: context.kind,
      id: context.id,
      target: "trajectory",
      anchorSeq: context.start?.event.seq ?? last.event.seq,
      location: context.start?.location ?? { kind: "unresolved" },
      data: { kind: "tool", root: executionTraceRoot(context.state, last.event.seq) },
    };
  },
};

export function registerExecutionTraceDefinition(ctx: {
  conversationEvents: { register(definition: ConversationNodeDefinition): () => void };
}): () => void {
  return ctx.conversationEvents.register(executionTraceDefinition);
}
