import { createHash } from "node:crypto";
import { readLongAgentRegistry } from "../storage.js";
import { requestTaskProjection } from "../nanoclaw-client.js";
import { ensureProjectLongAgent } from "../project-agent.js";
import { resolveProjectContext } from "../../projects/registry.js";
import { appendChatAuditEvent } from "../../audit-log.js";
import { withFileLock } from "../../persistence/versioned-file.js";
import {
  FriendWorkCapacityError,
  MAX_FRIEND_BACKGROUND_WORK,
  startFriendWork,
  listFriendWork,
  cancelFriendWork,
} from "../work.js";
import { changeTaskState, readTaskState, taskFile } from "./storage.js";
import {
  FriendTaskError,
  record,
  exact,
  string,
  timestamp,
  parseTaskInput,
  parseDutyId,
  type FriendTask,
  type TaskOccurrence,
} from "./contract.js";
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
async function owner(home: string, id: string) {
  const registry = await readLongAgentRegistry(home);
  const agent = registry.agents.find((a) => a.id === id);
  if (!agent) throw new FriendTaskError(404, "找不到Friend");
  const instance = registry.instances.find((i) => i.id === agent.instanceId);
  if (!instance) throw new FriendTaskError(409, "Friend实例配置缺失");
  return { agent, instance };
}
function projection(
  task: FriendTask,
  group: string,
  enabled = task.status === "active",
) {
  return {
    schemaVersion: 1,
    taskId: task.id,
    agentGroupId: group,
    revision: task.revision,
    enabled,
    schedule: task.schedule,
    timeZone: task.timeZone,
    missed: task.missed,
  };
}
async function apply(home: string, agentId: string, task: FriendTask) {
  const { instance, agent } = await owner(home, agentId);
  const value = await requestTaskProjection(instance, {
    schemaVersion: 1,
    operation: "apply",
    projection: projection(task, agent.nanoclawAgentGroupId),
  });
  record(value);
  if (
    value.schemaVersion !== 1 ||
    value.taskId !== task.id ||
    value.revision !== task.revision ||
    (value.nextAt !== null && typeof value.nextAt !== "string")
  )
    throw new FriendTaskError(502, "调度投影响应无效");
  return value;
}
/** Legacy ownership is claimed in Nano before any Chat projection is enabled. Retry resumes the same captured snapshot. */
export async function migrateFriendTasks(
  home: string,
  id: string,
): Promise<void> {
  await withFileLock(`${taskFile(home, id)}.migration`, async () => {
    if ((await readTaskState(home, id)).migration === "complete") return;
    const { instance, agent } = await owner(home, id);
    const value = await requestTaskProjection(instance, {
      schemaVersion: 1,
      operation: "claim",
      agentGroupId: agent.nanoclawAgentGroupId,
    });
    record(value);
    if (
      value.schemaVersion !== 1 ||
      !Array.isArray(value.tasks) ||
      typeof value.timeZone !== "string"
    )
      throw new FriendTaskError(502, "旧任务迁移响应无效");
    const migrated: FriendTask[] = value.tasks.map((raw) => {
      record(raw);
      const legacyId = string(raw.id);
      const createdAt = timestamp(raw.createdAt);
      const task = parseTaskInput({
        name: legacyId.slice(0, 120),
        prompt: string(raw.prompt, 65536),
        contextProjectId: null,
        timeZone: value.timeZone,
        schedule: raw.recurrence
          ? { kind: "cron", expression: raw.recurrence }
          : { kind: "once", at: raw.processAfter },
        missed: "skip",
        overlap: "skip",
      });
      const expired =
        task.schedule.kind === "once" &&
        Date.parse(task.schedule.at) <= Date.now();
      return {
        ...task,
        id: `task-${hash([id, "legacy", legacyId]).slice(0, 32)}`,
        longAgentId: id,
        revision: 1,
        status:
          raw.status === "paused" || raw.script != null || expired
            ? "paused"
            : "active",
        createdAt,
        updatedAt: new Date().toISOString(),
        legacyId,
        ...(expired
          ? {
              migrationNote:
                "迁移时一次性任务已到期，已暂停。请确认旧执行结果后，编辑为新的执行时间再恢复，避免重复工作。",
            }
          : {}),
        ...(raw.script != null
          ? {
              migrationNote:
                "旧任务包含前置脚本，已暂停；脚本保存在NanoClaw迁移快照中。请编辑为明确的模型任务后再启用。",
            }
          : {}),
      };
    });
    const target = await resolveProjectContext(agent.defaultProjectId, home);
    await changeTaskState(home, id, (state) => {
      if (state.migration === "complete") return;
      for (const task of migrated)
        if (!state.tasks.some((t) => t.id === task.id))
          state.tasks.push({
            ...task,
            contextProjectId:
              target.kind === "project" ? target.projectId : null,
          });
      state.revisions = [...state.tasks];
      state.migration = "complete";
    });
  });
}
export async function listFriendTasks(home: string, id: string) {
  const { instance, agent } = await owner(home, id);
  let projectionError: string | null = null;
  try {
    await migrateFriendTasks(home, id);
  } catch {
    projectionError =
      "尚未完成任务所有权迁移，请检查NanoClaw连接与版本后刷新。";
  }
  const state = await readTaskState(home, id);
  let projections: {
    taskId: string;
    revision: number;
    nextAt: string | null;
  }[] = [];
  try {
    const response = await requestTaskProjection(instance, {
      schemaVersion: 1,
      operation: "list",
      agentGroupId: agent.nanoclawAgentGroupId,
    });
    record(response);
    if (response.schemaVersion !== 1 || !Array.isArray(response.projections))
      throw new Error("invalid projection list");
    projections = response.projections.map((v) => {
      record(v);
      if (!Number.isSafeInteger(v.revision) || Number(v.revision) < 1)
        throw new Error("invalid projection revision");
      return {
        taskId: string(v.taskId),
        revision: Number(v.revision),
        nextAt: v.nextAt === null ? null : timestamp(v.nextAt),
      };
    });
  } catch {
    projectionError ??=
      "调度服务暂时不可用；已保存的定义保留，应用状态待确认。";
  }
  const works = await listFriendWork(home, id);
  return {
    schemaVersion: 2 as const,
    longAgentId: id,
    migration: state.migration,
    projectionError,
    tasks: state.tasks.map((task) => ({
      ...task,
      projection:
        projections.find(
          (p) => p.taskId === task.id && p.revision === task.revision,
        ) ?? null,
    })),
    occurrences: state.occurrences.map((o) => ({
      id: o.id,
      taskId: o.taskId,
      revision: o.revision,
      source: o.source,
      scheduledAt: o.scheduledAt,
      state: o.state,
      reason: o.reason,
      workId: o.workId,
      work: works.works.find((w) => w.work.id === o.workId) ?? null,
    })),
  };
}
export async function manageFriendTask(
  home: string,
  id: string,
  body: unknown,
) {
  const { agent, instance } = await owner(home, id);
  record(body);
  exact(body, [
    "schemaVersion",
    "operation",
    "taskId",
    "expectedRevision",
    "requestId",
    "definition",
    "occurrenceId",
    "expectedTurnId",
    "dutyId",
  ]);
  if (body.schemaVersion !== 2)
    throw new FriendTaskError(400, "任务API要求schemaVersion 2，请刷新页面");
  const operation = string(body.operation);
  if (operation === "list") return listFriendTasks(home, id);
  if (!agent.enabled || agent.status === "archived")
    throw new FriendTaskError(409, "Friend已停用，不能创建或修改任务");
  await migrateFriendTasks(home, id);
  if (operation === "cancel-run") {
    await withFileLock(`${taskFile(home, id)}.dispatch`, async () => {
      const occurrence = (await readTaskState(home, id)).occurrences.find(
        (o) => o.id === body.occurrenceId,
      );
      if (!occurrence) throw new FriendTaskError(404, "找不到此次执行");
      if (occurrence.workId)
        await cancelFriendWork(
          home,
          id,
          occurrence.workId,
          string(body.expectedTurnId),
        );
      else if (occurrence.state === "accepted")
        await changeTaskState(home, id, (state) => {
          const current = state.occurrences.find(
            (o) => o.id === occurrence.id,
          )!;
          current.state = "skipped";
          current.reason = "用户取消了此次等待执行";
        });
    });
    return listFriendTasks(home, id);
  }
  if (operation === "run") {
    const task = (await readTaskState(home, id)).tasks.find(
      (t) => t.id === body.taskId,
    );
    if (!task || task.revision !== body.expectedRevision)
      throw new FriendTaskError(409, "任务已变更，请刷新");
    if (task.migrationNote) throw new FriendTaskError(409, task.migrationNote);
    await acceptTaskTrigger(home, {
      schemaVersion: 1,
      instanceId: instance.id,
      agentGroupId: agent.nanoclawAgentGroupId,
      taskId: task.id,
      revision: task.revision,
      source: "manual",
      sourceId: string(body.requestId),
      scheduledAt: new Date().toISOString(),
    });
    return listFriendTasks(home, id);
  }
  if (!["create", "update", "pause", "resume", "cancel"].includes(operation))
    throw new FriendTaskError(400, "未知任务操作");
  const input =
    operation === "create" || operation === "update"
      ? parseTaskInput(body.definition)
      : null;
  if (input?.contextProjectId) {
    const context = await resolveProjectContext(input.contextProjectId, home);
    if (context.kind !== "project")
      throw new FriendTaskError(
        400,
        "请选择用户项目，Friend空间使用无项目上下文",
      );
  }
  const taskId =
    operation === "create"
      ? `task-${hash([id, string(body.requestId)]).slice(0, 32)}`
      : string(body.taskId);
  if (input) {
    const response = await requestTaskProjection(instance, {
      schemaVersion: 1,
      operation: "preview",
      projection: projection(
        {
          ...input,
          id: taskId,
          longAgentId: id,
          revision: 1,
          status: "active",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        agent.nanoclawAgentGroupId,
      ),
    });
    record(response);
    if (
      response.schemaVersion !== 1 ||
      (response.nextAt !== null && typeof response.nextAt !== "string")
    )
      throw new FriendTaskError(502, "调度预览无效");
  }
  const task = await changeTaskState(home, id, (state) => {
    const old = state.tasks.find((t) => t.id === taskId);
    const now = new Date().toISOString();
    if (operation === "create" && old) {
      const previous = parseTaskInput(
        Object.fromEntries(
          Object.keys(input!).map((k) => [k, old[k as keyof FriendTask]]),
        ),
      );
      if (JSON.stringify(previous) !== JSON.stringify(input))
        throw new FriendTaskError(409, "同一创建请求的内容已变化");
      return old;
    }
    if (
      operation !== "create" &&
      (!old ||
        old.revision !== body.expectedRevision ||
        old.status === "cancelled")
    )
      throw new FriendTaskError(409, "任务已修改或取消，请刷新后重试");
    if (operation === "resume" && old?.migrationNote)
      throw new FriendTaskError(409, old.migrationNote);
    const task: FriendTask = old
      ? {
          ...old,
          ...(input ?? {}),
          revision: old.revision + 1,
          updatedAt: now,
          status:
            operation === "pause"
              ? "paused"
              : operation === "resume"
                ? "active"
                : operation === "cancel"
                  ? "cancelled"
                  : old.status,
        }
      : {
          ...input!,
          id: taskId,
          longAgentId: id,
          revision: 1,
          status: "active",
          createdAt: now,
          updatedAt: now,
        };
    if (body.dutyId !== undefined) task.dutyId = parseDutyId(body.dutyId);
    if (operation === "update") delete task.migrationNote;
    state.tasks = [...state.tasks.filter((t) => t.id !== taskId), task];
    state.revisions.push(task);
    return task;
  });
  // Desired state is durable even when Nano is down. The reconciler retries the same revision.
  let applied = true;
  try {
    await apply(home, id, task);
  } catch {
    applied = false;
  }
  await appendChatAuditEvent(
    {
      action: `long-agent.task.${operation}`,
      target: { type: "long-agent", longAgentId: id },
      details: { taskId, revision: task.revision, applied },
    },
    home,
  );
  return { ...(await listFriendTasks(home, id)), applied };
}
export async function acceptTaskTrigger(home: string, value: unknown) {
  record(value);
  exact(value, [
    "schemaVersion",
    "instanceId",
    "agentGroupId",
    "taskId",
    "revision",
    "source",
    "sourceId",
    "scheduledAt",
  ]);
  if (
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    !["time", "event", "manual"].includes(String(value.source))
  )
    throw new FriendTaskError(400, "任务触发合同无效");
  const registry = await readLongAgentRegistry(home);
  const agent = registry.agents.find(
    (a) =>
      a.instanceId === value.instanceId &&
      a.nanoclawAgentGroupId === value.agentGroupId,
  );
  if (!agent) throw new FriendTaskError(404, "触发来源未绑定Friend");
  const sourceId = string(value.sourceId),
    source = value.source as TaskOccurrence["source"],
    taskId = string(value.taskId);
  const scheduledAt = timestamp(value.scheduledAt);
  const receivedAt = new Date().toISOString();
  const id = `occ-${hash([taskId, value.revision, source, sourceId])}`;
  // Manual retries reuse requestId, not the browser's retry clock.
  const payloadHash = hash([
    taskId,
    value.revision,
    source,
    sourceId,
    source === "manual" ? null : scheduledAt,
  ]);
  await changeTaskState(home, agent.id, async (state) => {
    const old = state.occurrences.find((o) => o.id === id);
    if (old) {
      if (old.payloadHash !== payloadHash)
        throw new FriendTaskError(409, "同一触发事件内容冲突");
      return;
    }
    const current = state.tasks.find((t) => t.id === taskId);
    const task = state.revisions.find(
      (t) => t.id === taskId && t.revision === value.revision,
    );
    if (!current || !task) throw new FriendTaskError(404, "任务不存在");
    if (
      source === "event" &&
      (task.schedule.kind !== "event" ||
        !sourceId.startsWith(`${task.schedule.source}:`))
    )
      throw new FriendTaskError(403, "事件来源未授权");
    if (
      source === "time" &&
      (task.schedule.kind === "event" ||
        sourceId !== `${task.timeZone}:${scheduledAt}`)
    )
      throw new FriendTaskError(400, "定时来源不匹配");
    let reason =
      !agent.enabled || agent.status === "archived"
        ? "Friend已停用"
        : task.migrationNote
          ? task.migrationNote
          : current.revision !== value.revision
            ? "旧任务版本已失效"
            : task.status === "cancelled" ||
                (task.status === "paused" && source !== "manual")
              ? "任务已暂停或取消"
              : source === "time" &&
                  task.missed === "skip" &&
                  Date.parse(receivedAt) - Date.parse(scheduledAt) > 300_000
                ? "错过计划时间，按配置跳过"
                : null;
    // Duty preconditions are deterministic and run before any model call.
    let dutyGoalRevision: number | null = null;
    let dutyDispatchRevision: number | null = null;
    let workText: string | null = null;
    if (!reason && task.dutyId) {
      const duties = await import("../duties/service.js");
      const evaluated = await duties.evaluateDutyOccurrence(home, agent.id, task, source);
      if (evaluated.reason) reason = evaluated.reason;
      else {
        dutyGoalRevision = evaluated.goalRevision;
        dutyDispatchRevision = evaluated.dispatchRevision;
        workText = evaluated.workText;
      }
    }
    // A deliverable task carries the system instruction for the LA4 artifact loop, frozen here.
    if (!reason && task.deliverable) {
      const artifacts = await import("../artifacts/service.js");
      const instruction = artifacts.describeArtifactInstruction({ definition: task });
      if (instruction !== null) workText = `${workText ?? task.prompt}\n${instruction}`;
    }
    const inProgress = state.occurrences.filter(
      (o) => o.taskId === taskId && o.state === "accepted",
    );
    if (inProgress.length > 0) reason ??= "已有一次等待执行，避免无限积压";
    state.occurrences.push({
      id,
      taskId,
      revision: task.revision,
      definition: task,
      source,
      sourceId,
      scheduledAt,
      receivedAt,
      payloadHash,
      originSessionId: null,
      state: reason ? "skipped" : "accepted",
      reason,
      workId: null,
      ...(dutyGoalRevision === null ? {} : { dutyGoalRevision }),
      ...(dutyDispatchRevision === null ? {} : { dutyDispatchRevision }),
      ...(workText === null ? {} : { workText }),
    });
  });
  void dispatchTaskOccurrences(home, agent.id).catch((error) =>
    console.error("任务触发等待恢复", error),
  );
  return {
    schemaVersion: 1 as const,
    accepted: true as const,
    occurrenceId: id,
  };
}
export async function dispatchTaskOccurrences(
  home: string,
  id: string,
): Promise<void> {
  await withFileLock(`${taskFile(home, id)}.dispatch`, async () => {
    const { agent } = await owner(home, id);
    const state = await readTaskState(home, id);
    for (const occurrence of state.occurrences.filter(
      (o) => o.state === "accepted",
    )) {
      const active = (await listFriendWork(home, id)).works.filter(
        (w) =>
          w.execution && ["queued", "running"].includes(w.execution.status),
      );
      const siblings = state.occurrences
        .filter((o) => o.taskId === occurrence.taskId && o.id !== occurrence.id)
        .map((o) => o.workId);
      if (active.some((w) => siblings.includes(w.work.id))) {
        if (occurrence.definition.overlap === "skip")
          await changeTaskState(home, id, (s) => {
            const o = s.occurrences.find((o) => o.id === occurrence.id)!;
            o.state = "skipped";
            o.reason = "前次运行未结束，按配置跳过";
          });
        continue;
      }
      if (active.length >= MAX_FRIEND_BACKGROUND_WORK) continue;
      // A queued advancement may have gone stale while waiting: re-check budget, clock, goal and lifecycle.
      if (occurrence.definition.dutyId) {
        const duties = await import("../duties/service.js");
        const check = await duties.recheckDutyBeforeDispatch(home, id, occurrence);
        if (!check.ok) {
          await changeTaskState(home, id, (s) => {
            const current = s.occurrences.find((o) => o.id === occurrence.id)!;
            current.state = "skipped";
            current.reason = check.reason;
          });
          continue;
        }
      }
      let workId: string;
      try {
        let originSessionId = occurrence.originSessionId;
        if (!originSessionId) {
          originSessionId = (
            await ensureProjectLongAgent({
              chatHome: home,
              agent,
              projectId: id,
            })
          ).projectAgent.primarySessionId;
          await changeTaskState(home, id, (s) => {
            s.occurrences.find((o) => o.id === occurrence.id)!.originSessionId =
              originSessionId;
          });
        }
        const result = await startFriendWork({
          chatHome: home,
          longAgentId: id,
          originSessionId,
          requestId: occurrence.id,
          contextProjectId: occurrence.definition.contextProjectId,
          title: occurrence.definition.name,
          // Duty advancement text was composed and frozen at durable acceptance,
          // so retrying the same occurrence reproduces the identical payload.
          text: occurrence.workText ?? occurrence.definition.prompt,
        });
        workId = result.work.id;
      } catch (e) {
        if (e instanceof FriendWorkCapacityError) continue;
        // A native acceptance may already exist when a later persistence step fails.
        // Retry the same binding instead of inviting a second model execution.
        if ((await listFriendWork(home, id)).works.some(w => w.work.requestId === occurrence.id && w.execution)) continue;
        await changeTaskState(home, id, (s) => {
          const o = s.occurrences.find((o) => o.id === occurrence.id)!;
          o.state = "blocked";
          o.reason =
            "无法接受执行，请检查Friend、项目和模型配置后手动运行新一次任务";
        });
        console.error("任务执行接受失败", e);
        continue;
      }
      // A failed pointer commit leaves the durable occurrence accepted for reconciliation.
      await changeTaskState(home, id, s => {
        const current = s.occurrences.find(o => o.id === occurrence.id)!;
        current.state = "started"; current.workId = workId;
      });
    }
  });
}
const activeMaintenance = new Map<string, Promise<void>>();
export function reconcileFriendTasks(home: string): Promise<void> {
  const previous = activeMaintenance.get(home);
  if (previous) return previous;
  const run = (async () => {
    for (const agent of (await readLongAgentRegistry(home)).agents) {
      try {
        await migrateFriendTasks(home, agent.id);
        const state = await readTaskState(home, agent.id);
        for (const task of state.tasks) {
          try {
            await apply(home, agent.id, task);
          } catch {
            /* Keep desired revisions for the next reconciliation. */
          }
        }
      } catch (e) {
        console.error(
          `Friend ${agent.id} 任务调度待同步`,
          e instanceof Error ? e.message : e,
        );
      }
      try {
        // Receipts (and therefore budget) must be recorded before new dispatch decisions.
        const duties = await import("../duties/service.js");
        await duties.reconcileFriendDuties(home, agent.id);
      } catch (e) {
        console.error(`Friend ${agent.id} 职责待恢复`, e);
      }
      try {
        // Artifact receipts are verified by identity: never re-run the model for an unknown side effect.
        const artifacts = await import("../artifacts/service.js");
        await artifacts.reconcileFriendArtifacts(home, agent.id);
      } catch (e) {
        console.error(`Friend ${agent.id} 产物待核查`, e);
      }
      try {
        await dispatchTaskOccurrences(home, agent.id);
      } catch (e) {
        console.error(`Friend ${agent.id} 任务执行待恢复`, e);
      }
    }
  })();
  activeMaintenance.set(home, run);
  const clear = () => {
    if (activeMaintenance.get(home) === run) activeMaintenance.delete(home);
  };
  void run.then(clear, clear);
  return run;
}
