import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureAgentHomeProject, openProject } from "../../src/projects/registry.ts";
import { openChatSession } from "../../src/chat-session.ts";
import { createChatPiAgentSession } from "../../src/agents/pi-agent-session.ts";
import { prepareLongAgentAssembly } from "../../src/long-agents/assembly.ts";
import { readLongAgentRegistry, writeLongAgentRegistry, readLongAgentState, updateLongAgentState } from "../../src/long-agents/storage.ts";
import { ensureProjectLongAgent } from "../../src/long-agents/project-agent.ts";
import { acceptLongAgentTurn, drainLongAgentTurns, controlQueuedRequest, installAcceptedAssembly } from "../../src/long-agents/turn-queue.ts";
import { executeLongAgentTurn } from "../../src/long-agents/runtime.ts";
import { maintainLongAgentDays, recoverLongAgentTurns, retryDailySummary } from "../../src/long-agents/daily-maintenance.ts";
import { readLongAgentSummary, buildLongAgentHandoff } from "../../src/long-agents/summaries.ts";
import { appendChatLongAgentTurn } from "../../src/long-agents/session-turn.ts";
import { readFriendDays, actOnFriendDay } from "../../src/long-agents/daily-service.ts";
import { agentDate, validateTimeZone } from "../../src/long-agents/calendar.ts";

import { fixture } from "./daily-fixture.mjs";
const tomorrow = () => new Date(Date.now() + 86_400_000);
const system = (body) => JSON.stringify(body.messages.filter((m) => m.role === "system" || m.role === "developer"));
const summary = { did: ["项目a完成阅读", "项目b待续"], reflections: ["保留项目来源"], handoff: "HANDOFF_PROJECT_B_NEXT" };

// Only Date is mocked: real HTTP, native Pi streaming and filesystem writes remain in use.
test("P3 calendar: concurrent opens, timezone, old links and crash before day index commit", async (t) => {
  const f = await fixture(t); const agent = (await readLongAgentRegistry(f.home)).agents[0];
  assert.equal(agentDate("Asia/Shanghai", new Date("2026-09-19T16:00:00Z")), "2026-09-20");
  assert.equal(agentDate("America/New_York", new Date("2026-11-01T06:30:00Z")), "2026-11-01");
  assert.throws(() => validateTimeZone("not/a/zone"));
  const days = await Promise.all(["friend", "a", "b"].map((projectId) => ensureProjectLongAgent({ chatHome: f.home, projectId, agent })));
  assert.equal(new Set(days.map((day) => day.day.sessionId)).size, 1);
  const prior = days[0].day;
  await updateLongAgentState(f.home, (state) => ({ state: { ...state, projectAgents: [], dailySessions: [] }, result: undefined }));
  const recovered = await ensureProjectLongAgent({ chatHome: f.home, projectId: "a", agent });
  assert.equal(recovered.day.sessionId, prior.sessionId);
  await assert.rejects(ensureProjectLongAgent({ chatHome: f.home, projectId: "friend", agent, now: tomorrow(), requestedSessionId: prior.sessionId }), /历史保持只读/);
  assert.equal((await readLongAgentState(f.home)).dailySessions.length, 1, "old link cannot create an orphan next-day session");
  const next = await ensureProjectLongAgent({ chatHome: f.home, projectId: "friend", agent, now: tomorrow() });
  assert.notEqual(next.day.sessionId, prior.sessionId);
  assert.equal((await openChatSession({ chatHome: f.home, projectId: "friend", sessionId: prior.sessionId })).manager.getSessionId(), prior.sessionId);
});

