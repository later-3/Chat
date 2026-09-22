import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture } from "./daily-fixture.mjs";
import { manageFriendDuty, listFriendDuties, reconcileFriendDuties } from "../../src/long-agents/duties/service.ts";
import { readDutyState, changeDutyState } from "../../src/long-agents/duties/storage.ts";
import { manageFriendTask, acceptTaskTrigger, dispatchTaskOccurrences } from "../../src/long-agents/tasks/service.ts";
import { readTaskState, changeTaskState } from "../../src/long-agents/tasks/storage.ts";
import { readLongAgentState } from "../../src/long-agents/storage.ts";
import { drainLongAgentTurns } from "../../src/long-agents/turn-queue.ts";
import { executeLongAgentTurn } from "../../src/long-agents/runtime.ts";

const definition = (over = {}) => ({
  name: "道德经学习", objective: "OBJECTIVE_A", materials: ["materials/daodejing.txt"], outcome: "OUTCOME_NOTES",
  contextProjectId: null, timeZone: "Asia/Shanghai", cadence: { kind: "none" }, allowedHours: null, budget: null, totalUnits: null, ...over,
});
async function setup(t) {
  const f = await fixture(t); const projections = new Map(); let offline = false;
  const original = globalThis.fetch; const token = process.env.CHAT_CHANNEL_GATEWAY_TOKEN;
  process.env.CHAT_CHANNEL_GATEWAY_TOKEN = "test-duty-projection-token-32-characters-long";
  t.after(() => { if (token === undefined) delete process.env.CHAT_CHANNEL_GATEWAY_TOKEN; else process.env.CHAT_CHANNEL_GATEWAY_TOKEN = token; });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (!String(url).includes("/v1/task-projections")) return original(url, init);
    if (offline) throw new Error("offline");
    const body = JSON.parse(init.body);
    if (body.operation === "claim") return Response.json({ schemaVersion: 1, timeZone: "Asia/Shanghai", tasks: [] });
    if (body.operation === "preview") return Response.json({ schemaVersion: 1, nextAt: null });
    if (body.operation === "apply") { const p = body.projection; projections.set(p.taskId, { taskId: p.taskId, revision: p.revision, nextAt: null }); return Response.json({ schemaVersion: 1, ...projections.get(p.taskId) }); }
    return Response.json({ schemaVersion: 1, projections: [...projections.values()] });
  });
  const command = (body) => manageFriendDuty(f.home, "friend", { schemaVersion: 1, source: "user", ...body });
  return { ...f, command, offline: v => { offline = v; } };
}
async function settle(f) {
  await dispatchTaskOccurrences(f.home, "friend");
  const { listFriendWork } = await import("../../src/long-agents/work.ts");
  for (const item of (await listFriendWork(f.home, "friend")).works) await drainLongAgentTurns(f.home, "friend", item.work.sessionId);
  await dispatchTaskOccurrences(f.home, "friend");
}
async function workTurn(f, index = 0) {
  const state = await readLongAgentState(f.home);
  return state.turns.filter(t => t.workId !== undefined)[index];
}
async function revOf(f, dutyId) {
  return (await readDutyState(f.home, "friend")).duties.find(d => d.id === dutyId).revision;
}
/** Reports advance the concurrency version, so each interactive report re-reads it first. */
async function reportCmd(f, dutyId, rest) {
  return f.command({ operation: "report", dutyId, expectedRevision: await revOf(f, dutyId), ...rest });
}
async function dutyTask(f, duty) {
  return (await readTaskState(f.home, "friend")).tasks.find(x => x.dutyId === duty.id);
}
const manualTrigger = (task, sourceId = `manual-${Math.random()}`) => ({
  schemaVersion: 1, instanceId: "local", agentGroupId: "group", taskId: task.id, revision: task.revision,
  source: "manual", sourceId, scheduledAt: new Date().toISOString(),
});
const timeTrigger = (task, at = new Date().toISOString()) => ({
  schemaVersion: 1, instanceId: "local", agentGroupId: "group", taskId: task.id, revision: task.revision,
  source: "time", sourceId: `${task.timeZone}:${at}`, scheduledAt: at,
});

test("LA3 cadence none stays dormant; cron creates and applies a linked duty task", async t => {
  const f = await setup(t);
  const create = { operation: "create", requestId: "d1", definition: definition() };
  const created = await f.command(create);
  assert.equal(created.duties.length, 1);
  assert.equal(created.duties[0].linkedTask.status, "paused");
  assert.equal((await f.command(create)).duties.length, 1);
  const cron = await f.command({ operation: "update", dutyId: created.duties[0].id, expectedRevision: 1, definition: definition({ cadence: { kind: "cron", expression: "0 8 * * *" } }) });
  assert.equal(cron.duties[0].revision, 2);
  assert.equal(cron.duties[0].linkedTask.status, "active");
  assert.equal(cron.duties[0].linkedTask.projection?.nextAt, null);
  const tasks = (await readTaskState(f.home, "friend")).tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].dutyId, created.duties[0].id);
  assert.match(tasks[0].prompt, /dutyId=/);
});

test("LA3 manual advancement composes duty text and reports persist progress and next step", async t => {
  const f = await setup(t);
  const duty = (await f.command({ operation: "create", requestId: "d2", definition: definition() })).duties[0];
  await f.command({ operation: "advance", dutyId: duty.id, expectedRevision: 1, requestId: "adv-1" });
  await settle(f);
  const firstRequest = f.requests[0];
  const composed = JSON.stringify(firstRequest);
  assert.match(composed, /OBJECTIVE_A/);
  assert.match(composed, /materials\/daodejing\.txt/);
  assert.match(composed, /duty_manage/);
  const turn = await workTurn(f);
  const report = await f.command({
    operation: "report", dutyId: duty.id, expectedRevision: 1, source: "agent", turnId: turn.turnId,
    report: { summary: "SUMMARY_FIRST", evidence: [{ kind: "note", text: "依据第一段" }], unitsDone: 1, nextStep: "NEXT_STEP_2", nextCheckAt: null, awaitingMaterial: false },
  });
  assert.equal(report.duties[0].nextStep, "NEXT_STEP_2");
  assert.equal(report.duties[0].unitsDone, 1);
  assert.equal(report.duties[0].progress.length, 1);
  // Idempotent recommit for the same advancement: identical payload, no double counting.
  const again = await f.command({
    operation: "report", dutyId: duty.id, expectedRevision: 1, source: "agent", turnId: turn.turnId,
    report: { summary: "SUMMARY_FIRST", evidence: [{ kind: "note", text: "依据第一段" }], unitsDone: 1, nextStep: "NEXT_STEP_2", nextCheckAt: null, awaitingMaterial: false },
  });
  assert.equal(again.duties[0].progress.length, 1);
  // A changed payload for the same advancement is a conflict, not a silent overwrite.
  await assert.rejects(f.command({
    operation: "report", dutyId: duty.id, expectedRevision: 1, source: "agent", turnId: turn.turnId,
    report: { summary: "SUMMARY_REWRITTEN", evidence: [], unitsDone: 1, nextStep: "NEXT_STEP_2", nextCheckAt: null, awaitingMaterial: false },
  }), /内容已变化/);
  // Second advancement must carry the persisted progress instead of starting from scratch.
  await f.command({ operation: "advance", dutyId: duty.id, expectedRevision: await revOf(f, duty.id), requestId: "adv-2" });
  await settle(f);
  const second = JSON.stringify(f.requests[1]);
  assert.match(second, /SUMMARY_FIRST/);
  assert.match(second, /NEXT_STEP_2/);
});

