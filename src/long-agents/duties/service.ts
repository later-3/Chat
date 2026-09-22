import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { openChatSession } from "../../chat-session.js";
import { resolveProjectContext } from "../../projects/registry.js";
import { appendChatAuditEvent } from "../../audit-log.js";
import { readLongAgentRegistry, readLongAgentState } from "../storage.js";
import { agentDate } from "../calendar.js";
import { listFriendTasks, manageFriendTask } from "../tasks/service.js";
import { readTaskState } from "../tasks/storage.js";
import { parseDutyId, type FriendTask, type TaskOccurrence } from "../tasks/contract.js";
import {
  FriendDutyError,
  exact,
  parseDutyInput,
  parseEvidence,
  record,
  string,
  timestamp,
  type DutyEvidence,
  type FriendDuty,
  type FriendDutyInput,
} from "./contract.js";
import { changeDutyState, readDutyState, type DutyState } from "./storage.js";

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
/** Placeholder cron for a dormant duty task; never enabled while the duty has no due plan. */
const DORMANT_CRON = "0 3 * * *";
/** Goal-scoped fields: changing one of them starts a new goal generation. */
const GOAL_FIELDS = ["objective", "materials", "outcome", "totalUnits", "contextProjectId"] as const;

async function owner(home: string, id: string) {
  const registry = await readLongAgentRegistry(home);
  const agent = registry.agents.find((a) => a.id === id);
  if (!agent) throw new FriendDutyError(404, "找不到Friend");
  return { agent };
}

/** The duty-owned task definition; duty advancement reuses the LA2 scheduler. */
function dutyTaskPrompt(dutyId: string) {
  return `长期职责推进任务（dutyId=${dutyId}）。本任务的推进指令在每次触发时由职责服务按职责当前目标、进度与下一步生成，此处占位。不要直接依据本说明工作。`;
}
/**
 * A self-scheduled plan stays active until it has actually been delivered (an occurrence for that
 * exact plan time exists). Due-but-undelivered plans must survive the maintenance loop: Nano may
 * deliver after the due time, and only consumption (acceptance) converts the plan back to dormant.
 */
function planConsumed(duty: FriendDuty, taskId: string | null, occurrences: readonly TaskOccurrence[]): boolean {
  if (!duty.nextCheckAt || taskId === null) return false;
  // A plan's identity is its task plus its scheduled time: another duty may plan the same instant.
  return occurrences.some((o) => o.taskId === taskId && o.sourceId === `${duty.timeZone}:${duty.nextCheckAt}`);
}
function selfScheduledAt(duty: FriendDuty, consumed: boolean): string | null {
  return duty.cadence.kind === "none" && duty.nextCheckAt !== null && !consumed ? duty.nextCheckAt : null;
}
function dutyTaskDefinition(duty: FriendDuty, consumed: boolean) {
  const self = selfScheduledAt(duty, consumed);
  return {
    name: `职责推进：${duty.name}`.slice(0, 120),
    prompt: dutyTaskPrompt(duty.id),
    contextProjectId: duty.contextProjectId,
    timeZone: duty.timeZone,
    schedule:
      duty.cadence.kind === "cron"
        ? ({ kind: "cron", expression: duty.cadence.expression } as const)
        : self
          ? ({ kind: "once", at: self } as const)
          : ({ kind: "cron", expression: DORMANT_CRON } as const),
    // A self-scheduled check may be minutes late; a periodic duty keeps the LA2 skip policy.
    missed: self ? ("latest" as const) : ("skip" as const),
    overlap: "queue-one" as const,
  };
}
function desiredTaskStatus(duty: FriendDuty, consumed: boolean): FriendTask["status"] {
  if (duty.status === "ended") return "cancelled";
  const scheduled = duty.cadence.kind === "cron" || selfScheduledAt(duty, consumed) !== null;
  return duty.status === "active" && scheduled ? "active" : "paused";
}

/** Ensure the duty's linked task exists and matches the current duty definition. */
async function syncDutyTask(home: string, agentId: string, duty: FriendDuty): Promise<void> {
  const state = await readTaskState(home, agentId);
  const existing = state.tasks.find((t) => t.id === duty.taskId || t.dutyId === duty.id);
  const desired = dutyTaskDefinition(duty, planConsumed(duty, existing?.id ?? null, state.occurrences));
  if (!existing) {
    await manageFriendTask(home, agentId, {
      schemaVersion: 2,
      operation: "create",
      requestId: `duty-create:${duty.id}`,
      dutyId: duty.id,
      definition: desired,
    });
    return;
  }
  const previous = JSON.stringify(
    Object.fromEntries(
      (["name", "prompt", "contextProjectId", "timeZone", "schedule", "missed", "overlap"] as const).map((k) => [k, existing[k]]),
    ),
  );
  if (previous !== JSON.stringify(desired)) {
    await manageFriendTask(home, agentId, {
      schemaVersion: 2,
      operation: "update",
      taskId: existing.id,
      expectedRevision: existing.revision,
      dutyId: duty.id,
      definition: desired,
    });
  }
}

