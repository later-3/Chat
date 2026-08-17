import {
  WORKFLOW_RUNTIME_TRACE_SCHEMA_VERSION,
  workflowRuntimeTraceDtoSchema,
  type ProductRunId,
  type WorkflowRuntimeEventType,
  type WorkflowRuntimeResourceKind,
  type WorkflowRuntimeSpanStatus,
  type WorkflowRuntimeTraceDto,
  type WorkflowRuntimeTraceEventDto,
  type WorkflowRuntimeTraceSegmentDto,
  type WorkflowRuntimeTraceSpanDto,
} from "@chat/contracts";
import { parseStepName, parseWorkflowName } from "workflow/observability";
import type { LocalWorld } from "@workflow/world-local";

const EVENT_LIMIT = 2_000;
const EVENT_PAGE_SIZE = 500;

type WorldEvent = Awaited<ReturnType<LocalWorld["events"]["list"]>>["data"][number];
type WorldRun = Awaited<ReturnType<LocalWorld["runs"]["get"]>>;

interface EventEnvelope {
  readonly event: WorldEvent;
  readonly sequence: number;
  readonly recordedAtMs: number;
}

interface ProjectionGroup {
  readonly kind: Exclude<WorkflowRuntimeResourceKind, "run">;
  readonly correlationId: string;
  readonly sequence: number;
  readonly events: EventEnvelope[];
}

function eventTime(event: WorldEvent): number {
  const raw = event.occurredAt ?? event.createdAt;
  const value = raw instanceof Date ? raw : new Date(raw);
  return Number.isFinite(value.getTime()) ? value.getTime() : 0;
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function duration(startMs: number, endMs: number): number {
  return Math.max(0, Math.round(endMs - startMs));
}

function resourceKind(type: WorkflowRuntimeEventType): WorkflowRuntimeResourceKind {
  if (type === "wait_created" || type === "wait_completed") return "sleep";
  if (type === "hook_created" || type === "hook_received" || type === "hook_disposed") {
    return "hook";
  }
  if (type.startsWith("step_")) return "step";
  // hook_conflict没有可信的hook_created锚点，按Run级异常保留。
  return "run";
}

function fallbackName(value: string, fallback: "step" | "workflow"): string {
  const separator = value.lastIndexOf("//");
  const candidate = (separator >= 0 ? value.slice(separator + 2) : value).trim();
  return candidate.length > 0 && candidate.length <= 160 && !/[\\/\r\n\t]/u.test(candidate)
    ? candidate
    : fallback;
}

function stepName(events: readonly EventEnvelope[]): string {
  for (const { event } of events) {
    if (!event.eventType.startsWith("step_")) continue;
    const value =
      "eventData" in event &&
      event.eventData !== null &&
      typeof event.eventData === "object" &&
      "stepName" in event.eventData
        ? event.eventData.stepName
        : undefined;
    if (typeof value !== "string") continue;
    return (parseStepName(value)?.shortName ?? fallbackName(value, "step")).slice(0, 160);
  }
  return "step";
}

function workflowName(run: WorldRun): string {
  return (
    parseWorkflowName(run.workflowName)?.shortName ?? fallbackName(run.workflowName, "workflow")
  ).slice(0, 160);
}

function markerStatus(type: WorkflowRuntimeEventType): WorkflowRuntimeSpanStatus {
  switch (type) {
    case "run_created":
    case "step_created":
      return "queued";
    case "run_started":
    case "step_started":
      return "running";
    case "run_completed":
    case "step_completed":
    case "wait_completed":
      return "completed";
    case "run_failed":
    case "step_failed":
    case "hook_conflict":
      return "failed";
    case "run_cancelled":
      return "cancelled";
    case "step_retrying":
      return "retrying";
    case "hook_created":
      return "waiting";
    case "hook_received":
      return "received";
    case "hook_disposed":
      return "disposed";
    case "wait_created":
      return "sleeping";
  }
}

function deriveStatus(group: ProjectionGroup): WorkflowRuntimeSpanStatus {
  let status: WorkflowRuntimeSpanStatus =
    group.kind === "hook" ? "waiting" : group.kind === "sleep" ? "sleeping" : "queued";
  for (const { event } of group.events) status = markerStatus(event.eventType);
  return status;
}

function lastEventTime(
  events: readonly EventEnvelope[],
  eventType: WorkflowRuntimeEventType,
): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const envelope = events[index];
    if (envelope?.event.eventType === eventType) return envelope.recordedAtMs;
  }
  return undefined;
}

