import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fixture } from "./daily-fixture.mjs";
import { openChatSession } from "../../src/chat-session.ts";
import { readLongAgentRegistry, writeLongAgentRegistry } from "../../src/long-agents/storage.ts";
import { ensureProjectLongAgent } from "../../src/long-agents/project-agent.ts";
import { changeTaskState, readTaskState } from "../../src/long-agents/tasks/storage.ts";
import { acceptTaskTrigger, dispatchTaskOccurrences } from "../../src/long-agents/tasks/service.ts";
import { ensureDailySummaryTask } from "../../src/long-agents/daily-summary-task.ts";
import { readAgentDaySources, readAgentDayArchive, readAgentArchiveSession } from "../../src/long-agents/day-archive.ts";
import { readLongAgentSummary, writeLongAgentSummary, buildLongAgentHandoff, searchLongAgentSummaries, assertSummarySourcesReadable } from "../../src/long-agents/summaries.ts";
import { createConversation, readConversation, revokeMember } from "../../src/long-agents/conversations/service.ts";
import { startConversationWork } from "../../src/long-agents/conversations/work.ts";
import { changeWorkState } from "../../src/long-agents/conversations/work-store.ts";
import { systemToolAddress } from "../../src/tools/framework.ts";
import { drainLongAgentTurns } from "../../src/long-agents/turn-queue.ts";
import { listFriendWork, deliverFriendWorkReturns } from "../../src/long-agents/work.ts";

async function setup(t) {
  const f = await fixture(t);
  const registry = await readLongAgentRegistry(f.home);
  const agent = { ...registry.agents[0], definition: { ...registry.agents[0].definition,
    tools: { mode: "explicit", names: [], exclude: [], addresses: [systemToolAddress("summary_manage")] } } };
  await writeLongAgentRegistry({ ...registry, agents: [agent] }, f.home);
  await changeTaskState(f.home, agent.id, state => { state.migration = "complete"; });
  const task = await ensureDailySummaryTask(f.home, agent);
  return { ...f, agent, task };
}

test("daily work is provisioned once; changing, pausing and cancelling never recreates it", async t => {
  const f = await setup(t);
  assert.equal(f.task.schedule.expression, "10 0 * * *"); assert.equal(f.task.timeZone, "Asia/Shanghai");
  assert.equal(f.task.missed, "latest"); assert.equal(f.task.contextProjectId, null);
  for (const status of ["paused", "cancelled"]) {
    await changeTaskState(f.home, "friend", state => {
      const updated = { ...state.tasks[0], revision: state.tasks[0].revision + 1, status, schedule: { kind: "cron", expression: "30 1 * * *" } };
      state.tasks = [updated]; state.revisions.push(updated);
    });
    const task = await ensureDailySummaryTask(f.home, f.agent);
    assert.equal(task.status, status); assert.equal(task.schedule.expression, "30 1 * * *");
    assert.equal((await readTaskState(f.home, "friend")).tasks.length, 1);
  }
});