async function alignTaskStatus(home: string, agentId: string, duty: FriendDuty): Promise<void> {
  const state = await readTaskState(home, agentId);
  const task = state.tasks.find((t) => t.id === duty.taskId || t.dutyId === duty.id);
  if (!task) return;
  const desired = desiredTaskStatus(duty, planConsumed(duty, task.id, state.occurrences));
  if (task.status === desired || task.status === "cancelled") return;
  await manageFriendTask(home, agentId, {
    schemaVersion: 2,
    operation: desired === "paused" ? "pause" : desired === "cancelled" ? "cancel" : "resume",
    taskId: task.id,
    expectedRevision: task.revision,
    dutyId: duty.id,
  });
}
/** Keep the projection in step with the duty's own plan; failures are logged and retried by maintenance. */
async function syncQuietly(home: string, agentId: string, duty: FriendDuty): Promise<void> {
  try {
    await syncDutyTask(home, agentId, duty);
    await alignTaskStatus(home, agentId, duty);
  } catch (e) {
    console.error(`职责 ${duty.id} 推进任务待同步`, e instanceof Error ? e.message : e);
  }
}

function localHour(timeZone: string, now: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", { timeZone, hour: "numeric", hourCycle: "h23" }).format(now),
  );
}
function goalChanged(previous: FriendDuty, input: FriendDutyInput): boolean {
  return GOAL_FIELDS.some((field) => JSON.stringify(previous[field]) !== JSON.stringify(input[field]));
}
function currentUnitsDone(duty: FriendDuty): number | null {
  return duty.unitsDone;
}
/** Consumption is metered per duty per day; a goal revision must not reset the day's budget. */
function tokensToday(duty: FriendDuty, now: Date): number {
  const today = agentDate(duty.timeZone, now);
  return duty.advancements
    .filter((a) => agentDate(duty.timeZone, new Date(a.at)) === today)
    .reduce((sum, a) => sum + a.tokens, 0);
}

export function composeAdvancementText(duty: FriendDuty, now: Date): string {
  const currentEntries = duty.progress.filter((p) => p.goalRevision === duty.goalRevision);
  // Only entries that actually applied to the current pointer are current evidence; history-only
  // reports (stale, replaced, or from another goal) must never read as learned facts.
  const progress = currentEntries.filter((p) => p.applied).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const excluded = currentEntries.length - progress.length;
  const recent = progress.slice(-10);
  const covered = [
    ...new Set(progress.flatMap((p) => p.evidence.filter((e) => e.kind === "file").map((e) => e.path ?? ""))),
  ].filter(Boolean);
  const units = currentUnitsDone(duty);
  const scope = duty.contextProjectId ? `用户项目 ${duty.contextProjectId}` : "Friend 自身工作区（相对路径）";
  void now;
  return [
    "这是长期职责的自动推进指令（系统按职责当前状态生成，不是用户新发言）。",
    `职责：${duty.name}（dutyId=${duty.id}，目标修订 g${duty.goalRevision}）`,
    `目标：${duty.objective}`,
    `成果要求：${duty.outcome}`,
    `授权范围：${scope}；只能在该范围内读取和写入，不得越界。`,
    "资料清单（只能依据这些资料推进）：",
    ...(duty.materials.length ? duty.materials.map((m) => `- ${m}`) : ["-（空）"]),
    ...(covered.length ? ["已覆盖的材料（不要重读同一段）：", ...covered.map((m) => `- ${m}`)] : []),
    ...(units !== null ? [`当前累计完成量：${units}${duty.totalUnits !== null ? `/${duty.totalUnits}` : ""}`] : []),
    ...(recent.length
      ? ["近期进度（依据，按时间顺序）：", ...recent.map((p) => `- [${p.at}] ${p.summary}`)]
      : duty.progress.length > 0
        ? ["近期进度依据待核验：已有历史记录，但没有可用于当前目标的已应用依据。保留当前完成量与下一步，先核对授权资料；不要据此认定从未学习或从头重复学习。"]
        : ["近期进度：尚无记录，这是第一次推进。"]),
    ...(duty.awaitingMaterial
      ? ["当前状态：此前已报告缺少可用资料；若资料仍不可用，直接通过 report 置 awaitingMaterial=true 并说明，不要编造内容。"]
      : []),
    ...(excluded > 0
      ? [`历史（不构成当前依据）：另有 ${excluded} 条当前目标报告未应用或应用状态无法核验，已排除在上方依据之外；可通过进度纠错提交核实后的新记录。`]
      : []),
    `持久化的下一步：${duty.nextStep ?? "尚无；请依据目标与已有进度规划本次推进"}`,
    "执行要求：",
    "1. 依据下一步推进一小段实际工作，产出有依据的结论；不得编造学习结果。",
    "2. 完成后必须调用 duty_manage 的 report 操作提交：summary（本次学到了什么）、evidence（真实文件相对路径或工作引用）、nextStep（持久化下一步）；声明了总量时提交 unitsDone（累计完成量）。",
    "3. 缺少资料时 report 置 awaitingMaterial=true 并说明缺口，不要假装推进。",
  ]
    .join("\n")
    .slice(0, 100_000);
}