test("LA3 skips are deterministic and persisted with reasons", async t => {
  const f = await setup(t);
  const duty = (await f.command({ operation: "create", requestId: "d3", definition: definition({ cadence: { kind: "cron", expression: "0 8 * * *" } }) })).duties[0];
  // Paused duty blocks automatic advancement but allows an explicit manual run.
  const paused = await f.command({ operation: "pause", dutyId: duty.id, expectedRevision: 1 });
  assert.equal(paused.duties[0].status, "paused");
  assert.equal(paused.duties[0].linkedTask.status, "paused");
  await acceptTaskTrigger(f.home, timeTrigger(await dutyTask(f, paused.duties[0])));
  assert.equal((await readTaskState(f.home, "friend")).occurrences[0].state, "skipped");
  await acceptTaskTrigger(f.home, manualTrigger(await dutyTask(f, paused.duties[0])));
  await settle(f);
  const states = (await readTaskState(f.home, "friend")).occurrences.map(o => o.state);
  assert.deepEqual(states, ["skipped", "started"]);
  // Resume re-enables automatic advancement.
  const resumed = await f.command({ operation: "resume", dutyId: duty.id, expectedRevision: 2 });
  await acceptTaskTrigger(f.home, timeTrigger(await dutyTask(f, resumed.duties[0])));
  await settle(f);
  assert.equal((await readTaskState(f.home, "friend")).occurrences[2].state, "started");
});

test("LA3 ended duties are terminal, keep history and cannot resume", async t => {
  const f = await setup(t);
  const duty = (await f.command({ operation: "create", requestId: "d4", definition: definition() })).duties[0];
  const ended = await f.command({ operation: "end", dutyId: duty.id, expectedRevision: 1 });
  assert.equal(ended.duties[0].status, "ended");
  assert.notEqual(ended.duties[0].endedAt, null);
  assert.equal(ended.duties[0].linkedTask.status, "cancelled");
  await assert.rejects(f.command({ operation: "resume", dutyId: duty.id, expectedRevision: ended.duties[0].revision }), /不能恢复/);
  await assert.rejects(f.command({ operation: "advance", dutyId: duty.id, expectedRevision: ended.duties[0].revision, requestId: "x" }), /已结束/);
  const { evaluateDutyOccurrence } = await import("../../src/long-agents/duties/service.ts");
  const evaluated = await evaluateDutyOccurrence(f.home, "friend", { id: "task-x", revision: 1, dutyId: duty.id }, "manual");
  assert.match(evaluated.reason, /职责已结束/);
  await acceptTaskTrigger(f.home, manualTrigger(await dutyTask(f, ended.duties[0])));
  const occurrence = (await readTaskState(f.home, "friend")).occurrences[0];
  assert.equal(occurrence.state, "skipped");
  assert.equal(ended.duties[0].progress.length, 0);
});

test("LA3 missing materials and awaiting-material reports block advancement until resolved", async t => {
  const f = await setup(t);
  const { evaluateDutyOccurrence } = await import("../../src/long-agents/duties/service.ts");
  const duty = (await f.command({ operation: "create", requestId: "d5", definition: definition() })).duties[0];
  const fakeTask = dutyId => ({ id: "task-x", revision: 1, dutyId });
  const skip = async (dutyId) =>
    (await evaluateDutyOccurrence(f.home, "friend", fakeTask(dutyId), "time")).reason;
  // Deterministic duty-level reasons, independent of the linked task state.
  const empty = (await f.command({ operation: "update", dutyId: duty.id, expectedRevision: 1, definition: definition({ materials: [] }) })).duties[0];
  assert.match(await skip(empty.id), /缺少学习资料/);
  const updated = await f.command({ operation: "update", dutyId: duty.id, expectedRevision: 2, definition: definition() });
  assert.equal(await skip(updated.duties[0].id), null);
  // An unknown execution context cannot report (main-chat corrections are covered separately).
  await assert.rejects(f.command({
    operation: "report", dutyId: duty.id, expectedRevision: updated.duties[0].revision, source: "agent", turnId: "chat-web:friend:main",
    report: { summary: "S", evidence: [], unitsDone: null, nextStep: null, nextCheckAt: null, awaitingMaterial: true },
  }), /找不到该执行上下文/);
  // A real advancement work may report awaiting material; future triggers wait.
  await f.command({ operation: "advance", dutyId: duty.id, expectedRevision: updated.duties[0].revision, requestId: "adv-wait" });
  await settle(f);
  const workTurnId = (await workTurn(f)).turnId;
  await f.command({
    operation: "report", dutyId: duty.id, expectedRevision: updated.duties[0].revision, source: "agent", turnId: workTurnId,
    report: { summary: "资料暂不可读", evidence: [], unitsDone: null, nextStep: null, nextCheckAt: null, awaitingMaterial: true },
  });
  assert.match(await skip(duty.id), /等待资料/);
  // The user clears the gap; advancement resumes.
  await reportCmd(f, duty.id, {
    requestId: "user-fix-1b",
    report: { summary: "用户补充资料", evidence: [], unitsDone: null, nextStep: "READ_FIRST", nextCheckAt: null, awaitingMaterial: false },
  });
  assert.equal(await skip(duty.id), null);
  // End-to-end: a cron duty with empty materials skips at acceptance with the duty reason.
  const cronList = await f.command({ operation: "create", requestId: "d5b", definition: definition({ name: "CRON_DUTY", materials: [], cadence: { kind: "cron", expression: "0 8 * * *" } }) });
  const cronDuty = cronList.duties.find(d => d.name === "CRON_DUTY");
  const task = await dutyTask(f, cronDuty);
  await acceptTaskTrigger(f.home, timeTrigger(task));
  assert.match((await readTaskState(f.home, "friend")).occurrences.at(-1).reason, /缺少学习资料/);
});

test("LA3 budget is metered from real usage and blocks automatic advancement", async t => {
  const f = await setup(t);
  const duty = (await f.command({ operation: "create", requestId: "d6", definition: definition({ cadence: { kind: "cron", expression: "0 8 * * *" }, budget: { tokensPerDay: 10 } }) })).duties[0];
  const task = (await readTaskState(f.home, "friend")).tasks.find(x => x.dutyId === duty.id);
  await acceptTaskTrigger(f.home, timeTrigger(task));
  await settle(f);
  await reconcileFriendDuties(f.home, "friend");
  const listed = (await listFriendDuties(f.home, "friend")).duties[0];
  assert.equal(listed.advancements.length, 1);
  assert.equal(listed.tokensToday, 60);
  assert.equal(listed.budgetExhausted, true);
  await acceptTaskTrigger(f.home, timeTrigger(task));
  assert.match((await readTaskState(f.home, "friend")).occurrences.at(-1).reason, /预算已耗尽/);
  // Manual advancement stays available and is recorded honestly.
  await f.command({ operation: "advance", dutyId: duty.id, expectedRevision: 1, requestId: "adv-manual" });
  await settle(f);
  await reconcileFriendDuties(f.home, "friend");
  const after = (await listFriendDuties(f.home, "friend")).duties[0];
  assert.equal(after.advancements.length, 2);
  assert.equal(after.tokensToday, 120);
});

