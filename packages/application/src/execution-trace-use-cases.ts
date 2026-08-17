import {
  EXECUTION_TRACE_SCHEMA_VERSION,
  TRACE_EVENT_NAMES,
  WORKFLOW_RUNTIME_TRACE_SCHEMA_VERSION,
  executionTraceDtoSchema,
  type ExecutionTraceDto,
  type PiTraceActivityDto,
  type PrincipalId,
  type ProductRunId,
  type TraceEvent,
  type WorkflowRuntimeTraceDto,
} from "@chat/contracts";
import { hashCanonical } from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import { getProductRun } from "./query-use-cases.js";
import { getWorkflowRunView } from "./workflow-query-use-cases.js";

interface MutableActivity {
  activityKey: PiTraceActivityDto["activityKey"];
  parentActivityKey?: PiTraceActivityDto["activityKey"];
  sequence: number;
  kind: PiTraceActivityDto["kind"];
  label: string;
  status: PiTraceActivityDto["status"];
  nodeKind: PiTraceActivityDto["nodeKind"];
  toolName?: string;
  provider?: string;
  model?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  tokenUsage?: PiTraceActivityDto["tokenUsage"];
  errorCode?: string;
}

const AGENT_LABELS: Record<PiTraceActivityDto["nodeKind"], string> = {
  planner: "规划 Agent",
  executor: "执行 Agent",
  note_capture: "笔记捕获 Agent",
};

function roundedDuration(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.max(0, Math.round(value));
}

/**
 * Pi Agent原始事件按Attempt聚合为Agent -> Model/Tool两层公开活动。
 * 只复制严格合同白名单字段，不读取参数、结果、Prompt或Provider响应正文。
 */
export function projectPiActivities(events: readonly TraceEvent[]): PiTraceActivityDto[] {
  const activities: MutableActivity[] = [];
  const agents = new Map<string, MutableActivity>();
  const tools = new Map<string, MutableActivity>();
  const openModels = new Map<string, MutableActivity[]>();
  const counters = { agent: 0, model: 0, tool: 0 };
  let sequence = 0;

  const nextKey = (kind: keyof typeof counters): PiTraceActivityDto["activityKey"] => {
    counters[kind] += 1;
    return `pi-${kind}-${String(counters[kind])}` as PiTraceActivityDto["activityKey"];
  };
  const ensureAgent = (
    event: Extract<
      TraceEvent,
      {
        eventName:
          | typeof TRACE_EVENT_NAMES.piNodeStarted
          | typeof TRACE_EVENT_NAMES.piNodeCompleted
          | typeof TRACE_EVENT_NAMES.piNodeFailed
          | typeof TRACE_EVENT_NAMES.piToolStarted
          | typeof TRACE_EVENT_NAMES.piToolCompleted
          | typeof TRACE_EVENT_NAMES.piToolFailed;
      }
    >,
  ): MutableActivity => {
    const identity = `${event.attemptId}:${event.nodeKind}`;
    const existing = agents.get(identity);
    if (existing !== undefined) return existing;
    const activity: MutableActivity = {
      activityKey: nextKey("agent"),
      sequence: ++sequence,
      kind: "agent",
      label: AGENT_LABELS[event.nodeKind],
      status: "running",
      nodeKind: event.nodeKind,
      startedAt: event.timestamp,
    };
    agents.set(identity, activity);
    activities.push(activity);
    return activity;
  };

  for (const event of events) {
    switch (event.eventName) {
      case TRACE_EVENT_NAMES.piNodeStarted: {
        ensureAgent(event);
        break;
      }
      case TRACE_EVENT_NAMES.piNodeCompleted:
      case TRACE_EVENT_NAMES.piNodeFailed: {
        const activity = ensureAgent(event);
        activity.status =
          event.eventName === TRACE_EVENT_NAMES.piNodeCompleted ? "succeeded" : "failed";
        activity.completedAt = event.timestamp;
        const durationMs = roundedDuration(event.durationMs);
        if (durationMs !== undefined) activity.durationMs = durationMs;
        if (event.eventName === TRACE_EVENT_NAMES.piNodeFailed)
          activity.errorCode = event.error.code;
        break;
      }
      case TRACE_EVENT_NAMES.providerRequestStarted: {
        const parent =
          agents.get(`${event.attemptId}:planner`) ??
          agents.get(`${event.attemptId}:executor`) ??
          agents.get(`${event.attemptId}:note_capture`);
        // Provider事件理论上位于pi.node.started之后；若旧Trace缺少父事件则不伪造Agent。
        if (parent === undefined) break;
        const activity: MutableActivity = {
          activityKey: nextKey("model"),
          parentActivityKey: parent.activityKey,
          sequence: ++sequence,
          kind: "model",
          label: `模型调用：${event.provider}/${event.model}`,
          status: "running",
          nodeKind: parent.nodeKind,
          provider: event.provider,
          model: event.model,
          startedAt: event.timestamp,
        };
        const list = openModels.get(event.attemptId) ?? [];
        list.push(activity);
        openModels.set(event.attemptId, list);
        activities.push(activity);
        break;
      }
      case TRACE_EVENT_NAMES.providerRequestCompleted:
      case TRACE_EVENT_NAMES.providerRequestFailed: {
        const activity = openModels
          .get(event.attemptId)
          ?.find((candidate) => candidate.status === "running");
        if (activity === undefined) break;
        activity.status =
          event.eventName === TRACE_EVENT_NAMES.providerRequestCompleted ? "succeeded" : "failed";
        activity.completedAt = event.timestamp;
        const durationMs = roundedDuration(event.durationMs);
        if (durationMs !== undefined) activity.durationMs = durationMs;
        if (event.eventName === TRACE_EVENT_NAMES.providerRequestCompleted)
          activity.tokenUsage = event.tokenUsage;
        else activity.errorCode = event.error.code;
        break;
      }
      case TRACE_EVENT_NAMES.piToolStarted: {
        const parent = ensureAgent(event);
        const identity = `${event.attemptId}:${event.toolActivityId}`;
        if (tools.has(identity)) break;
        const activity: MutableActivity = {
          activityKey: nextKey("tool"),
          parentActivityKey: parent.activityKey,
          sequence: ++sequence,
          kind: "tool",
          label: `工具：${event.toolName}`,
          status: "running",
          nodeKind: event.nodeKind,
          toolName: event.toolName,
          startedAt: event.timestamp,
        };
        tools.set(identity, activity);
        activities.push(activity);
        break;
      }
      case TRACE_EVENT_NAMES.piToolCompleted:
      case TRACE_EVENT_NAMES.piToolFailed: {
        const activity = tools.get(`${event.attemptId}:${event.toolActivityId}`);
        if (activity === undefined) break;
        activity.status =
          event.eventName === TRACE_EVENT_NAMES.piToolCompleted ? "succeeded" : "failed";
        activity.completedAt = event.timestamp;
        const durationMs = roundedDuration(event.durationMs);
        if (durationMs !== undefined) activity.durationMs = durationMs;
        if (event.eventName === TRACE_EVENT_NAMES.piToolFailed)
          activity.errorCode = event.error.code;
        break;
      }
    }
  }

  return activities.map((activity) =>
    executionTraceDtoSchema.shape.piActivities.element.parse(activity),
  );
}

