import { validateTimeZone } from "../calendar.js";

export type TaskSchedule =
  | { kind: "once"; at: string }
  | { kind: "cron"; expression: string }
  | { kind: "event"; source: string };
export interface TaskDeliverable {
  kind: "post" | "note";
  /** Slot identity inside one day, e.g. morning/noon/evening/night-note. */
  slot: string;
  /** Only for posts; the audience comes from this user-configured revision, never from the model. */
  audience?: "friends" | "self";
}
export interface FriendTaskInput {
  name: string;
  prompt: string;
  contextProjectId: string | null;
  timeZone: string;
  schedule: TaskSchedule;
  missed: "skip" | "latest";
  overlap: "skip" | "queue-one";
  /** Marks this task as producing a note or a social post for the LA4 artifact loop. */
  deliverable?: TaskDeliverable;
}
export interface FriendTask extends FriendTaskInput {
  id: string;
  longAgentId: string;
  revision: number;
  status: "active" | "paused" | "cancelled";
  createdAt: string;
  updatedAt: string;
  legacyId?: string;
  migrationNote?: string;
}
export interface FriendTask extends FriendTaskInput {
  id: string;
  longAgentId: string;
  revision: number;
  status: "active" | "paused" | "cancelled";
  createdAt: string;
  updatedAt: string;
  legacyId?: string;
  migrationNote?: string;
  /** Set only by the duty service; links this task to its long-term duty. */
  dutyId?: string;
}
export interface TaskOccurrence {
  id: string;
  taskId: string;
  revision: number;
  definition: FriendTask;
  source: "time" | "event" | "manual";
  sourceId: string;
  scheduledAt: string;
  receivedAt: string;
  payloadHash: string;
  originSessionId: string | null;
  state: "accepted" | "started" | "skipped" | "blocked";
  reason: string | null;
  workId: string | null;
  /** Frozen duty goal generation at dispatch time; absent for non-duty tasks. */
  dutyGoalRevision?: number;
  /** Duty concurrency revision frozen at durable acceptance; a report against a newer duty is history only. */
  dutyDispatchRevision?: number;
  /** Composed advancement text frozen at durable acceptance; absent for non-duty tasks. */
  workText?: string;
}
export class FriendTaskError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}
export function record(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new FriendTaskError(400, "任务数据必须是对象");
}
export function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new FriendTaskError(400, "任务包含未知字段");
}
export function string(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new FriendTaskError(400, "任务文字为空或超出长度限制");
  return value.trim();
}
export function timestamp(value: unknown): string {
  const text = string(value);
  if (
    !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(text) ||
    !Number.isFinite(Date.parse(text))
  )
    throw new FriendTaskError(400, "时间必须包含时区");
  return new Date(text).toISOString();
}
const inputKeys = [
  "name",
  "prompt",
  "contextProjectId",
  "timeZone",
  "schedule",
  "missed",
  "overlap",
  "deliverable",
];
export const DELIVERABLE_SLOT_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export function parseDeliverable(value: unknown): TaskDeliverable {
  record(value);
  if (value.kind !== "post" && value.kind !== "note")
    throw new FriendTaskError(400, "产物类型必须是 post 或 note");
  const slot = string(value.slot, 40);
  if (!DELIVERABLE_SLOT_PATTERN.test(slot))
    throw new FriendTaskError(400, "产物槽位只能是小写字母、数字和连字符（1–40 字符）");
  if (value.audience !== undefined && value.audience !== "friends" && value.audience !== "self")
    throw new FriendTaskError(400, "动态受众必须是 friends 或 self");
  if (value.kind === "note" && value.audience !== undefined)
    throw new FriendTaskError(400, "笔记没有受众字段");
  exact(value, value.kind === "post" ? ["kind", "slot", "audience"] : ["kind", "slot"]);
  return {
    kind: value.kind,
    slot,
    ...(value.kind === "post" ? { audience: (value.audience ?? "friends") as "friends" | "self" } : {}),
  };
}
export function parseTaskInput(value: unknown): FriendTaskInput {
  record(value);
  exact(value, inputKeys);
  record(value.schedule);
  const s = value.schedule;
  let schedule: TaskSchedule;
  if (s.kind === "once") {
    exact(s, ["kind", "at"]);
    schedule = { kind: "once", at: timestamp(s.at) };
  } else if (s.kind === "cron") {
    exact(s, ["kind", "expression"]);
    schedule = { kind: "cron", expression: string(s.expression, 120) };
  } else if (s.kind === "event") {
    exact(s, ["kind", "source"]);
    schedule = { kind: "event", source: string(s.source, 120) };
  } else throw new FriendTaskError(400, "未知任务触发类型");
  if (
    (value.missed !== "skip" && value.missed !== "latest") ||
    (value.overlap !== "skip" && value.overlap !== "queue-one")
  )
    throw new FriendTaskError(400, "无效的错过时间或重叠策略");
  let timeZone: string;
  try { timeZone = validateTimeZone(value.timeZone); } catch { throw new FriendTaskError(400, "无效时区，请填写 IANA 名称，例如 Asia/Shanghai"); }
  return {
    name: string(value.name, 120),
    prompt: string(value.prompt, 65536),
    contextProjectId:
      value.contextProjectId === null ? null : string(value.contextProjectId),
    timeZone,
    schedule,
    missed: value.missed,
    overlap: value.overlap,
    ...(value.deliverable === undefined ? {} : { deliverable: parseDeliverable(value.deliverable) }),
  };
}
export function parseTask(value: unknown): FriendTask {
  record(value);
  exact(value, [
    ...inputKeys,
    "id",
    "longAgentId",
    "revision",
    "status",
    "createdAt",
    "updatedAt",
    "legacyId",
    "migrationNote",
    "dutyId",
  ]);
  const input = Object.fromEntries(inputKeys.map((key) => [key, value[key]]));
  if (
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    !["active", "paused", "cancelled"].includes(String(value.status))
  )
    throw new FriendTaskError(400, "任务版本或状态无效");
  return {
    ...parseTaskInput(input),
    id: string(value.id),
    longAgentId: string(value.longAgentId),
    revision: Number(value.revision),
    status: value.status as FriendTask["status"],
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
    ...(value.migrationNote === undefined
      ? {}
      : { migrationNote: string(value.migrationNote, 2000) }),
    ...(value.legacyId === undefined
      ? {}
      : { legacyId: string(value.legacyId) }),
    ...(value.dutyId === undefined
      ? {}
      : { dutyId: parseDutyId(value.dutyId) }),
  };
}
export function parseOccurrence(value: unknown): TaskOccurrence {
  // Older records used `dutyRevision` for the duty goal generation.
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const legacy = value as Record<string, unknown>;
    if (legacy.dutyGoalRevision === undefined && legacy.dutyRevision !== undefined) {
      value = { ...legacy, dutyGoalRevision: legacy.dutyRevision };
    }
    if ("dutyRevision" in (value as Record<string, unknown>)) {
      const { dutyRevision: _legacy, ...rest } = value as Record<string, unknown>;
      value = rest;
    }
  }
  record(value);
  exact(value, [
    "id",
    "taskId",
    "revision",
    "definition",
    "source",
    "sourceId",
    "scheduledAt",
    "receivedAt",
    "payloadHash",
    "originSessionId",
    "state",
    "reason",
    "workId",
    "dutyGoalRevision",
    "dutyDispatchRevision",
    "workText",
  ]);
  const definition = parseTask(value.definition);
  if (
    value.taskId !== definition.id ||
    value.revision !== definition.revision ||
    !["time", "event", "manual"].includes(String(value.source)) ||
    !["accepted", "started", "skipped", "blocked"].includes(String(value.state))
  )
    throw new FriendTaskError(400, "任务发生记录无效");
  return {
    id: string(value.id),
    taskId: definition.id,
    revision: definition.revision,
    definition,
    source: value.source as TaskOccurrence["source"],
    sourceId: string(value.sourceId),
    scheduledAt: timestamp(value.scheduledAt),
    receivedAt: timestamp(value.receivedAt),
    payloadHash: string(value.payloadHash),
    originSessionId:
      value.originSessionId === null ? null : string(value.originSessionId),
    state: value.state as TaskOccurrence["state"],
    reason: value.reason === null ? null : string(value.reason, 2000),
    workId: value.workId === null ? null : string(value.workId),
    ...(value.dutyGoalRevision === undefined
      ? {}
      : { dutyGoalRevision: parsePositiveInteger(value.dutyGoalRevision) }),
    ...(value.dutyDispatchRevision === undefined
      ? {}
      : { dutyDispatchRevision: parsePositiveInteger(value.dutyDispatchRevision) }),
    ...(value.workText === undefined
      ? {}
      : { workText: string(value.workText, 100_000) }),
  };
}
function parsePositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new FriendTaskError(400, "版本号必须是正整数");
  return Number(value);
}
export function parseDutyId(value: unknown): string {
  const id = string(value);
  if (!/^duty-[a-f0-9]{32}$/.test(id))
    throw new FriendTaskError(400, "任务职责链接无效");
  return id;
}