test("P3 accepted Web/channel/schedule requests freeze rules and execute once in one ordered native Session", async (t) => {
  const f = await fixture(t);
  const inputs = [f.input("web", "a"), { ...f.input("channel", "b"), source: "channel", channelType: "telegram", inboundEventId: "event1" }, { ...f.input("schedule"), source: "scheduled" }];
  const turns = await Promise.all(inputs.map((input) => acceptLongAgentTurn(input)));
  assert.equal(new Set(turns.map((turn) => turn.sessionId)).size, 1);
  assert.deepEqual(turns.map((turn) => turn.sequence).sort(), [1, 2, 3]);
  assert.equal((await acceptLongAgentTurn(inputs[0])).turnId, turns[0].turnId);
  await assert.rejects(acceptLongAgentTurn({ ...inputs[0], contextProjectId: "b" }), /同一requestId/);
  fs.writeFileSync(path.join(f.projects[0].cwd, "AGENTS.md"), "CHANGED_AFTER_ACCEPT");
  await Promise.all(turns.map(() => drainLongAgentTurns(f.home, "friend")));
  assert.equal(f.requests.length, 6);
  for (const [index, turn] of [...turns].sort((a,b) => a.sequence-b.sequence).entries()) {
    // Each interactive turn is work + memory writer, so turn i owns request 2i.
    assert.match(JSON.stringify(f.requests[index * 2].messages), new RegExp(turn.requestId));
    if (turn.requestId === "web") { assert.match(system(f.requests[index * 2]), /RULE_a/); assert.doesNotMatch(system(f.requests[index * 2]), /CHANGED_AFTER_ACCEPT|RULE_b/); }
    if (turn.requestId === "channel") { assert.match(system(f.requests[index * 2]), /RULE_b/); assert.doesNotMatch(system(f.requests[index * 2]), /RULE_a/); }
  }
  const replay = await executeLongAgentTurn(inputs[0]); assert.equal(replay.text, "ack"); assert.equal(f.requests.length, 6);
  const state = await readLongAgentState(f.home); assert.ok(state.turns.every((turn) => turn.status === "completed" && turn.seed === undefined && turn.text === undefined));
  const view = await readFriendDays(f.home, "friend"); assert.equal(JSON.stringify(view).includes("RULE_a"), false);
});

test("P3 crossing midnight keeps accepted work in yesterday, closes without an empty day, hands off on each next-day assembly", async (t) => {
  const f = await fixture(t); t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-19T15:59:59Z") });
  const queued = await acceptLongAgentTurn(f.input("before-midnight", "a"));
  t.mock.timers.setTime(new Date("2026-09-19T16:00:01Z").getTime());
  await drainLongAgentTurns(f.home, "friend");
  assert.equal((await readLongAgentState(f.home)).turns[0].date, "2026-09-19");
  f.setHandler(() => ({ content: JSON.stringify(summary) }));
  await maintainLongAgentDays(f.home);
  let state = await readLongAgentState(f.home); assert.equal(state.dailySessions.length, 1);
  assert.equal(state.dailySessions[0].summary.status, "completed");
  const saved = await readLongAgentSummary(f.home, "friend", "2026-09-19"); assert.equal(saved.source.sessionId, queued.sessionId); assert.ok(saved.source.cutoff);
  assert.equal(f.requests.at(-1).tools?.length ?? 0, 0, "summaries cannot execute write tools");
  const old = await openChatSession({ chatHome: f.home, projectId: "friend", sessionId: queued.sessionId });
  assert.equal(old.manager.getEntries().filter((e) => e.type === "message" && e.message.role === "user").length, 1);
  assert.ok(old.manager.getEntries().some((e) => e.type === "custom_message" && e.customType === "chat.daily-summary.v1" && !e.display));
  const count = f.requests.length; await maintainLongAgentDays(f.home); assert.equal(f.requests.length, count);
  f.setHandler(() => ({ content: "next day" }));
  const next = await executeLongAgentTurn(f.input("next-day", "b")); await executeLongAgentTurn(f.input("next-day-again", "b"));
  assert.notEqual(next.sessionId, queued.sessionId); assert.match(system(f.requests.at(-2)), /HANDOFF_PROJECT_B_NEXT/);
  assert.doesNotMatch(system(f.requests.at(-2)), /RULE_a/); assert.match(system(f.requests.at(-2)), /RULE_b/);
  state = await readLongAgentState(f.home); assert.equal(state.dailySessions.length, 2);
});