test("real task → Work → Workflow → Pi tool writes an independent day artifact with frozen coverage", async t => {
  const f = await setup(t);
  const date = "2026-09-29";
  const old = await ensureProjectLongAgent({ chatHome: f.home, agent: f.agent, projectId: "friend", date });
  const native = await openChatSession({ chatHome: f.home, projectId: "friend", sessionId: old.day.sessionId });
  native.manager.appendMessage({ role: "user", content: "ARCHIVED_ACTIVITY", timestamp: Date.parse("2026-09-29T03:00:00Z") }); native.manager.flush();
  const before = JSON.stringify(native.manager.getEntries());
  let step = 0;
  const commands = [ { operation: "day", date }, { operation: "read", date },
    { operation: "write", date, expectedRevision: null, did: ["ARCHIVED_ACTIVITY 已核对"], reflections: ["任务和会话一起核对"], handoff: "NEXT_DAY_HANDOFF" } ];
  f.setHandler(body => {
    if (step >= commands.length) return { content: "archived" };
    assert.ok(body.tools.some(tool => tool.function.name === "summary_manage"), "selected tool is present in production assembly");
    const command = commands[step++];
    return { tool_calls: [{ index: 0, id: `summary-${step}`, type: "function", function: { name: "summary_manage", arguments: JSON.stringify(command) } }] };
  });
  const scheduledAt = "2026-09-29T16:10:00.000Z";
  const trigger = { schemaVersion: 1, instanceId: "local", agentGroupId: "group", taskId: f.task.id, revision: 1,
    source: "time", sourceId: `Asia/Shanghai:${scheduledAt}`, scheduledAt };
  const receipt = await acceptTaskTrigger(f.home, trigger);
  await dispatchTaskOccurrences(f.home, "friend");
  const work = (await listFriendWork(f.home, "friend")).works[0].work;
  await drainLongAgentTurns(f.home, "friend", work.sessionId);
  const occurrence = (await readTaskState(f.home, "friend")).occurrences[0];
  assert.equal(occurrence.summaryDate, date); assert.equal(occurrence.workId, work.id);
  assert.notEqual(work.sessionId, old.day.sessionId);
  const summary = await readLongAgentSummary(f.home, "friend", date);
  assert.equal(summary.handoff, "NEXT_DAY_HANDOFF"); assert.equal(summary.archive.occurrenceId, receipt.occurrenceId);
  assert.match(await fs.readFile(path.join(f.home, "long-agents/friend/projects/friend/days", date, "summary.md"), "utf8"), /ARCHIVED_ACTIVITY/);
  await deliverFriendWorkReturns(f.home);
  const reopened = await openChatSession({ chatHome: f.home, projectId: "friend", sessionId: old.day.sessionId });
  assert.equal(JSON.stringify(reopened.manager.getEntries()), before, "day closing never appends to the original conversation");
  assert.match(await buildLongAgentHandoff({ chatHome: f.home, longAgentId: "friend", today: "2026-09-30" }), /NEXT_DAY_HANDOFF/);
  const calls = f.requests.length;
  assert.deepEqual(await acceptTaskTrigger(f.home, trigger), receipt); await dispatchTaskOccurrences(f.home, "friend");
  assert.equal(f.requests.length, calls, "same durable occurrence cannot rerun its model");
  const archive = await readAgentDayArchive(f.home, "friend", date);
  assert.ok(archive.works.some(item => item.workId === work.id)); assert.equal(archive.summary.fileName, "summary.md");
});

test("day sources include sessions and skipped tasks; history pages cannot read another Project", async t => {
  const f = await setup(t);
  const date = "2026-09-29";
  const own = await openChatSession({ chatHome: f.home, projectId: "friend" });
  const longText = "DAY_FACT_".repeat(9000);
  own.manager.appendMessage({ role: "user", content: longText, timestamp: Date.parse("2026-09-29T03:00:00Z") }); own.manager.flush();
  await changeTaskState(f.home, "friend", state => { const task = { ...state.tasks[0], status: "paused", revision: 2 }; state.tasks = [task]; state.revisions.push(task); });
  const scheduledAt = "2026-09-29T03:00:00.000Z";
  await acceptTaskTrigger(f.home, { schemaVersion: 1, instanceId: "local", agentGroupId: "group", taskId: f.task.id, revision: 2, source: "time", sourceId: `Asia/Shanghai:${scheduledAt}`, scheduledAt });
  await dispatchTaskOccurrences(f.home, "friend");
  const sources = await readAgentDaySources(f.home, "friend", date);
  assert.equal(sources.occurrences[0].state, "skipped");
  assert.ok(sources.sessions.some(item => item.sessionId === own.manager.getSessionId()));
  const first = await readAgentArchiveSession(f.home, "friend", own.manager.getSessionId(), undefined, date);
  assert.equal(first.messages[0].content.length, 24000); assert.ok(first.nextCursor);
  let text = first.messages.map(item => item.content).join(""), cursor = first.nextCursor;
  while (cursor) { const page = await readAgentArchiveSession(f.home, "friend", own.manager.getSessionId(), cursor, date); text += page.messages.map(item => item.content).join(""); cursor = page.nextCursor; }
  assert.equal(JSON.parse(text).content, longText);
  const unrelated = await openChatSession({ chatHome: f.home, projectId: "a" });
  unrelated.manager.appendMessage({ role: "user", content: "PRIVATE", timestamp: Date.now() }); unrelated.manager.flush();
  await assert.rejects(readAgentArchiveSession(f.home, "friend", unrelated.manager.getSessionId()), /不属于/);
  await assert.rejects(readAgentDaySources(f.home, "friend", "2026-02-30"), /date/);
});