test("LA3 goal revision supersedes old progress; conflicts are rejected and corrections kept", async t => {
  const f = await setup(t);
  const duty = (await f.command({ operation: "create", requestId: "d7", definition: definition({ totalUnits: 10 }) })).duties[0];
  await f.command({ operation: "advance", dutyId: duty.id, expectedRevision: 1, requestId: "adv-a" });
  await settle(f);
  const turn = await workTurn(f);
  await f.command({
    operation: "report", dutyId: duty.id, expectedRevision: 1, source: "agent", turnId: turn.turnId,
    report: { summary: "OLD_GOAL_PROGRESS", evidence: [], unitsDone: 3, nextStep: "OLD_NEXT", nextCheckAt: null, awaitingMaterial: false },
  });
  assert.equal(await revOf(f, duty.id), 2);
  const updated = await f.command({ operation: "update", dutyId: duty.id, expectedRevision: 2, definition: definition({ objective: "OBJECTIVE_B", totalUnits: 10 }) });
  assert.equal(updated.duties[0].revision, 3);
  assert.equal(updated.duties[0].unitsDone, null);
  assert.equal(updated.duties[0].percent, null);
  // The previous plan must not silently drive the new objective.
  assert.equal(updated.duties[0].nextStep, null);
  assert.equal(updated.duties[0].nextCheckAt, null);
  await assert.rejects(f.command({
    operation: "report", dutyId: duty.id, expectedRevision: 1, requestId: "late",
    report: { summary: "LATE", evidence: [], unitsDone: 5, nextStep: "X", nextCheckAt: null, awaitingMaterial: false },
  }), /职责已修改/);
  // The old advancement receipt is kept as superseded history, never as new-goal progress.
  await reconcileFriendDuties(f.home, "friend");
  const listed = (await listFriendDuties(f.home, "friend")).duties[0];
  assert.equal(listed.unitsDone, null);
  assert.equal(listed.progress[0].superseded, true);
  const corrected = await reportCmd(f, duty.id, {
    requestId: "user-fix-2",
    report: { summary: "CORRECTION_FOR_NEW_GOAL", evidence: [], unitsDone: 1, nextStep: "NEW_NEXT", nextCheckAt: null, awaitingMaterial: false },
  });
  assert.equal(corrected.duties[0].unitsDone, 1);
  assert.equal(corrected.duties[0].percent, 10);
  assert.equal(corrected.duties[0].progress.filter(p => !p.superseded).length, 1);
});

test("LA3 evidence must exist inside the authorized scope", async t => {
  const f = await setup(t);
  const projectDir = f.projects[0].projectRoot ?? path.join(f.root, "a");
  fs.mkdirSync(path.join(projectDir, "notes"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "notes", "ch1.md"), "第一章");
  const duty = (await f.command({ operation: "create", requestId: "d8", definition: definition({ contextProjectId: "a" }) })).duties[0];
  const report = over => reportCmd(f, duty.id, {
    requestId: over.r,
    report: { summary: "S", evidence: over.evidence, unitsDone: null, nextStep: "N", nextCheckAt: null, awaitingMaterial: false },
  });
  await report({ r: "ok", evidence: [{ kind: "file", path: "notes/ch1.md" }] });
  await assert.rejects(report({ r: "escape", evidence: [{ kind: "file", path: "../escape.md" }] }), /相对路径/);
  await assert.rejects(report({ r: "absolute", evidence: [{ kind: "file", path: "/etc/passwd" }] }), /相对路径/);
  await assert.rejects(report({ r: "missing", evidence: [{ kind: "file", path: "notes/nope.md" }] }), /不存在/);
  await assert.rejects(report({ r: "foreign-work", evidence: [{ kind: "work", workId: "work-ffffffffffffffffffffffffffffffff" }] }), /不存在/);
});

test("LA3 reconciler rebuilds a lost duty task and replays receipts idempotently", async t => {
  const f = await setup(t);
  const duty = (await f.command({ operation: "create", requestId: "d9", definition: definition() })).duties[0];
  const before = (await readTaskState(f.home, "friend")).tasks.find(x => x.dutyId === duty.id);
  // Simulate a crash between duty persistence and task creation.
  await changeTaskState(f.home, "friend", s => { s.tasks = s.tasks.filter(x => x.id !== before.id); s.revisions = s.revisions.filter(r => r.id !== before.id); });
  await reconcileFriendDuties(f.home, "friend");
  const rebuilt = (await readTaskState(f.home, "friend")).tasks.find(x => x.dutyId === duty.id);
  assert.equal(rebuilt.id, before.id);
  await f.command({ operation: "advance", dutyId: duty.id, expectedRevision: 1, requestId: "adv-r" });
  await settle(f);
  await reconcileFriendDuties(f.home, "friend");
  const first = (await readDutyState(f.home, "friend")).duties[0].advancements;
  assert.equal(first.length, 1);
  await changeDutyState(f.home, "friend", s => { s.duties[0].advancements = []; });
  await reconcileFriendDuties(f.home, "friend");
  const replayed = (await readDutyState(f.home, "friend")).duties[0].advancements;
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].advancementKey, first[0].advancementKey);
  assert.equal(replayed[0].tokens, first[0].tokens);
});

test("LA3 duty management requires live Friend and matches web and tool on one service", async t => {
  const f = await setup(t);
  const listed = await manageFriendDuty(f.home, "friend", { schemaVersion: 1, operation: "list" });
  assert.equal(listed.duties.length, 0);
  await assert.rejects(manageFriendDuty(f.home, "missing", { schemaVersion: 1, operation: "list" }), /找不到Friend/);
  await assert.rejects(manageFriendDuty(f.home, "friend", { schemaVersion: 2, operation: "list" }), /schemaVersion 1/);
});

test("LA3 lifecycle and configuration changes keep progress, budget and plan; only a goal change supersedes them", async t => {
  const f = await setup(t);
  const duty = (await f.command({ operation: "create", requestId: "c1", definition: definition({ totalUnits: 3, budget: { tokensPerDay: 100000 } }) })).duties[0];
  await f.command({ operation: "advance", dutyId: duty.id, expectedRevision: 1, requestId: "c1-adv" });
  await settle(f);
  const turn = await workTurn(f);
  const check = await f.command({
    operation: "report", dutyId: duty.id, expectedRevision: 1, source: "agent", turnId: turn.turnId,
    report: { summary: "FIRST", evidence: [], unitsDone: 1, nextStep: "NEXT_STEP", nextCheckAt: null, awaitingMaterial: false },
  });
  await reconcileFriendDuties(f.home, "friend");
  assert.equal(check.duties[0].unitsDone, 1);
  const tokensAfterRun = (await listFriendDuties(f.home, "friend")).duties[0].tokensToday;
  assert.equal(tokensAfterRun, 60);
  // Pause and resume are lifecycle changes: the goal generation, progress and plan must survive.
  const paused = await f.command({ operation: "pause", dutyId: duty.id, expectedRevision: check.duties[0].revision });
  const resumed = await f.command({ operation: "resume", dutyId: duty.id, expectedRevision: paused.duties[0].revision });
  assert.equal(resumed.duties[0].goalRevision, 1);
  assert.equal(resumed.duties[0].unitsDone, 1);
  assert.equal(resumed.duties[0].percent, 33);
  assert.equal(resumed.duties[0].nextStep, "NEXT_STEP");
  assert.equal(resumed.duties[0].tokensToday, tokensAfterRun);
  assert.equal(resumed.duties[0].progress[0].superseded, false);
  // Cadence and budget edits are configuration: same generation, same progress and plan.
  const retuned = await f.command({ operation: "update", dutyId: duty.id, expectedRevision: resumed.duties[0].revision,
    definition: definition({ totalUnits: 3, budget: { tokensPerDay: 250000 }, cadence: { kind: "cron", expression: "0 9 * * *" } }) });
  assert.equal(retuned.duties[0].goalRevision, 1);
  assert.equal(retuned.duties[0].unitsDone, 1);
  assert.equal(retuned.duties[0].nextStep, "NEXT_STEP");
  assert.equal(retuned.duties[0].tokensToday, tokensAfterRun);
  // A goal change starts a new generation and clears the old plan, but never the day's metering.
  const regoaled = await f.command({ operation: "update", dutyId: duty.id, expectedRevision: retuned.duties[0].revision,
    definition: definition({ objective: "OBJECTIVE_NEW", totalUnits: 3, budget: { tokensPerDay: 250000 }, cadence: { kind: "cron", expression: "0 9 * * *" } }) });
  assert.equal(regoaled.duties[0].goalRevision, 2);
  assert.equal(regoaled.duties[0].unitsDone, null);
  assert.equal(regoaled.duties[0].nextStep, null);
  assert.equal(regoaled.duties[0].progress[0].superseded, true);
  assert.equal(regoaled.duties[0].tokensToday, tokensAfterRun);
});