test("P3 summary failure stays visible, explicit retry repairs it without adding a fake user message", async (t) => {
  const f = await fixture(t); await executeLongAgentTurn(f.input("one"));
  f.setHandler(() => ({ content: "network timeout (invalid JSON output, not a transport failure)" }));
  await maintainLongAgentDays(f.home, tomorrow());
  const day = (await readLongAgentState(f.home)).dailySessions[0]; assert.equal(day.summary.status, "failed"); assert.equal(day.summary.nextAttemptAt, null);
  const handoff = await buildLongAgentHandoff({ chatHome: f.home, longAgentId: "friend", today: agentDate("Asia/Shanghai", tomorrow()) });
  assert.match(handoff, /交接未就绪/);
  const count = f.requests.length; await maintainLongAgentDays(f.home, tomorrow()); assert.equal(f.requests.length, count);
  f.setHandler(() => ({ content: JSON.stringify(summary) }));
  t.mock.timers.enable({ apis: ["Date"], now: tomorrow() });
  await retryDailySummary(f.home, "friend", day.date);
  assert.equal((await readLongAgentState(f.home)).dailySessions[0].summary.status, "completed");
  assert.equal((await readLongAgentSummary(f.home, "friend", day.date)).handoff, summary.handoff);
});

test("P3 transient summary retries are capped at two without fabricating completion", async (t) => {
  const f = await fixture(t); await executeLongAgentTurn(f.input("one"));
  f.setHandler(() => ({ error: "network timeout" }));
  let now = tomorrow(); await maintainLongAgentDays(f.home, now);
  for (const delay of [60_000, 300_000]) {
    const pending = (await readLongAgentState(f.home)).dailySessions[0]; assert.equal(pending.summary.status, "failed"); assert.ok(pending.summary.nextAttemptAt);
    const count = f.requests.length; await maintainLongAgentDays(f.home, now); assert.equal(f.requests.length, count);
    now = new Date(now.getTime() + delay); await maintainLongAgentDays(f.home, now);
  }
  const exhausted = (await readLongAgentState(f.home)).dailySessions[0]; assert.equal(exhausted.summary.attempts, 3); assert.equal(exhausted.summary.nextAttemptAt, null);
  assert.equal(await readLongAgentSummary(f.home, "friend", exhausted.date), undefined);
});

test("P3 restart recovery resumes queued work, records unknown in-flight writes as interrupted and recovers proven completion", async (t) => {
  const f = await fixture(t);
  const turns = []; for (const id of ["unknown", "proven", "queued"]) turns.push(await acceptLongAgentTurn(f.input(id)));
  const session = await openChatSession({ chatHome: f.home, projectId: "friend", sessionId: turns[0].sessionId });
  for (const [index, turn] of turns.slice(0, 2).entries()) {
    installAcceptedAssembly(session.manager, turn);
    appendChatLongAgentTurn(session.manager, { turnId: turn.turnId, longAgentId: "friend", bindingId: "project-long-agent:friend:friend", source: "chat-web", channelType: "chat-web", inboundEventId: null, agentGroupContext: turn.groupContext, status: "running", startedAt: turn.acceptedAt, completedAt: null, error: null });
    session.manager.appendMessage({ role: "user", content: turn.text, timestamp: Date.now() });
    if (index === 1) session.manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "proven response" }], api: "openai-completions", provider: "p3-local", model: "daily-model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
  }
  session.manager.flush();
  await updateLongAgentState(f.home, (state) => ({ state: { ...state, turns: state.turns.map((turn, i) => i < 2 ? { ...turn, status: "running" } : turn) }, result: undefined }));
  await recoverLongAgentTurns(f.home);
  const recovered = await readLongAgentState(f.home);
  assert.equal(recovered.turns[0].status, "interrupted"); assert.equal(recovered.turns[1].status, "completed");
  await assert.rejects(controlQueuedRequest(f.home, "friend", turns[0].turnId, "retry"), /结果不明/);
  await drainLongAgentTurns(f.home, "friend"); assert.equal(f.requests.length, 2);
});