/** Deterministic preconditions before any model call; skips are persisted with reasons. */
/** Bring the consumption ledger up to date before any budget decision. */
async function refreshLedger(home: string, agentId: string): Promise<void> {
  await recordAdvancementReceipts(home, agentId);
}
/** Terminal advancement executions with no receipt yet: the budget cannot be trusted as complete. */
async function hasPendingMetering(home: string, agentId: string, duty: FriendDuty): Promise<boolean> {
  if (!duty.budget) return false;
  const agentState = await readLongAgentState(home);
  const taskState = await readTaskState(home, agentId);
  const task = taskState.tasks.find((t) => t.id === duty.taskId || t.dutyId === duty.id);
  if (!task) return false;
  return taskState.occurrences.some((o) => {
    if (o.taskId !== task.id || o.workId === null || o.dutyGoalRevision === undefined) return false;
    if (duty.advancements.some((a) => a.advancementKey === o.id)) return false;
    if (o.workId === null) return false;
    return terminalTurn(agentState, o.workId).terminal;
  });
}

function dutyGate(duty: FriendDuty, source: TaskOccurrence["source"], now: Date, pendingMetering = false): { reason: string | null; workText: string | null } {
  if (duty.status === "ended") return { reason: "职责已结束，历史保留；如需继续请新建职责", workText: null };
  if (duty.status === "paused" && source !== "manual") return { reason: "职责已暂停，自动推进等待恢复", workText: null };
  if (duty.materials.length === 0) return { reason: "缺少学习资料，等待用户在职责中补充", workText: null };
  if (duty.awaitingMaterial) return { reason: "等待资料：此前推进报告缺少可用材料，补充后恢复", workText: null };
  // Explicit manual advancement bypasses the clock and the budget; it is metered and recorded honestly.
  if (source !== "manual") {
    if (duty.nextCheckAt && Date.parse(duty.nextCheckAt) > now.getTime())
      return { reason: `未到下次检查时间（${duty.nextCheckAt}）`, workText: null };
    if (duty.allowedHours) {
      const hour = localHour(duty.timeZone, now);
      if (hour < duty.allowedHours.start || hour >= duty.allowedHours.end)
        return {
          reason: `不在允许时段（${duty.allowedHours.start}–${duty.allowedHours.end} 点 ${duty.timeZone}），等待下一次`,
          workText: null,
        };
    }
    if (duty.budget) {
      if (pendingMetering)
        return { reason: "推进计量待恢复（有已结束但未入账的执行），暂不自动推进", workText: null };
      const used = tokensToday(duty, now);
      if (used >= duty.budget.tokensPerDay)
        return {
          reason: `今日推进预算已耗尽（已计量 ${used}/${duty.budget.tokensPerDay} tokens），明日继续或手动推进`,
          workText: null,
        };
    }
  }
  return { reason: null, workText: composeAdvancementText(duty, now) };
}

export async function evaluateDutyOccurrence(
  home: string,
  agentId: string,
  task: FriendTask,
  source: TaskOccurrence["source"],
): Promise<{ reason: string | null; workText: string | null; goalRevision: number | null; dispatchRevision: number | null }> {
  if (!task.dutyId) return { reason: null, workText: null, goalRevision: null, dispatchRevision: null };
  await refreshLedger(home, agentId);
  const state = await readDutyState(home, agentId);
  const duty = state.duties.find((d) => d.id === task.dutyId);
  if (!duty) return { reason: "职责不存在或已被删除", workText: null, goalRevision: null, dispatchRevision: null };
  const gate = dutyGate(duty, source, new Date(), await hasPendingMetering(home, agentId, duty));
  if (gate.reason) return { reason: gate.reason, workText: null, goalRevision: null, dispatchRevision: null };
  return { reason: null, workText: gate.workText, goalRevision: duty.goalRevision, dispatchRevision: duty.revision };
}