test("LA3 report binding: only this duty's advancement work may report; late results stay with their goal", async t => {
  const f = await setup(t);
  const a = (await f.command({ operation: "create", requestId: "bind-a", definition: definition({ name: "A" }) })).duties.find(d => d.name === "A");
  const b = (await f.command({ operation: "create", requestId: "bind-b", definition: definition({ name: "B" }) })).duties.find(d => d.name === "B");
  await f.command({ operation: "advance", dutyId: b.id, expectedRevision: 1, requestId: "bind-adv-b" });
  await settle(f);
  const bTurn = await workTurn(f);
  await assert.rejects(f.command({
    operation: "report", dutyId: a.id, expectedRevision: 1, source: "agent", turnId: bTurn.turnId,
    report: { summary: "B reports A", evidence: [], unitsDone: null, nextStep: "X", nextCheckAt: null, awaitingMaterial: false },
  }), /不属于此职责/);
  // An ordinary background work (not a duty advancement) cannot report progress either.
  const main = await executeLongAgentTurn(f.input("MAIN", "b"));
  assert.equal(main.text, "ack");
  const daily = (await readLongAgentState(f.home)).dailySessions.find(d => d.longAgentId === "friend");
  const { startFriendWork } = await import("../../src/long-agents/work.ts");
  const plain = await startFriendWork({ chatHome: f.home, longAgentId: "friend", originSessionId: daily.sessionId,
    requestId: "plain-work", contextProjectId: null, title: "普通工作", text: "PLAIN" });
  await drainLongAgentTurns(f.home, "friend", plain.work.sessionId);
  const plainTurn = (await readLongAgentState(f.home)).turns.find(turn => turn.workId === plain.work.id);
  await assert.rejects(f.command({
    operation: "report", dutyId: a.id, expectedRevision: 1, source: "agent", turnId: plainTurn.turnId,
    report: { summary: "plain reports A", evidence: [], unitsDone: null, nextStep: "X", nextCheckAt: null, awaitingMaterial: false },
  }), /不属于此职责/);
  // A late result is attributed to the goal generation it ran under.
  await f.command({ operation: "advance", dutyId: a.id, expectedRevision: 1, requestId: "bind-adv-a" });
  await settle(f);
  const aTurn = (await readLongAgentState(f.home)).turns.filter(turn => turn.workId !== undefined).at(-1);
  const regoaled = await f.command({ operation: "update", dutyId: a.id, expectedRevision: 1, definition: definition({ name: "A", objective: "OBJECTIVE_A2" }) });
  assert.equal(regoaled.duties[0].goalRevision, 2);
  const late = await f.command({
    operation: "report", dutyId: a.id, expectedRevision: regoaled.duties[0].revision, source: "agent", turnId: aTurn.turnId,
    report: { summary: "LATE_OLD_GOAL", evidence: [], unitsDone: 1, nextStep: "OLD_PLAN", nextCheckAt: null, awaitingMaterial: false },
  });
  const lateDuty = late.duties.find(d => d.id === a.id);
  assert.equal(lateDuty.nextStep, null);
  assert.equal(lateDuty.unitsDone, null);
  assert.equal(lateDuty.progress.at(-1).superseded, true);
  assert.equal(lateDuty.progress.at(-1).goalRevision, 1);
});

test("LA3 concurrent updates cannot silently overwrite a newer revision", async t => {
  const f = await setup(t);
  const duty = (await f.command({ operation: "create", requestId: "cas-1", definition: definition() })).duties[0];
  const races = await Promise.allSettled([
    f.command({ operation: "update", dutyId: duty.id, expectedRevision: 1, definition: definition({ objective: "RACE_A" }) }),
    f.command({ operation: "update", dutyId: duty.id, expectedRevision: 1, definition: definition({ objective: "RACE_B" }) }),
  ]);
  assert.deepEqual(races.map(r => r.status).sort(), ["fulfilled", "rejected"]);
  assert.match(String(races.find(r => r.status === "rejected").reason), /职责已修改/);
  const state = await readDutyState(f.home, "friend");
  assert.equal(state.duties[0].revision, 2);
  assert.equal(state.revisions.filter(r => r.id === duty.id).length, 2);
  const winner = races.find(r => r.status === "fulfilled");
  assert.equal(state.duties[0].objective, winner.value.duties[0].objective);
});

test("LA3 same advancement with a changed payload conflicts; an identical retry is idempotent", async t => {
  const f = await setup(t);
  const duty = (await f.command({ operation: "create", requestId: "dup-1", definition: definition() })).duties[0];
  await f.command({ operation: "advance", dutyId: duty.id, expectedRevision: 1, requestId: "dup-adv" });
  await settle(f);
  const turn = await workTurn(f);
  const report = (summary) => ({
    operation: "report", dutyId: duty.id, expectedRevision: 1, source: "agent", turnId: turn.turnId,
    report: { summary, evidence: [], unitsDone: 1, nextStep: "NEXT", nextCheckAt: null, awaitingMaterial: false },
  });
  const first = await f.command(report("S1"));
  assert.equal(first.duties[0].progress.length, 1);
  await assert.rejects(f.command(report("S2")), /内容已变化/);
  const retry = await f.command(report("S1"));
  assert.equal(retry.duties[0].progress.length, 1);
});