function terminalTime(
  group: ProjectionGroup,
  status: WorkflowRuntimeSpanStatus,
): number | undefined {
  if (group.kind === "step") {
    if (status === "completed") return lastEventTime(group.events, "step_completed");
    if (status === "failed") return lastEventTime(group.events, "step_failed");
  } else if (group.kind === "hook") {
    if (status === "disposed") return lastEventTime(group.events, "hook_disposed");
    if (status === "failed") return lastEventTime(group.events, "hook_conflict");
  } else if (status === "completed") {
    return lastEventTime(group.events, "wait_completed");
  }
  return undefined;
}

function buildSegments(
  events: readonly EventEnvelope[],
  startMs: number,
  endMs: number,
): WorkflowRuntimeTraceSegmentDto[] {
  const points = events
    .map(({ event, recordedAtMs }) => ({ status: markerStatus(event.eventType), at: recordedAtMs }))
    .filter((point, index, all) => index === 0 || point.status !== all[index - 1]?.status);
  if (points.length === 0)
    return [{ status: "queued", offsetMs: 0, durationMs: duration(startMs, endMs) }];
  return points.map((point, index) => {
    const next = points[index + 1];
    return {
      status: point.status,
      offsetMs: duration(startMs, point.at),
      durationMs: duration(point.at, Math.max(point.at, next?.at ?? endMs)),
    };
  });
}

function groupEvents(events: readonly EventEnvelope[]): {
  readonly run: EventEnvelope[];
  readonly groups: ProjectionGroup[];
} {
  const run: EventEnvelope[] = [];
  const groups = new Map<string, ProjectionGroup>();
  for (const envelope of events) {
    const kind = resourceKind(envelope.event.eventType);
    const correlationId = envelope.event.correlationId;
    if (kind === "run" || correlationId === undefined) {
      run.push(envelope);
      continue;
    }
    const key = `${kind}:${correlationId}`;
    const current = groups.get(key);
    if (current !== undefined) current.events.push(envelope);
    else groups.set(key, { kind, correlationId, sequence: groups.size + 1, events: [envelope] });
  }
  return { run, groups: [...groups.values()] };
}

function spanKey(kind: WorkflowRuntimeResourceKind, sequence: number): string {
  return `runtime-${kind}-${String(sequence)}`;
}

function buildChildSpan(
  group: ProjectionGroup,
  rootStartMs: number,
  latestKnownMs: number,
): WorkflowRuntimeTraceSpanDto {
  const first = group.events[0];
  if (first === undefined) throw new Error("Runtime Trace事件组为空");
  const startMs = first.recordedAtMs;
  const status = deriveStatus(group);
  const completedMs = terminalTime(group, status);
  const endMs = Math.max(startMs, completedMs ?? latestKnownMs);
  const startedMs = group.events.find(
    ({ event }) => event.eventType === "step_started",
  )?.recordedAtMs;
  const attempt = group.events.filter(({ event }) => event.eventType === "step_started").length;
  return {
    spanKey: spanKey(group.kind, group.sequence),
    sequence: group.sequence,
    kind: group.kind,
    name:
      group.kind === "step"
        ? stepName(group.events)
        : group.kind === "hook"
          ? "人工审核等待"
          : "耐久等待",
    status,
    ...(group.kind === "step" ? { attempt: Math.max(1, attempt) } : {}),
    createdAt: new Date(startMs).toISOString(),
    ...(startedMs !== undefined ? { startedAt: new Date(startedMs).toISOString() } : {}),
    ...(completedMs !== undefined ? { completedAt: new Date(completedMs).toISOString() } : {}),
    offsetMs: duration(rootStartMs, startMs),
    durationMs: duration(startMs, endMs),
    segments: buildSegments(group.events, startMs, endMs),
    eventSequences: group.events.map(({ sequence }) => sequence),
  };
}

async function readEvents(
  world: LocalWorld,
  workflowRunId: string,
): Promise<{ events: WorldEvent[]; truncated: boolean }> {
  const events: WorldEvent[] = [];
  let cursor: string | undefined;
  let hasMore = true;
  while (hasMore && events.length < EVENT_LIMIT) {
    const page = await world.events.list({
      runId: workflowRunId,
      pagination: {
        limit: Math.min(EVENT_PAGE_SIZE, EVENT_LIMIT - events.length),
        sortOrder: "asc",
        ...(cursor === undefined ? {} : { cursor }),
      },
      resolveData: "none",
    });
    events.push(...page.data);
    hasMore = page.hasMore;
    cursor = page.cursor ?? undefined;
    if (page.hasMore && page.cursor === null) break;
  }
  return { events, truncated: hasMore };
}