test("Markdown CAS, legacy fallback and old-date search preserve memory without stale handoffs", async t => {
  const f = await setup(t);
  const input = { chatHome: f.home, longAgentId: "friend", date: "2025-01-01", did: ["OLD_SEARCH_FACT"], handoff: "old" };
  const saved = await writeLongAgentSummary({ ...input, expectedRevision: null });
  assert.equal((await readLongAgentSummary(f.home, "friend", input.date)).revision, saved.revision);
  await assert.rejects(writeLongAgentSummary({ ...input, expectedRevision: null }), /已改变/);
  await writeLongAgentSummary({ ...input, expectedRevision: saved.revision, handoff: "corrected" });
  assert.equal((await searchLongAgentSummaries({ ...input, query: "OLD_SEARCH_FACT" }))[0].date, input.date);
  assert.deepEqual(await searchLongAgentSummaries({ ...input, query: "OLD_SEARCH_FACT", from: "2026-01-01" }), []);
  const handoff = await buildLongAgentHandoff({ chatHome: f.home, longAgentId: "friend", today: "2026-09-30" });
  assert.match(handoff, /尚未生成/); assert.doesNotMatch(handoff, /OLD_SEARCH_FACT/);
});

test("unselected archive tool blocks scheduled work without silently expanding capabilities", async t => {
  const f = await setup(t);
  const registry = await readLongAgentRegistry(f.home);
  await writeLongAgentRegistry({ ...registry, agents: registry.agents.map(agent => ({ ...agent, definition: { ...agent.definition, tools: { mode: "none" } } })) }, f.home);
  await acceptTaskTrigger(f.home, { schemaVersion: 1, instanceId: "local", agentGroupId: "group", taskId: f.task.id, revision: 1, source: "manual", sourceId: "missing-tool", scheduledAt: new Date().toISOString() });
  await dispatchTaskOccurrences(f.home, "friend");
  const occurrence = (await readTaskState(f.home, "friend")).occurrences[0];
  assert.equal(occurrence.state, "blocked"); assert.match(occurrence.reason, /summary_manage/); assert.equal(f.requests.length, 0);
});

test("unreadable or unauthorized summaries cannot break a new day or inject private Project data", async t => {
  const f = await setup(t);
  const foreign = await openChatSession({ chatHome: f.home, projectId: "a" });
  foreign.manager.appendMessage({ role: "user", content: "SECRET_SOURCE", timestamp: Date.now() }); foreign.manager.flush();
  const input = { chatHome: f.home, longAgentId: "friend", date: "2026-09-29", did: ["SECRET_SOURCE"], archive: {
    sessionId: "source", workId: null, occurrenceId: null,
    sources: { sessions: [{ projectId: "a", sessionId: foreign.manager.getSessionId() }] } } };
  await writeLongAgentSummary(input);
  let handoff = await buildLongAgentHandoff({ chatHome: f.home, longAgentId: "friend", today: "2026-09-30" });
  assert.match(handoff, /暂不可读取/); assert.doesNotMatch(handoff, /SECRET_SOURCE/);
  await fs.writeFile(path.join(f.home, "long-agents/friend/projects/friend/days/2026-09-29/summary.md"), "corrupt header");
  handoff = await buildLongAgentHandoff({ chatHome: f.home, longAgentId: "friend", today: "2026-09-30" });
  assert.match(handoff, /正常交流不受影响/);
});

test("ongoing group work stays in the daily directory and derived memory obeys membership revocation", async t => {
  const f = await setup(t);
  const conversation = await createConversation({ chatHome: f.home, storageProjectId: "a", title: "归档组", requestId: "archive-group", memberLongAgentIds: ["friend"] });
  await startConversationWork({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend", requestId: "archive-work", title: "跨日工作", instruction: "检查结果" });
  await changeWorkState(f.home, "a", conversation.id, state => {
    state.works[0].createdAt = "2026-09-28T01:00:00Z";
    state.works[0].updatedAt = "2026-09-28T01:00:00Z";
  });
  const sources = await readAgentDaySources(f.home, "friend", "2026-09-29");
  assert.equal(sources.works.length, 1);
  assert.equal(sources.works[0].sessionId, null, "the directory does not expose private group task transcripts");
  assert.equal(sources.groups.length, 1);
  const summary = await writeLongAgentSummary({ chatHome: f.home, longAgentId: "friend", date: "2026-09-29", did: ["跨日工作进行中"], archive: { sessionId: "own", workId: null, occurrenceId: null, sources } });
  await assertSummarySourcesReadable(f.home, "friend", summary);
  await revokeMember({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend", expectedRevision: (await readConversation(f.home, "a", conversation.id)).revision });
  await assert.rejects(assertSummarySourcesReadable(f.home, "friend", summary), /权限已变化/);
  assert.equal((await readAgentDaySources(f.home, "friend", "2026-09-29")).works.length, 0);
});