test("LA3 nextCheckAt gates automatic advancement and self-schedules cadence-none duties", async t => {
  const f = await setup(t);
  const duty = (await f.command({ operation: "create", requestId: "check-1", definition: definition() })).duties[0];
  const future = new Date(Date.now() + 3600000).toISOString();
  await reportCmd(f, duty.id, {
    requestId: "check-user-1",
    report: { summary: "PLAN", evidence: [], unitsDone: null, nextStep: "WAIT_THEN_READ", nextCheckAt: future, awaitingMaterial: false },
  });
  let task = await dutyTask(f, duty);
  assert.equal(task.schedule.kind, "once");
  assert.equal(task.schedule.at, future);
  assert.equal(task.status, "active");
  const { evaluateDutyOccurrence } = await import("../../src/long-agents/duties/service.ts");
  assert.match((await evaluateDutyOccurrence(f.home, "friend", task, "time")).reason, /未到下次检查时间/);
  assert.equal((await evaluateDutyOccurrence(f.home, "friend", task, "manual")).reason, null);
  await acceptTaskTrigger(f.home, timeTrigger(task));
  assert.match((await readTaskState(f.home, "friend")).occurrences.at(-1).reason, /未到下次检查时间/);
  // R2-1: a due-but-undelivered plan must survive maintenance (Nano may deliver after the due time).
  const due = new Date(Date.now() - 60000).toISOString();
  await reportCmd(f, duty.id, {
    requestId: "check-user-2",
    report: { summary: "DUE_PLAN", evidence: [], unitsDone: null, nextStep: "READ_NOW", nextCheckAt: due, awaitingMaterial: false },
  });
  task = await dutyTask(f, duty);
  assert.equal(task.schedule.kind, "once");
  assert.equal(task.schedule.at, due);
  assert.equal(task.status, "active");
  await reconcileFriendDuties(f.home, "friend");
  task = await dutyTask(f, duty);
  assert.equal(task.schedule.kind, "once");
  assert.equal(task.status, "active");
  // The delayed delivery still runs (missed=latest), and only then does the plan become dormant.
  const planRevision = task.revision;
  await acceptTaskTrigger(f.home, timeTrigger(task, due));
  const occurrence = (await readTaskState(f.home, "friend")).occurrences.at(-1);
  assert.equal(occurrence.state, "accepted");
  await dispatchTaskOccurrences(f.home, "friend");
  assert.equal((await readTaskState(f.home, "friend")).occurrences.at(-1).state, "started");
  await reconcileFriendDuties(f.home, "friend");
  task = await dutyTask(f, duty);
  assert.equal(task.status, "paused");
  assert.equal(task.schedule.kind, "cron");
  // Re-delivering the same plan is idempotent and creates no second execution.
  const before = (await readTaskState(f.home, "friend")).occurrences.length;
  const again = await acceptTaskTrigger(f.home, { ...timeTrigger(task, due), revision: planRevision });
  assert.equal((await readTaskState(f.home, "friend")).occurrences.length, before);
  assert.ok(again.occurrenceId);
});

test("LA3 dispatch re-checks preconditions after queueing", async t => {
  const f = await setup(t);
  const { startFriendWork } = await import("../../src/long-agents/work.ts");
  // Fill the Friend's background capacity so the queued duty occurrences really wait.
  await executeLongAgentTurn(f.input("MAIN", "b"));
  const daily = (await readLongAgentState(f.home)).dailySessions.find(d => d.longAgentId === "friend");
  let release;
  const gate = new Promise(r => { release = r; });
  let running = 0;
  let allRunning;
  const reached = new Promise(r => { allRunning = r; });
  f.setHandler(async () => { running++; if (running >= 4) allRunning(); await gate; return { content: "done" }; });
  const fillers = [];
  for (let i = 0; i < 4; i++) {
    const w = await startFriendWork({ chatHome: f.home, longAgentId: "friend", originSessionId: daily.sessionId,
      requestId: `fill-${i}`, contextProjectId: null, title: `填空${i}`, text: "FILL" });
    fillers.push(w);
  }
  await reached;
  // Queued while capacity is full: neither variant can start yet.
  const pausedDuty = (await f.command({ operation: "create", requestId: "queued-1", definition: definition({ cadence: { kind: "cron", expression: "0 8 * * *" } }) })).duties[0];
  const pausedTask = await dutyTask(f, pausedDuty);
  await acceptTaskTrigger(f.home, timeTrigger(pausedTask));
  const regoaledDuty = (await f.command({ operation: "create", requestId: "queued-2", definition: definition({ name: "OTHER", cadence: { kind: "cron", expression: "0 8 * * *" } }) })).duties.find(d => d.name === "OTHER");
  const regoaledTask = await dutyTask(f, regoaledDuty);
  await acceptTaskTrigger(f.home, timeTrigger(regoaledTask));
  const queued = (await readTaskState(f.home, "friend")).occurrences.filter(o => o.state === "accepted");
  assert.equal(queued.length, 2);
  assert.equal((await readLongAgentState(f.home)).works.length, 4);
  // While waiting: one duty is paused, the other's goal changes.
  await f.command({ operation: "pause", dutyId: pausedDuty.id, expectedRevision: 1 });
  await f.command({ operation: "update", dutyId: regoaledDuty.id, expectedRevision: 1, definition: definition({ name: "OTHER", objective: "REGOALED", cadence: { kind: "cron", expression: "0 8 * * *" } }) });
  release();
  for (const item of fillers) await drainLongAgentTurns(f.home, "friend", item.work.sessionId);
  await dispatchTaskOccurrences(f.home, "friend");
  const after = await readTaskState(f.home, "friend");
  const pausedOccurrence = after.occurrences.find(o => o.taskId === pausedTask.id);
  const staleOccurrence = after.occurrences.find(o => o.taskId === regoaledTask.id);
  assert.equal(pausedOccurrence.state, "skipped");
  assert.match(pausedOccurrence.reason, /职责已暂停/);
  assert.equal(staleOccurrence.state, "skipped");
  assert.match(staleOccurrence.reason, /目标已修订/);
  // No new work was started for the stale queue entries.
  assert.equal((await readLongAgentState(f.home)).works.length, 4);
});

test("LA3 evidence existence and symlink boundaries hold in both scopes", async t => {
  const f = await setup(t);
  const { resolveProjectContext } = await import("../../src/projects/registry.ts");
  const workspace = (await resolveProjectContext("friend", f.home)).projectRoot;
  fs.mkdirSync(path.join(workspace, "notes"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "notes", "ok.md"), "ok");
  const outside = path.join(f.root, "outside");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.md"), "secret");
  const escape = path.join(workspace, "notes", "escape.md");
  try { fs.unlinkSync(escape); } catch {}
  fs.symlinkSync(path.join(outside, "secret.md"), escape);
  const duty = (await f.command({ operation: "create", requestId: "ev-1", definition: definition() })).duties[0];
  const report = (r, p) => reportCmd(f, duty.id, {
    requestId: r,
    report: { summary: "S", evidence: [{ kind: "file", path: p }], unitsDone: null, nextStep: "N", nextCheckAt: null, awaitingMaterial: false },
  });
  await report("ev-ok", "notes/ok.md");
  await assert.rejects(report("ev-missing", "notes/nope.md"), /不存在/);
  await assert.rejects(report("ev-symlink", "notes/escape.md"), /越出/);
  // Project scope uses the same real-path validation.
  const project = f.projects[0];
  const projectRoot = path.join(f.root, project.projectId);
  fs.mkdirSync(path.join(projectRoot, "notes"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "notes", "ch1.md"), "ch1");
  const escapeProject = path.join(projectRoot, "notes", "escape.md");
  try { fs.unlinkSync(escapeProject); } catch {}
  fs.symlinkSync(path.join(outside, "secret.md"), escapeProject);
  const scoped = (await f.command({ operation: "create", requestId: "ev-2", definition: definition({ name: "SCOPED", contextProjectId: project.projectId }) })).duties.find(d => d.name === "SCOPED");
  const scopedReport = (r, p) => reportCmd(f, scoped.id, {
    requestId: r,
    report: { summary: "S", evidence: [{ kind: "file", path: p }], unitsDone: null, nextStep: "N", nextCheckAt: null, awaitingMaterial: false },
  });
  await scopedReport("ev-p-ok", "notes/ch1.md");
  await assert.rejects(scopedReport("ev-p-missing", "notes/nope.md"), /不存在/);
  await assert.rejects(scopedReport("ev-p-symlink", "notes/escape.md"), /越出/);
});