/** Re-checked right before a queued occurrence starts: budget, clock, goal and lifecycle may have moved. */
export async function recheckDutyBeforeDispatch(
  home: string,
  agentId: string,
  occurrence: TaskOccurrence,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const dutyId = occurrence.definition.dutyId;
  if (!dutyId) return { ok: true };
  // The direct trigger path must also account terminal-but-unreceipted executions before judging budget.
  await refreshLedger(home, agentId);
  const duty = (await readDutyState(home, agentId)).duties.find((d) => d.id === dutyId);
  if (!duty) return { ok: false, reason: "职责不存在或已被删除" };
  if (occurrence.dutyGoalRevision !== undefined && occurrence.dutyGoalRevision !== duty.goalRevision)
    return { ok: false, reason: "目标已修订，取消旧推进；下一次按新目标规划" };
  const gate = dutyGate(duty, occurrence.source, new Date(), await hasPendingMetering(home, agentId, duty));
  if (gate.reason) return { ok: false, reason: gate.reason };
  return { ok: true };
}

/** Evidence must exist inside the authorized real path; symlinks may not escape the root. */
async function validateEvidence(home: string, agentId: string, duty: FriendDuty, evidence: DutyEvidence[]): Promise<void> {
  const state = await readLongAgentState(home);
  const rootContext = duty.contextProjectId
    ? await resolveProjectContext(duty.contextProjectId, home)
    : await resolveProjectContext(agentId, home);
  const root = await realpath(rootContext.projectRoot).catch(() => rootContext.projectRoot);
  for (const item of evidence) {
    if (item.kind === "work") {
      if (!state.works.some((w) => w.id === item.workId && w.longAgentId === duty.longAgentId))
        throw new FriendDutyError(400, "工作证据引用不存在或不属于本Friend");
      continue;
    }
    if (item.kind !== "file") continue;
    const path = item.path ?? "";
    if (isAbsolute(path) || path.split(/[\\/]/).includes(".."))
      throw new FriendDutyError(400, "文件证据必须是授权范围内的相对路径");
    const full = resolve(root, path);
    let real: string;
    try {
      real = await realpath(full);
    } catch {
      throw new FriendDutyError(400, `文件证据不存在：${path}`);
    }
    if (real !== root && !real.startsWith(root + sep))
      throw new FriendDutyError(400, "文件证据越出职责授权的范围");
    const info = await stat(real);
    if (!info.isFile()) throw new FriendDutyError(400, `文件证据不是普通文件：${path}`);
  }
}

interface DutyReport {
  summary: string;
  evidence: DutyEvidence[];
  unitsDone: number | null;
  nextStep: string | null;
  nextCheckAt: string | null;
  awaitingMaterial: boolean;
}
function parseUnits(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new FriendDutyError(400, "完成量必须是非负整数");
  return Number(value);
}
function parseReport(value: unknown): DutyReport {
  record(value);
  exact(value, ["summary", "evidence", "unitsDone", "nextStep", "nextCheckAt", "awaitingMaterial"]);
  if (!Array.isArray(value.evidence) || value.evidence.length > 20)
    throw new FriendDutyError(400, "证据列表无效");
  const awaitingMaterial = value.awaitingMaterial === true;
  const nextStep = value.nextStep === null ? null : string(value.nextStep, 65536);
  if (!awaitingMaterial && nextStep === null)
    throw new FriendDutyError(400, "报告必须给出持久化下一步，或明确置 awaitingMaterial 等待资料");
  return {
    summary: string(value.summary, 20000),
    evidence: value.evidence.map(parseEvidence),
    unitsDone: value.unitsDone === null || value.unitsDone === undefined ? null : parseUnits(value.unitsDone),
    nextStep,
    nextCheckAt: value.nextCheckAt === null || value.nextCheckAt === undefined ? null : timestamp(value.nextCheckAt),
    awaitingMaterial,
  };
}
function payloadOf(report: DutyReport): string {
  return hash([report.summary, report.evidence, report.unitsDone, report.nextStep, report.nextCheckAt, report.awaitingMaterial]);
}