function unavailableRuntime(productRunId: ProductRunId): WorkflowRuntimeTraceDto {
  return {
    schemaVersion: WORKFLOW_RUNTIME_TRACE_SCHEMA_VERSION,
    productRunId,
    sourceKind: "vercel_workflow",
    availability: "unavailable",
    reason: "not_recorded",
    refreshAfterMs: null,
    refreshedAt: new Date(0).toISOString(),
  };
}

/** 为确定性修订号生成不含undefined的Runtime公开投影。 */
export function runtimeRevisionValue(runtime: WorkflowRuntimeTraceDto): unknown {
  if (runtime.availability !== "available") {
    return { availability: runtime.availability, reason: runtime.reason };
  }
  return {
    availability: runtime.availability,
    runtimeStatus: runtime.runtimeStatus,
    eventCount: runtime.eventCount,
    truncated: runtime.truncated,
    spans: runtime.spans.map((span) => ({
      spanKey: span.spanKey,
      kind: span.kind,
      status: span.status,
      createdAt: span.createdAt,
      ...(span.startedAt === undefined ? {} : { startedAt: span.startedAt }),
      ...(span.completedAt === undefined ? {} : { completedAt: span.completedAt }),
      eventSequences: span.eventSequences,
    })),
    events: runtime.events,
  };
}

/** 轨迹只包含发生过的运行实例；Definition占位或skipped可选节点不伪装成执行记录。 */
export function executedWorkflowNodeRuns<T extends { readonly status: string }>(
  nodes: readonly T[],
): T[] {
  return nodes.filter((node) => node.status !== "queued" && node.status !== "skipped");
}

export async function getExecutionTrace(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId; readonly productRunId: ProductRunId },
): Promise<{ readonly value: ExecutionTraceDto; readonly etag: string }> {
  // 先经Product Query做权限判断；随后两个外部只读源才允许解析本Run。
  const [{ run }, workflowView] = await Promise.all([
    getProductRun(deps, input),
    getWorkflowRunView(deps, input),
  ]);
  const [runtime, traceEvents] = await Promise.all([
    deps.workflowRuntimeTrace?.read({ productRunId: input.productRunId }) ??
      Promise.resolve(unavailableRuntime(input.productRunId)),
    deps.productRunTrace?.read({ productRunId: input.productRunId }) ?? Promise.resolve([]),
  ]);
  const piActivities = projectPiActivities(traceEvents);
  // queued/skipped都没有真正开始，不是执行轨迹。若Memory误被真正执行，它不会被本过滤隐藏。
  const nodeRuns = executedWorkflowNodeRuns(workflowView.value.nodeRuns);
  const revisionValue = {
    run: { status: run.status, phase: run.phase, revision: run.revision, updatedAt: run.updatedAt },
    workflow: {
      revision: workflowView.value.revision,
      nodeRuns: nodeRuns.map((node) => ({
        workflowNodeRunId: node.workflowNodeRunId,
        status: node.status,
        revision: node.revision,
        updatedAt: node.updatedAt,
      })),
    },
    runtime: runtimeRevisionValue(runtime),
    piActivities,
  };
  const traceRevision = hashCanonical("execution-trace-projection.v1", revisionValue);
  const activityTimes = piActivities.flatMap((activity) => [
    activity.startedAt,
    ...(activity.completedAt === undefined ? [] : [activity.completedAt]),
  ]);
  const runtimeTimes =
    runtime.availability === "available" ? runtime.events.map((event) => event.recordedAt) : [];
  const updatedAt =
    [run.updatedAt, workflowView.value.updatedAt, ...activityTimes, ...runtimeTimes]
      .sort()
      .at(-1) ?? run.updatedAt;
  const value = executionTraceDtoSchema.parse({
    schemaVersion: EXECUTION_TRACE_SCHEMA_VERSION,
    productRunId: input.productRunId,
    traceRevision,
    updatedAt,
    run: {
      status: run.status,
      phase: run.phase,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    },
    workflow: { title: workflowView.value.title, nodeRuns },
    runtime,
    piActivities,
    truncated: runtime.availability === "available" && runtime.truncated,
  });
  return { value, etag: `"${traceRevision}"` };
}