test("LA3 the Friend can correct progress from the direct conversation", async t => {
  const f = await setup(t);
  const duty = (await f.command({ operation: "create", requestId: "chat-1", definition: definition({ materials: [] }) })).duties[0];
  const main = await executeLongAgentTurn(f.input("MAIN", "b"));
  assert.equal(main.text, "ack");
  const chatTurn = (await readLongAgentState(f.home)).turns.find(turn => turn.workId === undefined);
  const corrected = await f.command({
    operation: "report", dutyId: duty.id, expectedRevision: 1, source: "agent", turnId: chatTurn.turnId, requestId: "tool:main:1",
    report: { summary: "用户在聊天中说明资料已放在工作区，先解除等待", evidence: [], unitsDone: null, nextStep: "READ_MATERIALS", nextCheckAt: null, awaitingMaterial: false },
  });
  const entry = corrected.duties[0].progress.at(-1);
  assert.equal(entry.source, "agent");
  assert.match(entry.advancementKey, /^chat:/);
  assert.equal(corrected.duties[0].nextStep, "READ_MATERIALS");
  assert.equal(corrected.duties[0].progress[0].superseded, false);
  // The same management request retried identically is idempotent; a changed payload conflicts.
  const again = await f.command({
    operation: "report", dutyId: duty.id, expectedRevision: 1, source: "agent", turnId: chatTurn.turnId, requestId: "tool:main:1",
    report: { summary: "用户在聊天中说明资料已放在工作区，先解除等待", evidence: [], unitsDone: null, nextStep: "READ_MATERIALS", nextCheckAt: null, awaitingMaterial: false },
  });
  assert.equal(again.duties[0].progress.length, 1);
  await assert.rejects(f.command({
    operation: "report", dutyId: duty.id, expectedRevision: 1, source: "agent", turnId: chatTurn.turnId, requestId: "tool:main:1",
    report: { summary: "改了内容", evidence: [], unitsDone: null, nextStep: "OTHER", nextCheckAt: null, awaitingMaterial: false },
  }), /内容已变化/);
});

test("LA3 a cancelled advancement still reports under the goal generation it ran with", async t => {
  const f = await setup(t);
  const duty = (await f.command({ operation: "create", requestId: "term-1", definition: definition() })).duties[0];
  let release; const gate = new Promise(r => { release = r; });
  let arrived; const started = new Promise(r => { arrived = r; });
  f.setHandler(async () => { arrived(); await gate; return { content: "done" }; });
  await f.command({ operation: "advance", dutyId: duty.id, expectedRevision: 1, requestId: "term-adv" });
  await started;
  await dispatchTaskOccurrences(f.home, "friend");
  const turn = await workTurn(f);
  const occurrence = (await readTaskState(f.home, "friend")).occurrences.at(-1);
  const { cancelFriendWork } = await import("../../src/long-agents/work.ts");
  await cancelFriendWork(f.home, "friend", occurrence.workId, turn.turnId);
  await drainLongAgentTurns(f.home, "friend", turn.sessionId);
  assert.equal((await readLongAgentState(f.home)).turns.find(item => item.turnId === turn.turnId).status, "cancelled");
  // The partial result is accepted, attributed to its own goal generation, and receipted as cancelled.
  const reported = await f.command({
    operation: "report", dutyId: duty.id, expectedRevision: 1, source: "agent", turnId: turn.turnId,
    report: { summary: "CANCELLED_PARTIAL", evidence: [], unitsDone: null, nextStep: "RESUME_LATER", nextCheckAt: null, awaitingMaterial: false },
  });
  assert.equal(reported.duties[0].nextStep, "RESUME_LATER");
  assert.equal(reported.duties[0].progress.at(-1).goalRevision, 1);
  assert.equal(reported.duties[0].progress.at(-1).superseded, false);
  await reconcileFriendDuties(f.home, "friend");
  const receipt = (await listFriendDuties(f.home, "friend")).duties[0].advancements.at(-1);
  assert.equal(receipt.status, "cancelled");
  assert.equal(receipt.goalRevision, 1);
});

test("LA3 concurrent progress reports serialize: one wins, the stale one is rejected", async t => {
  const f = await setup(t);
  const duty = (await f.command({ operation: "create", requestId: "r2-race", definition: definition({ totalUnits: 5 }) })).duties[0];
  const race = (r, units, next) => f.command({
    operation: "report", dutyId: duty.id, expectedRevision: 1, requestId: r,
    report: { summary: `RACE_${r}`, evidence: [], unitsDone: units, nextStep: next, nextCheckAt: null, awaitingMaterial: false },
  });
  const results = await Promise.allSettled([race("A", 2, "PLAN_A"), race("B", 4, "PLAN_B")]);
  assert.deepEqual(results.map(r => r.status).sort(), ["fulfilled", "rejected"]);
  const rejected = results.find(r => r.status === "rejected");
  assert.match(String(rejected.reason), /职责已修改/);
  const winner = results.find(r => r.status === "fulfilled").value.duties[0];
  const current = (await listFriendDuties(f.home, "friend")).duties[0];
  // The winner's value is the current one; the loser was rejected, not silently applied.
  assert.equal(current.unitsDone, winner.unitsDone);
  assert.equal(current.nextStep, winner.nextStep);
  assert.equal(current.progress.length, 1);
});

test("LA3 a background report against a newer revision merges into history instead of clobbering the plan", async t => {
  const f = await setup(t);
  const duty = (await f.command({ operation: "create", requestId: "r2-stale", definition: definition({ totalUnits: 4 }) })).duties[0];
  await f.command({ operation: "advance", dutyId: duty.id, expectedRevision: 1, requestId: "r2-stale-adv" });
  await settle(f);
  const turn = await workTurn(f);
  // A user correction lands while the advancement is still running: revision moves on, goal does not.
  await reportCmd(f, duty.id, {
    requestId: "r2-user-during-run",
    report: { summary: "USER_PLAN", evidence: [], unitsDone: 1, nextStep: "USER_NEXT", nextCheckAt: null, awaitingMaterial: false },
  });
  const applied = await f.command({
    operation: "report", dutyId: duty.id, expectedRevision: await revOf(f, duty.id), source: "agent", turnId: turn.turnId,
    report: { summary: "WORK_STALE", evidence: [], unitsDone: 3, nextStep: "WORK_NEXT", nextCheckAt: null, awaitingMaterial: false },
  });
  assert.equal(applied.reportApplied, false);
  const current = applied.duties[0];
  assert.equal(current.unitsDone, 1);
  assert.equal(current.nextStep, "USER_NEXT");
  assert.equal(current.progress.at(-1).summary, "WORK_STALE");
  assert.equal(current.progress.at(-1).superseded, false);
});

test("LA3 the direct trigger path accounts finished executions before judging the budget", async t => {
  const f = await setup(t);
  const { startFriendWork } = await import("../../src/long-agents/work.ts");
  const duty = (await f.command({ operation: "create", requestId: "r2-budget",
    definition: definition({ cadence: { kind: "cron", expression: "0 8 * * *" }, budget: { tokensPerDay: 50 } }) })).duties[0];
  const task = await dutyTask(f, duty);
  // First advancement finishes (60 tokens of real usage) but no maintenance/reconcile runs afterwards.
  await acceptTaskTrigger(f.home, timeTrigger(task));
  await settle(f);
  assert.equal((await readLongAgentState(f.home)).works.length, 1);
  assert.equal((await readDutyState(f.home, "friend")).duties[0].advancements.length, 0);
  // A queued occurrence must not start: the trigger path itself has to account the finished run.
  await acceptTaskTrigger(f.home, timeTrigger(task));
  await settle(f);
  const occurrences = (await readTaskState(f.home, "friend")).occurrences;
  assert.equal(occurrences.length, 2);
  assert.equal(occurrences[1].state, "skipped");
  assert.match(occurrences[1].reason, /预算已耗尽/);
  assert.equal((await readLongAgentState(f.home)).works.length, 1);
  const duty2 = (await listFriendDuties(f.home, "friend")).duties[0];
  assert.equal(duty2.tokensToday, 60);
  assert.equal(duty2.advancements.length, 1);
  void startFriendWork;
});