/** Bind a report to its origin: a duty advancement work, or an explicit chat correction. */
interface ReportBinding {
  advancementKey: string;
  goalRevision: number;
  source: "agent" | "user";
  /** How the write is serialized: work reports against their frozen revision, interactive ones against a read. */
  mode: "work" | "chat" | "user";
  /** For work reports: the duty revision frozen when the advancement was accepted. */
  dispatchRevision: number | null;
}
async function resolveReportBinding(
  home: string,
  agentId: string,
  dutyId: string,
  duty: FriendDuty,
  body: Record<string, unknown>,
): Promise<ReportBinding> {
  if (body.source !== "agent")
    return { advancementKey: `user:${string(body.requestId)}`, goalRevision: duty.goalRevision, source: "user", mode: "user", dispatchRevision: null };
  const turnId = string(body.turnId);
  const state = await readLongAgentState(home);
  const turn = state.turns.find((t) => t.longAgentId === agentId && t.turnId === turnId);
  if (!turn) throw new FriendDutyError(400, "找不到该执行上下文");
  if (!turn.workId)
    // The Friend may correct progress from its own direct conversation; keyed by the management request.
    return { advancementKey: `chat:${string(body.requestId)}`, goalRevision: duty.goalRevision, source: "agent", mode: "chat", dispatchRevision: null };
  const work = state.works.find((w) => w.id === turn.workId);
  if (!work) throw new FriendDutyError(400, "后台工作绑定缺失");
  const taskState = await readTaskState(home, agentId);
  const occurrence = taskState.occurrences.find((o) => o.id === work.requestId);
  if (!occurrence || occurrence.definition.dutyId !== dutyId)
    throw new FriendDutyError(400, "该执行不属于此职责的推进");
  if (occurrence.workId !== work.id) throw new FriendDutyError(400, "执行记录与推进不匹配");
  return {
    advancementKey: occurrence.id,
    // A late result is attributed to the goal generation it ran under, never to the current one.
    goalRevision: occurrence.dutyGoalRevision ?? duty.goalRevision,
    source: "agent",
    mode: "work",
    dispatchRevision: occurrence.dutyDispatchRevision ?? null,
  };
}

export async function listFriendDuties(home: string, agentId: string) {
  await owner(home, agentId);
  const tasks = await listFriendTasks(home, agentId);
  const state = await readDutyState(home, agentId);
  const now = new Date();
  return {
    schemaVersion: 1 as const,
    longAgentId: agentId,
    projectionError: tasks.projectionError,
    duties: state.duties.map((duty) => {
      const linked = tasks.tasks.find((t) => t.id === duty.taskId || t.dutyId === duty.id) ?? null;
      const units = currentUnitsDone(duty);
      const used = tokensToday(duty, now);
      return {
        ...duty,
        unitsDone: units,
        percent:
          units !== null && duty.totalUnits !== null
            ? Math.max(0, Math.min(100, Math.round((units / duty.totalUnits) * 100)))
            : null,
        tokensToday: used,
        budgetExhausted: duty.budget ? used >= duty.budget.tokensPerDay : null,
        progress: duty.progress.map((p) => ({ ...p, superseded: p.goalRevision !== duty.goalRevision })),
        advancements: duty.advancements.map((a) => ({ ...a, superseded: a.goalRevision !== duty.goalRevision })),
        linkedTask: linked
          ? { id: linked.id, revision: linked.revision, status: linked.status, projection: linked.projection }
          : null,
        linkedOccurrences: linked ? tasks.occurrences.filter((o) => o.taskId === linked.id).slice().reverse() : [],
      };
    }),
  };
}

async function linkedTask(home: string, agentId: string, dutyId: string): Promise<FriendTask> {
  const state = await readTaskState(home, agentId);
  const task = state.tasks.find((t) => t.dutyId === dutyId);
  if (!task) throw new FriendDutyError(409, "职责推进任务尚未创建，请稍后重试；维护循环会自动重建");
  return task;
}

/** Compare-and-swap inside the state lock: a stale expectedRevision can never overwrite a newer change. */
async function withDutyCas<T>(
  home: string,
  agentId: string,
  dutyId: string,
  expectedRevision: number,
  change: (duty: FriendDuty, state: DutyState) => T,
): Promise<T> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
    throw new FriendDutyError(400, "expectedRevision无效");
  return changeDutyState(home, agentId, (state) => {
    const duty = state.duties.find((d) => d.id === dutyId);
    if (!duty) throw new FriendDutyError(404, "找不到职责");
    if (duty.revision !== expectedRevision) throw new FriendDutyError(409, "职责已修改，请刷新后重试");
    return change(duty, state);
  });
}
function replaceDuty(state: DutyState, next: FriendDuty): void {
  state.duties = state.duties.map((d) => (d.id === next.id ? next : d));
  state.revisions.push(next);
}