test("P3 queued cancellation and failed retries cannot rewind subsequent conversation", async (t) => {
  const f = await fixture(t); const cancelled = await acceptLongAgentTurn(f.input("cancel"));
  await actOnFriendDay(f.home, "friend", { action: "cancel-request", turnId: cancelled.turnId });
  await drainLongAgentTurns(f.home, "friend"); assert.equal(f.requests.length, 0);
  f.setHandler(() => ({ error: "invalid request" })); await assert.rejects(executeLongAgentTurn(f.input("failed")), /invalid request/);
  f.setHandler(() => ({ content: "later" })); await executeLongAgentTurn(f.input("later"));
  await assert.rejects(controlQueuedRequest(f.home, "friend", "chat-web:friend:failed", "retry"), /不能回退历史/);
});

test("P3 real Pi compaction restores historical project labels, runs file tools, then summarizes the same day", async (t) => {
  const f = await fixture(t); await executeLongAgentTurn({ ...f.input("work A", "a"), text: "A facts ".repeat(400) }); await executeLongAgentTurn({ ...f.input("work B", "b"), text: "B facts ".repeat(400) });
  const agent = (await readLongAgentRegistry(f.home)).agents[0]; const day = (await readLongAgentState(f.home)).dailySessions[0];
  const chatSession = await openChatSession({ chatHome: f.home, projectId: "friend", sessionId: day.sessionId });
  const prepared = await prepareLongAgentAssembly({ agent, chatHome: f.home, projectId: "b", turnId: "compaction-check" });
  const created = await createChatPiAgentSession({ chatSession, sessionManager: chatSession.manager, ...prepared, toolContext: { purpose: "execution", agentId: "friend", longAgentId: "friend", longAgentTurnId: "compaction-check" } });
  f.setHandler(() => ({ content: "COMPACTED: project a facts; project b unfinished" }));
  const before = f.requests.length; await created.session.compact("Preserve project identity of each historical part."); created.session.dispose();
  assert.match(JSON.stringify(f.requests.slice(before)), /collaboration project: a/);
  assert.match(JSON.stringify(f.requests.slice(before)), /collaboration project: b/);
  f.setHandler((body) => body.messages.at(-1).role === "tool" ? { content: "wrote" } : { tool_calls: [{ index: 0, id: "write-after-compact", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "continued.txt", content: "b" }) } }] });
  await executeLongAgentTurn(f.input("continue", "b")); assert.equal(fs.readFileSync(path.join(f.projects[1].cwd, "continued.txt"), "utf8"), "b"); assert.equal(fs.existsSync(path.join(f.projects[0].cwd, "continued.txt")), false);
  const reopened = await openChatSession({ chatHome: f.home, projectId: "friend", sessionId: day.sessionId }); assert.equal(reopened.manager.getEntries().filter((e) => e.type === "compaction").length, 1);
  f.setHandler(() => ({ content: JSON.stringify(summary) })); await maintainLongAgentDays(f.home, tomorrow());
  assert.equal((await readLongAgentState(f.home)).dailySessions[0].summary.status, "completed"); assert.match(JSON.stringify(f.requests.at(-1)), /COMPACTED/);
});

test("P3 summary JSON commit survives derived Markdown failure; retry repairs without a second model call", async (t) => {
  const f = await fixture(t); await executeLongAgentTurn(f.input("work"));
  const day = (await readLongAgentState(f.home)).dailySessions[0];
  const summaries = path.join(f.home, "long-agents/friend/summaries"); fs.mkdirSync(path.join(summaries, `${day.date}.md`), { recursive: true });
  f.setHandler(() => ({ content: JSON.stringify(summary) }));
  await maintainLongAgentDays(f.home, tomorrow());
  assert.equal((await readLongAgentState(f.home)).dailySessions[0].summary.status, "failed");
  assert.ok((await readLongAgentSummary(f.home, "friend", day.date)).source.entryId);
  fs.rmdirSync(path.join(summaries, `${day.date}.md`));
  const count = f.requests.length; t.mock.timers.enable({ apis: ["Date"], now: tomorrow() });
  await retryDailySummary(f.home, "friend", day.date);
  assert.equal(f.requests.length, count); assert.match(fs.readFileSync(path.join(summaries, `${day.date}.md`), "utf8"), /HANDOFF_PROJECT_B_NEXT/);
  assert.equal((await readLongAgentState(f.home)).dailySessions[0].summary.status, "completed");
});