test("LA3 a due plan is consumed per duty: same instant in two duties does not cross-consume", async t => {
  const f = await setup(t);
  const a = (await f.command({ operation: "create", requestId: "plan-a", definition: definition({ name: "A", cadence: { kind: "none" } }) })).duties.find(d => d.name === "A");
  const b = (await f.command({ operation: "create", requestId: "plan-b", definition: definition({ name: "B", cadence: { kind: "none" } }) })).duties.find(d => d.name === "B");
  const plan = new Date(Date.now() - 60000).toISOString();
  await reportCmd(f, a.id, { requestId: "a-plan", report: { summary: "A_PLAN", evidence: [], unitsDone: null, nextStep: "A_NEXT", nextCheckAt: plan, awaitingMaterial: false } });
  await reportCmd(f, b.id, { requestId: "b-plan", report: { summary: "B_PLAN", evidence: [], unitsDone: null, nextStep: "B_NEXT", nextCheckAt: plan, awaitingMaterial: false } });
  const taskA = await dutyTask(f, a);
  const taskB = await dutyTask(f, b);
  for (const task of [taskA, taskB]) {
    assert.equal(task.schedule.kind, "once");
    assert.equal(task.schedule.at, plan);
    assert.equal(task.status, "active");
  }
  // A's delivery and the maintenance loop must not consume B's identical-timestamp plan.
  await acceptTaskTrigger(f.home, timeTrigger(taskA, plan));
  await settle(f);
  await reconcileFriendDuties(f.home, "friend");
  const afterB = await dutyTask(f, b);
  assert.equal(afterB.schedule.kind, "once");
  assert.equal(afterB.schedule.at, plan);
  assert.equal(afterB.status, "active");
  const afterA = await dutyTask(f, a);
  assert.equal(afterA.status, "paused");
  await acceptTaskTrigger(f.home, timeTrigger(afterB, plan));
  await settle(f);
  const occurrences = (await readTaskState(f.home, "friend")).occurrences;
  const bOccurrence = occurrences.find(o => o.taskId === afterB.id);
  assert.equal(bOccurrence.state, "started");
  assert.equal((await readLongAgentState(f.home)).works.length, 2);
});

test("LA3 a chat correction must carry the revision the caller observed", async t => {
  const f = await setup(t);
  const duty = (await f.command({ operation: "create", requestId: "chat-cas", definition: definition({ totalUnits: 10 }) })).duties[0];
  await reportCmd(f, duty.id, {
    requestId: "user-first",
    report: { summary: "USER_8", evidence: [], unitsDone: 8, nextStep: "USER_NEXT", nextCheckAt: null, awaitingMaterial: false },
  });
  const main = await executeLongAgentTurn(f.input("MAIN", "b"));
  assert.equal(main.text, "ack");
  const chatTurn = (await readLongAgentState(f.home)).turns.find(turn => turn.workId === undefined);
  const chat = (expectedRevision, unitsDone, summary) => f.command({
    operation: "report", dutyId: duty.id, expectedRevision, source: "agent", turnId: chatTurn.turnId, requestId: `tool:main:${summary}`,
    report: { summary, evidence: [], unitsDone, nextStep: "CHAT_NEXT", nextCheckAt: null, awaitingMaterial: false },
  });
  // The chat read v1, but the user already wrote at v2: the stale correction is rejected, not applied.
  await assert.rejects(chat(1, 2, "STALE_CHAT"), /职责已修改/);
  assert.equal((await listFriendDuties(f.home, "friend")).duties[0].unitsDone, 8);
  const applied = await chat(await revOf(f, duty.id), 2, "FRESH_CHAT");
  assert.equal(applied.reportApplied, true);
  assert.equal(applied.duties[0].unitsDone, 2);
});

test("LA3 the next advancement prompt excludes reports that never applied", async t => {
  const f = await setup(t);
  const { resolveProjectContext } = await import("../../src/projects/registry.ts");
  const workspace = (await resolveProjectContext("friend", f.home)).projectRoot;
  fs.mkdirSync(path.join(workspace, "notes"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "notes", "user.md"), "user");
  fs.writeFileSync(path.join(workspace, "notes", "stale.md"), "stale");
  const duty = (await f.command({ operation: "create", requestId: "prompt-1", definition: definition({ totalUnits: 4 }) })).duties[0];
  await f.command({ operation: "advance", dutyId: duty.id, expectedRevision: 1, requestId: "prompt-adv-1" });
  await settle(f);
  const turn = await workTurn(f);
  await reportCmd(f, duty.id, {
    requestId: "prompt-user",
    report: { summary: "USER_FACT", evidence: [{ kind: "file", path: "notes/user.md" }], unitsDone: 8, nextStep: "USER_NEXT", nextCheckAt: null, awaitingMaterial: false },
  });
  const stale = await f.command({
    operation: "report", dutyId: duty.id, expectedRevision: await revOf(f, duty.id), source: "agent", turnId: turn.turnId,
    report: { summary: "STALE_CLAIM", evidence: [{ kind: "file", path: "notes/stale.md" }], unitsDone: 1, nextStep: "OLD_NEXT", nextCheckAt: null, awaitingMaterial: false },
  });
  assert.equal(stale.reportApplied, false);
  const entries = stale.duties[0].progress;
  assert.equal(entries.find(p => p.summary === "USER_FACT").applied, true);
  assert.equal(entries.find(p => p.summary === "STALE_CLAIM").applied, false);
  await f.command({ operation: "advance", dutyId: duty.id, expectedRevision: await revOf(f, duty.id), requestId: "prompt-adv-2" });
  await settle(f);
  const prompt = JSON.stringify(f.requests.at(-1));
  assert.doesNotMatch(prompt, /STALE_CLAIM/);
  assert.doesNotMatch(prompt, /notes\/stale\.md/);
  assert.match(prompt, /USER_NEXT/);
  assert.match(prompt, /历史（不构成当前依据）/);
});