export async function manageFriendDuty(home: string, agentId: string, body: unknown) {
  const { agent } = await owner(home, agentId);
  record(body);
  exact(body, [
    "schemaVersion",
    "operation",
    "dutyId",
    "expectedRevision",
    "requestId",
    "definition",
    "report",
    "occurrenceId",
    "expectedTurnId",
    "turnId",
    "source",
  ]);
  if (body.schemaVersion !== 1)
    throw new FriendDutyError(400, "职责API要求schemaVersion 1，请刷新页面");
  const operation = string(body.operation);
  if (operation === "list") return listFriendDuties(home, agentId);
  if (!agent.enabled || agent.status === "archived")
    throw new FriendDutyError(409, "Friend已停用，不能创建或修改职责");

  if (operation === "create") {
    const input = parseDutyInput(body.definition);
    if (input.contextProjectId) {
      const context = await resolveProjectContext(input.contextProjectId, home);
      if (context.kind !== "project")
        throw new FriendDutyError(400, "请选择用户项目，Friend空间使用无项目上下文");
    }
    const dutyId = `duty-${hash([agentId, string(body.requestId)]).slice(0, 32)}`;
    const now = new Date().toISOString();
    const duty: FriendDuty = {
      ...input,
      id: dutyId,
      longAgentId: agentId,
      revision: 1,
      goalRevision: 1,
      status: "active",
      createdAt: now,
      updatedAt: now,
      endedAt: null,
      taskId: null,
      unitsDone: null,
      nextStep: null,
      nextCheckAt: null,
      awaitingMaterial: false,
      progress: [],
      advancements: [],
    };
    const created = await changeDutyState(home, agentId, (state) => {
      const old = state.duties.find((d) => d.id === dutyId);
      if (old) {
        const previous = parseDutyInput(
          Object.fromEntries(
            (
              [
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
              ] as const
            ).map((k) => [k, old[k]]),
          ),
        );
        if (JSON.stringify(previous) !== JSON.stringify(input))
          throw new FriendDutyError(409, "同一创建请求的内容已变化");
        return old;
      }
      state.duties.push(duty);
      state.revisions.push(duty);
      return duty;
    });
    try {
      await syncDutyTask(home, agentId, created);
      await alignTaskStatus(home, agentId, created);
    } catch (e) {
      return { ...(await listFriendDuties(home, agentId)), applied: false, syncError: syncMessage(e) };
    }
    await audit(home, agentId, "create", dutyId, created.revision);
    return { ...(await listFriendDuties(home, agentId)), applied: true };
  }

  const dutyId = parseDutyId(body.dutyId);
  const expected = body.expectedRevision;
  if (!Number.isSafeInteger(expected) || Number(expected) < 1)
    throw new FriendDutyError(400, "expectedRevision无效");

  if (operation === "report") {
    const report = parseReport(body.report);
    const payloadHash = payloadOf(report);
    // Binding and evidence need async reads outside the lock; the mutation below re-checks the revision.
    const pre = (await readDutyState(home, agentId)).duties.find((d) => d.id === dutyId);
    if (!pre) throw new FriendDutyError(404, "找不到职责");
    const binding = await resolveReportBinding(home, agentId, dutyId, pre, body);
    // A retry of an already committed report is idempotent even if the revision has moved on.
    const existingReport = pre.progress.find((p) => p.advancementKey === binding.advancementKey);
    if (existingReport) {
      if (existingReport.payloadHash !== "" && existingReport.payloadHash !== payloadHash)
        throw new FriendDutyError(409, "同一推进的进度报告内容已变化；纠正请使用用户纠错入口");
      return { ...(await listFriendDuties(home, agentId)), reportApplied: false };
    }
    // Interactive writers must serialize against what they read.
    const casRevision = binding.mode === "work" ? binding.dispatchRevision : Number(expected);
    if (binding.mode !== "work" && pre.revision !== Number(expected))
      throw new FriendDutyError(409, "职责已修改，请刷新后重试");
    await validateEvidence(home, agentId, pre, report.evidence);
    const at = new Date().toISOString();
    const entryId = `prog-${hash([dutyId, binding.advancementKey]).slice(0, 32)}`;
    let reportApplied = false;
    const updated = await changeDutyState(home, agentId, (state) => {
      const duty = state.duties.find((d) => d.id === dutyId);
      if (!duty) throw new FriendDutyError(404, "找不到职责");
      const existing = duty.progress.find((p) => p.advancementKey === binding.advancementKey);
      if (existing) {
        // Same advancement, same payload: idempotent. Different payload: a conflict, never a silent overwrite.
        if (existing.payloadHash !== "" && existing.payloadHash !== payloadHash)
          throw new FriendDutyError(409, "同一推进的进度报告内容已变化；纠正请使用用户纠错入口");
        return duty;
      }
      const isCurrentGoal = binding.goalRevision === duty.goalRevision && duty.status !== "ended";
      const casOk = casRevision === null || duty.revision === casRevision;
      // Interactive writers report a stale revision as a conflict; a background execution instead
      // merges into history, because it cannot retry with newer state and must not clobber the plan.
      if (!casOk && binding.mode !== "work")
        throw new FriendDutyError(409, "职责已修改，请刷新后重试");
      duty.progress.push({
        id: entryId,
        advancementKey: binding.advancementKey,
        payloadHash,
        at,
        source: binding.source,
        goalRevision: binding.goalRevision,
        applied: isCurrentGoal && casOk,
        summary: report.summary,
        evidence: report.evidence,
        unitsDone: report.unitsDone,
        nextStep: report.nextStep,
        nextCheckAt: report.nextCheckAt,
      });
      if (isCurrentGoal && casOk) {
        duty.unitsDone = report.unitsDone ?? duty.unitsDone;
        duty.nextStep = report.nextStep ?? duty.nextStep;
        duty.nextCheckAt = report.nextCheckAt ?? duty.nextCheckAt;
        duty.awaitingMaterial = report.awaitingMaterial;
        duty.revision += 1;
        duty.updatedAt = at;
        replaceDuty(state, duty);
        reportApplied = true;
      }
      return duty;
    });
    if (reportApplied) await syncQuietly(home, agentId, updated);
    await audit(home, agentId, "report", dutyId, updated.revision);
    return { ...(await listFriendDuties(home, agentId)), reportApplied };
  }

  if (operation === "advance" || operation === "cancel-advance") {
    const validated = await withDutyCas(home, agentId, dutyId, Number(expected), (duty) => duty);
    if (validated.status === "ended") throw new FriendDutyError(409, "职责已结束，不能推进；请新建职责");
    const task = await linkedTask(home, agentId, dutyId);
    if (operation === "advance") {
      await manageFriendTask(home, agentId, {
        schemaVersion: 2,
        operation: "run",
        taskId: task.id,
        expectedRevision: task.revision,
        requestId: string(body.requestId),
      });
    } else {
      await manageFriendTask(home, agentId, {
        schemaVersion: 2,
        operation: "cancel-run",
        taskId: task.id,
        expectedRevision: task.revision,
        occurrenceId: body.occurrenceId === undefined ? undefined : string(body.occurrenceId),
        expectedTurnId: body.expectedTurnId === undefined ? undefined : string(body.expectedTurnId),
      });
    }
    return listFriendDuties(home, agentId);
  }

  if (!["update", "pause", "resume", "end"].includes(operation))
    throw new FriendDutyError(400, "未知职责操作");

  let input: ReturnType<typeof parseDutyInput> | null = null;
  if (operation === "update") {
    input = parseDutyInput(body.definition);
    if (input.contextProjectId) {
      const context = await resolveProjectContext(input.contextProjectId, home);
      if (context.kind !== "project")
        throw new FriendDutyError(400, "请选择用户项目，Friend空间使用无项目上下文");
    }
  }
  const now = new Date().toISOString();
  const updated = await withDutyCas(home, agentId, dutyId, Number(expected), (duty, state) => {
    if (operation === "resume" && duty.status === "ended")
      throw new FriendDutyError(409, "已结束的职责不能恢复；保留历史，请新建职责");
    let next: FriendDuty;
    if (operation === "update" && input) {
      const goalChangedByInput = goalChanged(duty, input);
      next = {
        ...duty,
        ...input,
        // Lifecycle and configuration changes advance the concurrency version; only a goal
        // change advances the goal generation (progress and its plan stay valid otherwise).
        revision: duty.revision + 1,
        goalRevision: goalChangedByInput ? duty.goalRevision + 1 : duty.goalRevision,
        updatedAt: now,
        ...(goalChangedByInput ? { unitsDone: null, nextStep: null, nextCheckAt: null } : {}),
        awaitingMaterial:
          duty.materials.length === 0 && input.materials.length > 0 ? false : duty.awaitingMaterial,
      };
    } else {
      next = {
        ...duty,
        revision: duty.revision + 1,
        status: operation === "pause" ? "paused" : operation === "resume" ? "active" : "ended",
        updatedAt: now,
        ...(operation === "end" ? { endedAt: now } : {}),
      };
    }
    replaceDuty(state, next);
    return next;
  });
  await syncQuietly(home, agentId, updated);
  await audit(home, agentId, operation, dutyId, updated.revision);
  return { ...(await listFriendDuties(home, agentId)), applied: true };
}

function syncMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function audit(home: string, agentId: string, operation: string, dutyId: string, revision: number) {
  await appendChatAuditEvent(
    {
      action: `long-agent.duty.${operation}`,
      target: { type: "long-agent", longAgentId: agentId },
      details: { dutyId, revision },
    },
    home,
  );
}

/** Tokens for a terminal turn: a number, or null when metering failed and must be retried (never a permanent zero). */
async function measureTurnTokens(home: string, agentId: string, sessionId: string, turnId: string): Promise<number | null> {
  let session: Awaited<ReturnType<typeof openChatSession>>;
  try {
    session = await openChatSession({ chatHome: home, projectId: agentId, sessionId });
  } catch (e) {
    // The native session is gone; there is nothing left to measure.
    console.error("推进会话已不可读，按零计量入账", e instanceof Error ? e.message : e);
    return 0;
  }
  try {
    const branch = session.manager.getBranch();
    const first = branch.findIndex(
      (e) =>
        e.type === "custom" &&
        e.customType === "chat.long_agent_turn" &&
        typeof e.data === "object" &&
        e.data !== null &&
        "turnId" in e.data &&
        (e.data as { turnId?: unknown }).turnId === turnId,
    );
    if (first < 0) return 0;
    return branch
      .slice(first + 1)
      .reduce(
        (sum, e) =>
          e.type === "message" && e.message.role === "assistant" && e.message.usage
            ? sum + (e.message.usage.totalTokens ?? 0)
            : sum,
        0,
      );
  } catch (e) {
    console.error("推进Token计量待恢复", e instanceof Error ? e.message : e);
    return null;
  }
}

