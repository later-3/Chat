import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./daily-fixture.mjs";
import { manageFriendTask, acceptTaskTrigger, dispatchTaskOccurrences, migrateFriendTasks } from "../../src/long-agents/tasks/service.ts";
import { readTaskState } from "../../src/long-agents/tasks/storage.ts";
import { drainLongAgentTurns } from "../../src/long-agents/turn-queue.ts";
import { executeLongAgentTurn } from "../../src/long-agents/runtime.ts";
import { projectFriendCreationError } from "../../src/long-agents/http-error.ts";
import { NanoClawGatewayError, NanoClawGatewayUnavailableError } from "../../src/long-agents/nanoclaw-client.ts";
const definition = { name: "阅读", prompt: "TASK_READING", contextProjectId: "a", timeZone: "Asia/Shanghai", schedule: { kind: "event", source: "book" }, missed: "skip", overlap: "queue-one" };
async function setup(t, legacy = []) {
  const f = await fixture(t); const projections = new Map(); let offline = false;
  const original = globalThis.fetch; const token = process.env.CHAT_CHANNEL_GATEWAY_TOKEN;
  process.env.CHAT_CHANNEL_GATEWAY_TOKEN = "test-task-projection-token-32-characters-long";
  t.after(() => { if (token === undefined) delete process.env.CHAT_CHANNEL_GATEWAY_TOKEN; else process.env.CHAT_CHANNEL_GATEWAY_TOKEN = token; });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (!String(url).includes("/v1/task-projections")) return original(url, init);
    if (offline) throw new Error("offline");
    const body = JSON.parse(init.body);
    if (body.operation === "claim") return Response.json({ schemaVersion: 1, timeZone: "Asia/Shanghai", tasks: legacy });
    if (body.operation === "preview") return Response.json({ schemaVersion: 1, nextAt: null });
    if (body.operation === "apply") { const p = body.projection; projections.set(p.taskId, { taskId: p.taskId, revision: p.revision, nextAt: null }); return Response.json({ schemaVersion: 1, ...projections.get(p.taskId) }); }
    return Response.json({ schemaVersion: 1, projections: [...projections.values()] });
  });
  const command = body => manageFriendTask(f.home, "friend", { schemaVersion: 2, ...body });
  return { ...f, command, offline: value => { offline = value; }, trigger: (task, sourceId, extra = {}) => ({ schemaVersion: 1, instanceId: "local", agentGroupId: "group", taskId: task.id, revision: task.revision, source: "event", sourceId: `book:${sourceId}`, scheduledAt: new Date().toISOString(), ...extra }) };
}
async function settle(f) {
  await dispatchTaskOccurrences(f.home, "friend");
  const state = await readTaskState(f.home, "friend");
  const { listFriendWork } = await import("../../src/long-agents/work.ts");
  for (const item of (await listFriendWork(f.home, "friend")).works) await drainLongAgentTurns(f.home, "friend", item.work.sessionId);
  return state;
}
test("LA2 create retries, revision conflicts, stale events, pause and pending projection are durable", async t => {
  const f = await setup(t);
  const create = { operation: "create", requestId: "one", definition };
  const task = (await f.command(create)).tasks[0];
  assert.equal((await f.command(create)).tasks.length, 1);
  await assert.rejects(f.command({ ...create, definition: { ...definition, name: "changed" } }), /内容已变化/);
  f.offline(true);
  const paused = await f.command({ operation: "pause", taskId: task.id, expectedRevision: 1 });
  assert.equal(paused.tasks[0].revision, 2); assert.equal(paused.applied, false);
  const stale = await acceptTaskTrigger(f.home, f.trigger(task, "old"));
  assert.equal((await readTaskState(f.home, "friend")).occurrences.find(o => o.id === stale.occurrenceId).state, "skipped");
  f.offline(false);
  await assert.rejects(f.command({ operation: "resume", taskId: task.id, expectedRevision: 1 }), /已修改/);
  await f.command({ operation: "resume", taskId: task.id, expectedRevision: 2 });
  assert.equal((await readTaskState(f.home, "friend")).revisions.length, 3);
});
test("LA2 repeated event creates one native work, keeps main chat responsive, and preserves task project", async t => {
  const f = await setup(t); const task = (await f.command({ operation: "create", requestId: "one", definition })).tasks[0];
  const trigger = f.trigger(task, "same");
  const [a, b] = await Promise.all([acceptTaskTrigger(f.home, trigger), acceptTaskTrigger(f.home, trigger)]);
  assert.equal(a.occurrenceId, b.occurrenceId); await settle(f);
  const state = await readTaskState(f.home, "friend"); assert.equal(state.occurrences.length, 1); assert.equal(state.occurrences[0].state, "started");
  assert.equal(f.requests.length, 1); assert.match(JSON.stringify(f.requests[0]), /RULE_a/);
  const main = await executeLongAgentTurn(f.input("MAIN", "b")); assert.equal(main.text, "ack");
  await assert.rejects(acceptTaskTrigger(f.home, { ...trigger, scheduledAt: new Date(Date.now() + 60000).toISOString() }), /内容冲突/);
  await settle(f);
});
test("LA2 queue-one is bounded; cancel waiting run and pause future leave active work intact", async t => {
  const f = await setup(t); let release; const wait = new Promise(r => { release = r; }); let arrive;
  const arrived = new Promise(r => { arrive = r; });
  f.setHandler(async () => { arrive(); await wait; return { content: "done" }; });
  const task = (await f.command({ operation: "create", requestId: "one", definition })).tasks[0];
  await acceptTaskTrigger(f.home, f.trigger(task, "first")); await arrived; await dispatchTaskOccurrences(f.home, "friend");
  await acceptTaskTrigger(f.home, f.trigger(task, "second")); await dispatchTaskOccurrences(f.home, "friend");
  await acceptTaskTrigger(f.home, f.trigger(task, "third"));
  let state = await readTaskState(f.home, "friend"); assert.deepEqual(state.occurrences.map(o => o.state), ["started", "accepted", "skipped"]);
  await f.command({ operation: "cancel-run", occurrenceId: state.occurrences[1].id });
  const paused = await f.command({ operation: "pause", taskId: task.id, expectedRevision: 1 });
  assert.equal(paused.occurrences[0].work.execution.status, "running");
  release(); await settle(f); state = await readTaskState(f.home, "friend");
  assert.equal(state.occurrences[1].state, "skipped"); assert.equal(f.requests.length, 1);
});
test("LA2 migration retains legacy script ownership and requires explicit rewrite before resume", async t => {
  const f = await setup(t, [{ id: "legacy", createdAt: new Date().toISOString(), processAfter: new Date().toISOString(), prompt: "old", recurrence: null, script: "exit 0", status: "pending" }]);
  await migrateFriendTasks(f.home, "friend"); await migrateFriendTasks(f.home, "friend");
  const state = await readTaskState(f.home, "friend"); assert.equal(state.tasks.length, 1); const task = state.tasks[0];
  assert.equal(task.status, "paused"); assert.match(task.migrationNote, /脚本/);
  await assert.rejects(f.command({ operation: "resume", taskId: task.id, expectedRevision: 1 }), /脚本/);
  const edited = await f.command({ operation: "update", taskId: task.id, expectedRevision: 1, definition });
  assert.equal(edited.tasks[0].migrationNote, undefined); assert.equal(edited.tasks[0].status, "paused");
});
test("Friend creation errors identify offline, authentication and version failures without disclosing credentials", () => {
  assert.match(projectFriendCreationError(new NanoClawGatewayUnavailableError("secret")).statusMessage, /无法连接/);
  for (const [code, pattern] of [[401, /认证失败/], [404, /创建接口/], [409, /配置冲突/], [500, /Host日志/]]) {
    const result = projectFriendCreationError(new NanoClawGatewayError("secret", code)); assert.match(result.statusMessage, pattern); assert.doesNotMatch(result.statusMessage, /secret/);
  }
});
test("LA2 missed once is skipped; manual request retries survive reload without creating another work", async t => {
  const f = await setup(t);
  const task = (await f.command({ operation: "create", requestId: "once", definition: { ...definition, schedule: { kind: "once", at: new Date(Date.now()-600000).toISOString() } } })).tasks[0];
  await acceptTaskTrigger(f.home, f.trigger(task, "unused", { source: "time", sourceId: `${task.timeZone}:${task.schedule.at}`, scheduledAt: task.schedule.at }));
  assert.equal((await readTaskState(f.home, "friend")).occurrences[0].state, "skipped");
  const command = { operation: "run", taskId: task.id, expectedRevision: 1, requestId: "retained-after-reload" };
  await f.command(command); await settle(f); await f.command(command); await settle(f);
  const state = await readTaskState(f.home, "friend"); assert.equal(state.occurrences.length, 2); assert.equal(f.requests.length, 1);
});
test("LA2 invalid timezone is an actionable client error, not an uncertain committed request", async () => {
  const { parseTaskInput, FriendTaskError } = await import("../../src/long-agents/tasks/contract.ts");
  assert.throws(() => parseTaskInput({ ...definition, timeZone: "Mars/Olympus" }), error => error instanceof FriendTaskError && error.statusCode === 400 && error.message.includes("IANA"));
});
test("LA2 restores a lost occurrence-to-work commit from the same native acceptance", async t => {
  const f = await setup(t); const task = (await f.command({ operation: "create", requestId: "recovery", definition })).tasks[0];
  await f.command({ operation: "run", taskId: task.id, expectedRevision: 1, requestId: "durable" }); await settle(f);
  const before = (await readTaskState(f.home, "friend")).occurrences[0];
  const { changeTaskState } = await import("../../src/long-agents/tasks/storage.ts");
  await changeTaskState(f.home, "friend", s => { s.occurrences[0].state = "accepted"; s.occurrences[0].workId = null; });
  await settle(f);
  const restored = (await readTaskState(f.home, "friend")).occurrences[0];
  assert.equal(restored.workId, before.workId); assert.equal(restored.originSessionId, before.originSessionId); assert.equal(restored.state, "started"); assert.equal(f.requests.length, 1);
});