test("P3 recovery reuses a native summary output written before the final state commit", async (t) => {
  const f = await fixture(t); await executeLongAgentTurn(f.input("work")); f.setHandler(() => ({ content: JSON.stringify(summary) }));
  await maintainLongAgentDays(f.home, tomorrow());
  const day = (await readLongAgentState(f.home)).dailySessions[0];
  const summaries = path.join(f.home, "long-agents/friend/summaries");
  fs.unlinkSync(path.join(summaries, `${day.date}.json`)); fs.unlinkSync(path.join(summaries, `${day.date}.md`));
  await updateLongAgentState(f.home, (state) => ({ state: { ...state, dailySessions: state.dailySessions.map((entry) => ({ ...entry, summary: { ...entry.summary, status: "running", entryId: null, revision: null } })) }, result: undefined }));
  const count = f.requests.length; await maintainLongAgentDays(f.home, tomorrow());
  assert.equal(f.requests.length, count); assert.equal((await readLongAgentSummary(f.home, "friend", day.date)).source.entryId, day.summary.entryId);
});

test("P3 an accepted queue resumes in a fresh Backend process from its persisted assembly", async (t) => {
  const f = await fixture(t); await acceptLongAgentTurn(f.input("restart-queued", "a"));
  const { execFile } = await import("node:child_process"); const { promisify } = await import("node:util");
  await promisify(execFile)(process.execPath, ["--import", path.resolve("scripts/typescript-test-loader.mjs"), "--experimental-strip-types", "--input-type=module", "-e",
    'const { drainLongAgentTurns } = await import("./src/long-agents/turn-queue.ts"); await drainLongAgentTurns(process.argv[1], "friend");', f.home], { cwd: process.cwd() });
  assert.equal(f.requests.length, 2); assert.match(system(f.requests[0]), /RULE_a/);
  assert.equal((await readLongAgentState(f.home)).turns[0].status, "completed");
});

test("P3 scheduled summary drafts stay internal and read-only, without pretending the day is finalized", async (t) => {
  const f = await fixture(t);
  await assert.rejects(executeLongAgentTurn({ ...f.input("empty-draft"), source: "scheduled", summaryDraft: true }), /没有可整理活动/);
  assert.equal((await readLongAgentState(f.home)).dailySessions.length, 0);
  await executeLongAgentTurn(f.input("actual-work"));
  const result = await executeLongAgentTurn({ ...f.input("draft"), source: "scheduled", summaryDraft: true });
  assert.equal(f.requests.at(-2).tools?.length ?? 0, 0);
  const session = await openChatSession({ chatHome: f.home, projectId: "friend", sessionId: result.sessionId });
  assert.equal(session.manager.getEntries().filter((e) => e.type === "message" && e.message.role === "user").length, 1);
  assert.ok(session.manager.getEntries().some((e) => e.type === "custom_message" && e.customType === "chat.daily-summary-draft.v1" && !e.display));
  assert.equal((await readLongAgentState(f.home)).dailySessions[0].summary.status, "pending");
});