test("LA3 legacy migration keeps unverifiable history out of the current basis", async t => {
  const f = await setup(t);
  const duty = (await f.command({ operation: "create", requestId: "legacy-1", definition: definition({ totalUnits: 10 }) })).duties[0];
  const current = (await readDutyState(f.home, "friend")).duties[0];
  const file = path.join(f.home, "long-agents", "friend", "duties.json");
  // A document from the revision before `applied` existed: a user correction plus a late, replaced
  // background report. Only the pointer fields survived as authoritative state; neither history entry is verifiable.
  const legacy = {
    ...current,
    revision: 5,
    goalRevision: 2,
    unitsDone: 8,
    nextStep: "USER_NEXT",
    nextCheckAt: null,
    progress: [
      { id: "prog-a", advancementKey: "occ-a", payloadHash: "a".repeat(64), at: "2026-09-20T10:00:00Z", source: "user", dutyRevision: 2,
        summary: "VALID_SUMMARY", evidence: [], unitsDone: 8, nextStep: "USER_NEXT", nextCheckAt: null },
      { id: "prog-b", advancementKey: "occ-b", payloadHash: "b".repeat(64), at: "2026-09-20T10:05:00Z", source: "agent", dutyRevision: 2,
        summary: "REJECTED_SUMMARY", evidence: [{ kind: "file", path: "REJECTED_FILE.md" }], unitsDone: 1, nextStep: "REJECTED_NEXT", nextCheckAt: null },
    ],
  };
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, duties: [legacy], revisions: [legacy] }, null, 2));
  const listed = (await listFriendDuties(f.home, "friend")).duties[0];
  assert.equal(listed.unitsDone, 8);
  assert.equal(listed.nextStep, "USER_NEXT");
  assert.deepEqual(listed.progress.map(p => ({ summary: p.summary, applied: p.applied })),
    [{ summary: "VALID_SUMMARY", applied: false }, { summary: "REJECTED_SUMMARY", applied: false }]);
  // Reading twice (for example after a restart) is stable.
  assert.deepEqual((await listFriendDuties(f.home, "friend")).duties[0].progress.map(p => p.applied), [false, false]);
  // Neither legacy report can become a current fact without an application record.
  await f.command({ operation: "advance", dutyId: duty.id, expectedRevision: listed.revision, requestId: "legacy-adv" });
  await settle(f);
  const prompt = JSON.stringify(f.requests.at(-1));
  assert.doesNotMatch(prompt, /REJECTED_SUMMARY/);
  assert.doesNotMatch(prompt, /REJECTED_FILE/);
  assert.doesNotMatch(prompt, /REJECTED_NEXT/);
  assert.doesNotMatch(prompt, /VALID_SUMMARY/);
  assert.match(prompt, /依据待核验/);
  assert.match(prompt, /历史（不构成当前依据）/);
  // Once written back, the explicit markers persist; a later read does not re-classify anything.
  await reportCmd(f, duty.id, {
    requestId: "legacy-user-2",
    report: { summary: "AFTER_MIGRATION", evidence: [], unitsDone: 9, nextStep: "NEXT_AFTER", nextCheckAt: null, awaitingMaterial: false },
  });
  const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(persisted.duties[0].progress.every(p => typeof p.applied === "boolean" && p.payloadHash !== undefined));
  const reloaded = (await listFriendDuties(f.home, "friend")).duties[0];
  assert.equal(reloaded.unitsDone, 9);
  assert.deepEqual(reloaded.progress.map(p => p.applied), [false, false, true]);
});

test("LA3 legacy migration preserves a pointer but cannot infer whether an old report was applied", async t => {
  const f = await setup(t);
  await f.command({ operation: "create", requestId: "legacy-2", definition: definition({ totalUnits: 5 }) });
  const current = (await readDutyState(f.home, "friend")).duties[0];
  const file = path.join(f.home, "long-agents", "friend", "duties.json");
  const legacy = {
    ...current,
    revision: 3,
    goalRevision: 1,
    unitsDone: 3,
    nextStep: "OLD_VALID_NEXT",
    nextCheckAt: null,
    progress: [
      { id: "prog-1", advancementKey: "occ-1", payloadHash: "a".repeat(64), at: "2026-09-20T09:00:00Z", source: "agent", dutyRevision: 1,
        summary: "OLD_VALID_SUMMARY", evidence: [{ kind: "file", path: "OLD_VALID_FILE.md" }], unitsDone: 3, nextStep: "OLD_VALID_NEXT", nextCheckAt: null },
    ],
  };
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, duties: [legacy], revisions: [legacy] }, null, 2));
  const listed = (await listFriendDuties(f.home, "friend")).duties[0];
  assert.equal(listed.progress[0].applied, false);
  await f.command({ operation: "advance", dutyId: listed.id, expectedRevision: listed.revision, requestId: "legacy-2-adv" });
  await settle(f);
  const prompt = JSON.stringify(f.requests.at(-1));
  assert.doesNotMatch(prompt, /OLD_VALID_SUMMARY/);
  assert.match(prompt, /依据待核验/);
  assert.doesNotMatch(prompt, /OLD_VALID_FILE\.md/);
});


for (const variant of ["same-pointer", "cross-goal", "missing-pointer"]) {
  test(`LA3 migration ${variant}: repeated reads/writes never promote unverified evidence`, async t => {
    const f = await setup(t);
    const created = (await f.command({ operation: "create", requestId: `migration-${variant}`, definition: definition() })).duties[0];
    const file = path.join(f.home, "long-agents", "friend", "duties.json");
    const entry = (id, goal, summary, at) => ({
      id, advancementKey: `user:${id}`, payloadHash: "a".repeat(64), at, source: "user", dutyRevision: goal,
      summary, evidence: [{ kind: "file", path: `${summary}.md` }], unitsDone: 8, nextStep: "PRESERVED_NEXT", nextCheckAt: null,
    });
    const legacy = {
      ...(await readDutyState(f.home, "friend")).duties[0], revision: 5, goalRevision: 2,
      unitsDone: 8, nextStep: "PRESERVED_NEXT", nextCheckAt: null,
      progress: [entry("prog-current", 2, "UNVERIFIED_CURRENT", "2026-09-20T10:00:00Z"),
        entry("prog-late", variant === "cross-goal" ? 1 : 2, "UNVERIFIED_LATE", "2026-09-20T11:00:00Z")],
    };
    if (variant === "missing-pointer") delete legacy.unitsDone;
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, duties: [legacy], revisions: [legacy] }));
    for (let cycle = 0; cycle < 3; cycle++) {
      const read = (await listFriendDuties(f.home, "friend")).duties[0];
      assert.equal(read.unitsDone, variant === "missing-pointer" ? null : 8);
      assert.equal(read.nextStep, "PRESERVED_NEXT");
      assert.deepEqual(read.progress.map(p => p.applied), [false, false]);
      const paused = (await f.command({ operation: "pause", dutyId: created.id, expectedRevision: read.revision })).duties[0];
      const resumed = (await f.command({ operation: "resume", dutyId: created.id, expectedRevision: paused.revision })).duties[0];
      await f.command({ operation: "advance", dutyId: created.id, expectedRevision: resumed.revision, requestId: `cycle-${cycle}` });
      await settle(f);
      const request = JSON.stringify(f.requests.at(-1));
      assert.doesNotMatch(request, /UNVERIFIED_CURRENT|UNVERIFIED_LATE/);
      assert.doesNotMatch(request, /这是第一次推进/);
      assert.match(request, /依据待核验/);
      assert.match(request, /PRESERVED_NEXT/);
    }
    const current = (await listFriendDuties(f.home, "friend")).duties[0];
    const confirmed = (await f.command({ operation: "report", dutyId: created.id, expectedRevision: current.revision, requestId: "confirmed",
      report: { summary: "NEW_CONFIRMED_FACT", evidence: [], unitsDone: 9, nextStep: "CONFIRMED_NEXT", nextCheckAt: null, awaitingMaterial: false },
    })).duties[0];
    assert.deepEqual(confirmed.progress.map(p => p.applied), [false, false, true]);
    await f.command({ operation: "advance", dutyId: created.id, expectedRevision: confirmed.revision, requestId: "confirmed-run" });
    await settle(f);
    const request = JSON.stringify(f.requests.at(-1));
    assert.match(request, /NEW_CONFIRMED_FACT/);
    assert.doesNotMatch(request, /UNVERIFIED_CURRENT|UNVERIFIED_LATE/);
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(stored.duties[0].unitsDone, 9);
    assert.deepEqual(stored.duties[0].progress.map(p => p.applied), [false, false, true]);
  });
}