function terminalTurn(agentState: Awaited<ReturnType<typeof readLongAgentState>>, workId: string) {
  const work = agentState.works.find((w) => w.id === workId);
  const turn = agentState.turns.filter((t) => t.workId === workId).at(-1);
  return { work, turn, terminal: turn !== undefined && !["queued", "running"].includes(turn.status) };
}

/** Idempotent receipts for terminal advancement works; crash-safe via reconcile. */
async function recordAdvancementReceipts(home: string, agentId: string): Promise<void> {
  const state = await readDutyState(home, agentId);
  const agentState = await readLongAgentState(home);
  const taskState = await readTaskState(home, agentId);
  for (const duty of state.duties) {
    const task = taskState.tasks.find((t) => t.id === duty.taskId || t.dutyId === duty.id);
    if (!task) continue;
    for (const occurrence of taskState.occurrences.filter(
      (o) => o.taskId === task.id && o.workId !== null && o.dutyGoalRevision !== undefined,
    )) {
      if (duty.advancements.some((a) => a.advancementKey === occurrence.id)) continue;
      if (occurrence.workId === null) continue;
      const { work, turn, terminal } = terminalTurn(agentState, occurrence.workId);
      if (!work || !turn || !terminal) continue;
      const tokens = await measureTurnTokens(home, agentId, work.sessionId, turn.turnId);
      if (tokens === null) continue; // retry on the next ledger refresh
      await changeDutyState(home, agentId, (s) => {
        const d = s.duties.find((entry) => entry.id === duty.id);
        if (!d || d.advancements.some((a) => a.advancementKey === occurrence.id)) return;
        d.advancements.push({
          advancementKey: occurrence.id,
          workId: work.id,
          goalRevision: occurrence.dutyGoalRevision ?? d.goalRevision,
          status: turn.status as "completed" | "failed" | "cancelled" | "interrupted",
          tokens,
          at: new Date().toISOString(),
        });
      });
    }
  }
}

/** Single maintenance owner: crash recovery and task re-creation, no second dispatcher. */
export async function reconcileFriendDuties(home: string, agentId: string): Promise<void> {
  const state = await readDutyState(home, agentId);
  for (const duty of state.duties) {
    await syncQuietly(home, agentId, duty);
  }
  try {
    await recordAdvancementReceipts(home, agentId);
  } catch (e) {
    console.error("职责推进回执待恢复", e instanceof Error ? e.message : e);
  }
}