/** 将World事件投影为无私有身份、无I/O正文的Run/Step/Hook/Sleep时间线。 */
export async function projectWorkflowRuntimeTrace(input: {
  readonly productRunId: ProductRunId;
  readonly workflowRunId: string;
  readonly world: LocalWorld;
  readonly now: Date;
}): Promise<WorkflowRuntimeTraceDto> {
  const run = await input.world.runs.get(input.workflowRunId, { resolveData: "none" });
  const page = await readEvents(input.world, input.workflowRunId);
  const ordered = page.events
    .map((event, originalIndex) => ({ event, originalIndex, recordedAtMs: eventTime(event) }))
    .sort(
      (left, right) =>
        left.recordedAtMs - right.recordedAtMs || left.originalIndex - right.originalIndex,
    )
    .map(({ event, recordedAtMs }, index) => ({ event, recordedAtMs, sequence: index + 1 }));
  const rootStartMs = new Date(run.createdAt).getTime();
  const latestKnownMs = Math.max(rootStartMs, ...ordered.map(({ recordedAtMs }) => recordedAtMs));
  const grouped = groupEvents(ordered);
  const childSpans = grouped.groups
    .map((group) => buildChildSpan(group, rootStartMs, latestKnownMs))
    .sort((left, right) => left.offsetMs - right.offsetMs || left.sequence - right.sequence);
  const spanKeyByCorrelation = new Map(
    grouped.groups.map((group) => [
      `${group.kind}:${group.correlationId}`,
      spanKey(group.kind, group.sequence),
    ]),
  );
  const events: WorkflowRuntimeTraceEventDto[] = ordered.map((envelope) => {
    const kind = resourceKind(envelope.event.eventType);
    return {
      sequence: envelope.sequence,
      type: envelope.event.eventType,
      resourceKind: kind,
      spanKey:
        kind === "run" || envelope.event.correlationId === undefined
          ? spanKey("run", 0)
          : (spanKeyByCorrelation.get(`${kind}:${envelope.event.correlationId}`) ??
            spanKey("run", 0)),
      recordedAt: new Date(envelope.recordedAtMs).toISOString(),
      offsetMs: duration(rootStartMs, envelope.recordedAtMs),
    };
  });
  const completedMs = run.completedAt?.getTime();
  const terminal = ["completed", "failed", "cancelled"].includes(run.status);
  const runEndMs = completedMs ?? input.now.getTime();
  const runStatus: WorkflowRuntimeSpanStatus = run.status === "pending" ? "queued" : run.status;
  const runSpan: WorkflowRuntimeTraceSpanDto = {
    spanKey: spanKey("run", 0),
    sequence: 0,
    kind: "run",
    name: workflowName(run),
    status: runStatus,
    createdAt: iso(run.createdAt),
    ...(run.startedAt === undefined ? {} : { startedAt: iso(run.startedAt) }),
    ...(run.completedAt === undefined ? {} : { completedAt: iso(run.completedAt) }),
    offsetMs: 0,
    durationMs: duration(rootStartMs, runEndMs),
    segments: buildSegments(grouped.run, rootStartMs, runEndMs),
    eventSequences: grouped.run.map(({ sequence }) => sequence),
  };
  return workflowRuntimeTraceDtoSchema.parse({
    schemaVersion: WORKFLOW_RUNTIME_TRACE_SCHEMA_VERSION,
    productRunId: input.productRunId,
    sourceKind: "vercel_workflow",
    availability: "available",
    workflowName: workflowName(run),
    runtimeStatus: run.status,
    isLive: !terminal,
    refreshAfterMs: terminal ? null : 750,
    refreshedAt: input.now.toISOString(),
    createdAt: iso(run.createdAt),
    ...(run.startedAt === undefined ? {} : { startedAt: iso(run.startedAt) }),
    ...(run.completedAt === undefined ? {} : { completedAt: iso(run.completedAt) }),
    durationMs: duration(rootStartMs, runEndMs),
    knownDurationMs: duration(rootStartMs, latestKnownMs),
    eventCount: events.length,
    truncated: page.truncated,
    spans: [runSpan, ...childSpans],
    events,
  });
}
