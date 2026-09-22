import { validateTimeZone } from "../calendar.js";

export type DutyCadence = { kind: "cron"; expression: string } | { kind: "none" };
export interface DutyEvidence {
  kind: "file" | "work" | "note";
  path?: string;
  workId?: string;
  text?: string;
}
export interface DutyProgressEntry {
  /** Dedup key: one commitment per advancement (advancementKey). */
  id: string;
  advancementKey: string;
  /** Same key with a different payload is a conflict, not a silent overwrite. */
  payloadHash: string;
  at: string;
  source: "agent" | "user";
  /** Goal generation this entry belongs to; older generations stay as history. */
  goalRevision: number;
  /** False when the entry is history only (old goal, or a stale/replaced report); such entries never feed the next prompt. */
  applied: boolean;
  summary: string;
  evidence: DutyEvidence[];
  unitsDone: number | null;
  nextStep: string | null;
  nextCheckAt: string | null;
}
export interface DutyAdvancement {
  advancementKey: string;
  workId: string;
  goalRevision: number;
  status: "completed" | "failed" | "cancelled" | "interrupted";
  tokens: number;
  at: string;
}
export interface FriendDutyInput {
  name: string;
  objective: string;
  materials: string[];
  contextProjectId: string | null;
  outcome: string;
  timeZone: string;
  cadence: DutyCadence;
  allowedHours: { start: number; end: number } | null;
  budget: { tokensPerDay: number } | null;
  totalUnits: number | null;
}
export interface FriendDuty extends FriendDutyInput {
  id: string;
  longAgentId: string;
  /** Optimistic-concurrency version: every persisted change bumps it. */
  revision: number;
  /** Goal generation: only objective/scope changes bump it; progress and budget scope to it. */
  goalRevision: number;
  status: "active" | "paused" | "ended";
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  taskId: string | null;
  /** Applied pointer state; history-only reports never move these. */
  unitsDone: number | null;
  nextStep: string | null;
  nextCheckAt: string | null;
  awaitingMaterial: boolean;
  progress: DutyProgressEntry[];
  advancements: DutyAdvancement[];
}
export class FriendDutyError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}
export function record(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new FriendDutyError(400, "职责数据必须是对象");
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Reads documents written by older revisions of this contract:
 * - the per-entry `dutyRevision` becomes the goal generation;
 * - an existing pointer is preserved; missing completion stays unknown;
 * - missing `applied` means unverified history. Matching pointer fields cannot prove that a report's
 *   summary or evidence was applied. Persisting false on the next atomic write makes reads stable.
 */
function normalizeLegacy(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const duty: Record<string, unknown> = { ...value };
  if (duty.goalRevision === undefined && typeof duty.revision === "number")
    duty.goalRevision = duty.revision;
  if (duty.unitsDone === undefined) duty.unitsDone = null;
  for (const key of ["progress", "advancements"] as const) {
    if (!Array.isArray(duty[key])) continue;
    duty[key] = (duty[key] as unknown[]).map((entry) => {
      if (!isRecord(entry)) return entry;
      const normalized: Record<string, unknown> = { ...entry };
      if (normalized.goalRevision === undefined && normalized.dutyRevision !== undefined)
        normalized.goalRevision = normalized.dutyRevision;
      delete normalized.dutyRevision;
      // payloadHash is a progress-entry field; older progress entries simply have no hash yet.
      if (key === "progress" && normalized.payloadHash === undefined) normalized.payloadHash = "";
      if (key === "progress" && normalized.applied === undefined) normalized.applied = false;
      return normalized;
    });
  }
  return duty;
}

export function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new FriendDutyError(400, "职责包含未知字段");
}
export function string(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new FriendDutyError(400, "职责文字为空或超出长度限制");
  return value.trim();
}
export function timestamp(value: unknown): string {
  const text = string(value);
  if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(text) || !Number.isFinite(Date.parse(text)))
    throw new FriendDutyError(400, "时间必须包含时区");
  return new Date(text).toISOString();
}
const inputKeys = [
  "name",
  "objective",
  "materials",
  "contextProjectId",
  "outcome",
  "timeZone",
  "cadence",
  "allowedHours",
  "budget",
  "totalUnits",
];
export function parseDutyInput(value: unknown): FriendDutyInput {
  record(value);
  exact(value, inputKeys);
  record(value.cadence);
  let cadence: DutyCadence;
  if (value.cadence.kind === "cron") {
    exact(value.cadence, ["kind", "expression"]);
    cadence = { kind: "cron", expression: string(value.cadence.expression, 120) };
  } else if (value.cadence.kind === "none") {
    exact(value.cadence, ["kind"]);
    cadence = { kind: "none" };
  } else throw new FriendDutyError(400, "未知推进节奏");
  if (!Array.isArray(value.materials) || value.materials.length > 100)
    throw new FriendDutyError(400, "资料清单无效");
  let timeZone: string;
  try {
    timeZone = validateTimeZone(value.timeZone);
  } catch {
    throw new FriendDutyError(400, "无效时区，请填写 IANA 名称，例如 Asia/Shanghai");
  }
  let allowedHours: FriendDutyInput["allowedHours"] = null;
  if (value.allowedHours !== null) {
    record(value.allowedHours);
    exact(value.allowedHours, ["start", "end"]);
    const start = value.allowedHours.start;
    const end = value.allowedHours.end;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      Number(start) < 0 ||
      Number(start) > 23 ||
      Number(end) < 1 ||
      Number(end) > 24 ||
      Number(start) >= Number(end)
    )
      throw new FriendDutyError(400, "允许时段必须是 0–24 内的本地小时区间，且开始早于结束");
    allowedHours = { start: Number(start), end: Number(end) };
  }
  let budget: FriendDutyInput["budget"] = null;
  if (value.budget !== null) {
    record(value.budget);
    exact(value.budget, ["tokensPerDay"]);
    if (!Number.isSafeInteger(value.budget.tokensPerDay) || Number(value.budget.tokensPerDay) < 1)
      throw new FriendDutyError(400, "每日预算必须是正整数 token 上限");
    budget = { tokensPerDay: Number(value.budget.tokensPerDay) };
  }
  if (value.totalUnits !== null && (!Number.isSafeInteger(value.totalUnits) || Number(value.totalUnits) < 1))
    throw new FriendDutyError(400, "总量必须是正整数，才能显示百分比");
  return {
    name: string(value.name, 120),
    objective: string(value.objective, 65536),
    materials: value.materials.map((m) => string(m, 1024)),
    contextProjectId: value.contextProjectId === null ? null : string(value.contextProjectId),
    outcome: string(value.outcome, 65536),
    timeZone,
    cadence,
    allowedHours,
    budget,
    totalUnits: value.totalUnits === null ? null : Number(value.totalUnits),
  };
}
export function parseDuty(value: unknown): FriendDuty {
  value = normalizeLegacy(value);
  record(value);
  exact(value, [
    ...inputKeys,
    "id",
    "longAgentId",
    "revision",
    "goalRevision",
    "status",
    "createdAt",
    "updatedAt",
    "endedAt",
    "taskId",
    "unitsDone",
    "nextStep",
    "nextCheckAt",
    "awaitingMaterial",
    "progress",
    "advancements",
  ]);
  const input = Object.fromEntries(inputKeys.map((key) => [key, value[key]]));
  if (
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    !Number.isSafeInteger(value.goalRevision) ||
    Number(value.goalRevision) < 1 ||
    Number(value.goalRevision) > Number(value.revision) ||
    !["active", "paused", "ended"].includes(String(value.status)) ||
    typeof value.awaitingMaterial !== "boolean" ||
    !Array.isArray(value.progress) ||
    !Array.isArray(value.advancements)
  )
    throw new FriendDutyError(400, "职责版本或状态无效");
  return {
    ...parseDutyInput(input),
    id: string(value.id),
    longAgentId: string(value.longAgentId),
    revision: Number(value.revision),
    goalRevision: Number(value.goalRevision),
    status: value.status as FriendDuty["status"],
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
    endedAt: value.endedAt === null ? null : timestamp(value.endedAt),
    taskId: value.taskId === null ? null : string(value.taskId),
    unitsDone: value.unitsDone === null ? null : parseUnits(value.unitsDone),
    nextStep: value.nextStep === null ? null : string(value.nextStep, 65536),
    nextCheckAt: value.nextCheckAt === null ? null : timestamp(value.nextCheckAt),
    awaitingMaterial: value.awaitingMaterial,
    progress: value.progress.map(parseProgressEntry),
    advancements: value.advancements.map(parseAdvancement),
  };
}
function parseProgressEntry(value: unknown): DutyProgressEntry {
  record(value);
  exact(value, [
    "id",
    "advancementKey",
    "payloadHash",
    "at",
    "source",
    "goalRevision",
    "applied",
    "summary",
    "evidence",
    "unitsDone",
    "nextStep",
    "nextCheckAt",
  ]);
  if (
    !Number.isSafeInteger(value.goalRevision) ||
    Number(value.goalRevision) < 1 ||
    !["agent", "user"].includes(String(value.source)) ||
    typeof value.applied !== "boolean" ||
    !Array.isArray(value.evidence) ||
    value.evidence.length > 20
  )
    throw new FriendDutyError(400, "进度记录无效");
  return {
    id: string(value.id),
    advancementKey: string(value.advancementKey),
    payloadHash: typeof value.payloadHash === "string" ? value.payloadHash : "",
    at: timestamp(value.at),
    source: value.source as DutyProgressEntry["source"],
    goalRevision: Number(value.goalRevision),
    applied: value.applied,
    summary: string(value.summary, 20000),
    evidence: value.evidence.map(parseEvidence),
    unitsDone: value.unitsDone === null ? null : parseUnits(value.unitsDone),
    nextStep: value.nextStep === null ? null : string(value.nextStep, 65536),
    nextCheckAt: value.nextCheckAt === null ? null : timestamp(value.nextCheckAt),
  };
}
function parseAdvancement(value: unknown): DutyAdvancement {
  record(value);
  exact(value, ["advancementKey", "workId", "goalRevision", "status", "tokens", "at"]);
  if (
    !Number.isSafeInteger(value.goalRevision) ||
    Number(value.goalRevision) < 1 ||
    !Number.isSafeInteger(value.tokens) ||
    Number(value.tokens) < 0 ||
    !["completed", "failed", "cancelled", "interrupted"].includes(String(value.status))
  )
    throw new FriendDutyError(400, "推进回执无效");
  return {
    advancementKey: string(value.advancementKey),
    workId: string(value.workId),
    goalRevision: Number(value.goalRevision),
    status: value.status as DutyAdvancement["status"],
    tokens: Number(value.tokens),
    at: timestamp(value.at),
  };
}
function parseUnits(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new FriendDutyError(400, "完成量必须是非负整数");
  return Number(value);
}
export function parseEvidence(value: unknown): DutyEvidence {
  record(value);
  if (value.kind === "file") {
    exact(value, ["kind", "path"]);
    return { kind: "file", path: string(value.path, 1024) };
  }
  if (value.kind === "work") {
    exact(value, ["kind", "workId"]);
    return { kind: "work", workId: string(value.workId) };
  }
  if (value.kind === "note") {
    exact(value, ["kind", "text"]);
    return { kind: "note", text: string(value.text, 2000) };
  }
  throw new FriendDutyError(400, "证据类型无效");
}