test("P3 HTTP daily projection/actions and revision-protected timezone settings share the real persisted state", async (t) => {
  const f = await fixture(t); const accepted = await acceptLongAgentTurn(f.input("queued-http", "a"));
  const previous = process.env.CHAT_HOME; process.env.CHAT_HOME = f.home;
  t.after(() => { if (previous === undefined) delete process.env.CHAT_HOME; else process.env.CHAT_HOME = previous; });
  const { createRouter } = await import("nitro/h3");
  const { default: getDaily } = await import("../../src/routes/api/long-agents/[longAgentId]/daily.get.ts");
  const { default: postDaily } = await import("../../src/routes/api/long-agents/[longAgentId]/daily.post.ts");
  const { default: getConfig } = await import("../../src/routes/api/long-agents/[longAgentId]/config.get.ts");
  const { default: putConfig } = await import("../../src/routes/api/long-agents/[longAgentId]/config.put.ts");
  const router = createRouter(); router.get("/api/long-agents/:longAgentId/daily", getDaily); router.post("/api/long-agents/:longAgentId/daily", postDaily);
  router.get("/api/long-agents/:longAgentId/config", getConfig); router.put("/api/long-agents/:longAgentId/config", putConfig);
  const endpoint = "http://chat.test/api/long-agents/friend";
  const response = await router.fetch(new Request(`${endpoint}/daily`)); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json(); assert.equal(body.requests[0].turnId, accepted.turnId); assert.doesNotMatch(JSON.stringify(body), /RULE_a|groupContext|seed/);
  const mutate = (suffix, method, value) => router.fetch(new Request(`${endpoint}/${suffix}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }));
  assert.equal((await mutate("daily", "POST", { action: "cancel-request", turnId: accepted.turnId, prompt: "forged" })).status, 400);
  const cancelled = await mutate("daily", "POST", { action: "cancel-request", turnId: accepted.turnId }); assert.equal(cancelled.status, 200); assert.equal((await cancelled.json()).requests[0].status, "cancelled");
  const document = await (await router.fetch(new Request(`${endpoint}/config`))).json();
  const { model, thinkingLevel, ...definition } = document.agent.definition;
  const update = { schemaVersion: 1, expectedRevision: document.revision, name: document.agent.name, description: document.agent.description, enabled: true, defaultProjectId: "friend", definition, timeZone: "America/New_York" };
  const changed = await mutate("config", "PUT", update); assert.equal(changed.status, 200); const updated = await changed.json(); assert.equal(updated.agent.timeZone, "America/New_York");
  assert.equal((await mutate("config", "PUT", { ...update, expectedRevision: updated.revision, timeZone: "not/a/zone" })).status, 400);
  assert.equal((await mutate("config", "PUT", update)).status, 409);
  assert.equal((await readLongAgentState(f.home)).turns[0].timeZone, "Asia/Shanghai");
});

test("P3 missing summary credentials stay failed and visible without a fabricated handoff", async (t) => {
  const f = await fixture(t); await executeLongAgentTurn(f.input("work"));
  const modelsPath = path.join(f.home, "agent/models.json"); const models = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
  delete models.providers['p3-local'].apiKey; fs.writeFileSync(modelsPath, JSON.stringify(models));
  await maintainLongAgentDays(f.home, tomorrow());
  const day = (await readLongAgentState(f.home)).dailySessions[0]; assert.equal(day.summary.status, 'failed'); assert.equal(day.summary.nextAttemptAt, null);
  assert.match(day.summary.error, /key|auth|认证/i); assert.equal(await readLongAgentSummary(f.home, 'friend', day.date), undefined); assert.equal(f.requests.length, 2);
});

test("P3 changing timezone freezes the new zone per request without duplicating an existing local date", async (t) => {
  const f = await fixture(t); t.mock.timers.enable({ apis:['Date'], now:new Date('2026-09-19T12:00:00Z') });
  const first = await acceptLongAgentTurn(f.input('zone-first'));
  const registry = await readLongAgentRegistry(f.home); await writeLongAgentRegistry({...registry,agents:registry.agents.map(agent=>({...agent,timeZone:'America/New_York'}))},f.home);
  const next = await acceptLongAgentTurn(f.input('zone-next')); assert.equal(first.sessionId,next.sessionId); assert.equal(first.timeZone,'Asia/Shanghai'); assert.equal(next.timeZone,'America/New_York');
  await drainLongAgentTurns(f.home,'friend'); assert.equal((await readLongAgentState(f.home)).dailySessions.length,1);
});
