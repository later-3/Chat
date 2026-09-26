import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fixture } from "./daily-fixture.mjs";
import { executeLongAgentTurn } from "../../src/long-agents/runtime.ts";
import { acceptLongAgentTurn, drainLongAgentTurns } from "../../src/long-agents/turn-queue.ts";
import { startFriendWork, readFriendWork, cancelFriendWork, deliverFriendWorkReturns, WORK_RETURN } from "../../src/long-agents/work.ts";
import { readLongAgentState } from "../../src/long-agents/storage.ts";
import { openChatSession } from "../../src/chat-session.ts";
import { readChatSessionOwnerIndex, chatSessionOwner } from "../../src/session-owner.ts";
import { createWorkflowCallWriter } from "../../src/workflows/workflow-call-writer.ts";
import { chatSessionOperationKey, withChatSessionOperationLock } from "../../src/session-operation-lock.ts";

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function setup(t) {
  const f = await fixture(t);
  const origin = await executeLongAgentTurn(f.input("main-start", "a"));
  return { ...f, origin, work: (requestId, text = "BACKGROUND") => ({ chatHome: f.home, longAgentId: "friend",
    originSessionId: origin.sessionId, contextProjectId: "a", requestId, title: "独立研究", text }) };
}

test("LA1 real acceptance keeps main chat responsive while the same Friend works in a separate native Session", { timeout: 15000 }, async t => {
  const f = await setup(t); const arrived = deferred(), release = deferred();
  f.setHandler(async body => {
    if (JSON.stringify(body.messages).includes("BACKGROUND")) { arrived.resolve(); await release.promise; return { content: "WORK_RESULT" }; }
    return { content: "MAIN_REPLY" };
  });
  const created = await startFriendWork(f.work("one"));
  await arrived.promise;
  const main = await executeLongAgentTurn({ ...f.input("MAIN_CONTINUES", "b"), sessionId: f.origin.sessionId });
  assert.equal(main.text, "MAIN_REPLY");
  assert.notEqual(created.execution.sessionId, main.sessionId);
  assert.equal((await readFriendWork(f.home, "friend", created.work.id)).execution.status, "running");
  release.resolve(); await drainLongAgentTurns(f.home, "friend", created.work.sessionId);
  await deliverFriendWorkReturns(f.home); await deliverFriendWorkReturns(f.home);
  const parent = await openChatSession({ chatHome: f.home, projectId: "friend", sessionId: main.sessionId });
  assert.match(JSON.stringify(parent.manager.getBranch()), /MAIN_CONTINUES/);
  assert.doesNotMatch(JSON.stringify(parent.manager.getBranch()), /WORK_RESULT/);
  const returns = parent.manager.getEntries().filter(e => e.type === "custom_message" && e.customType === WORK_RETURN);
  assert.equal(returns.length, 1);
  const child = await openChatSession({ chatHome: f.home, projectId: "friend", sessionId: created.work.sessionId });
  assert.doesNotMatch(JSON.stringify(child.manager.getBranch()), /MAIN_CONTINUES|main-start/);
  assert.equal(child.manager.getHeader().parentSession, parent.manager.getSessionFile());
  assert.equal(chatSessionOwner(await readChatSessionOwnerIndex("friend", f.home), created.work.sessionId).type, "long-agent");
  assert.equal((await readFriendWork(f.home, "friend", created.work.id)).result.text, "WORK_RESULT");
});

test("LA1 concurrent retries converge; changed payload, foreign identity, project change and recursive work fail closed", async t => {
  const f = await setup(t);
  const [a, b] = await Promise.all([startFriendWork(f.work("same")), startFriendWork(f.work("same"))]);
  assert.equal(a.work.id, b.work.id); assert.equal(a.work.sessionId, b.work.sessionId);
  await drainLongAgentTurns(f.home, "friend", a.work.sessionId);
  assert.equal(f.requests.length, 4);
  await assert.rejects(startFriendWork(f.work("same", "changed")), /不同输入/);
  await assert.rejects(startFriendWork({ ...f.work("other"), originSessionId: a.work.sessionId }), /不能递归/);
  await assert.rejects(readFriendWork(f.home, "other-friend", a.work.id), /找不到/);
  await assert.rejects(acceptLongAgentTurn({ ...f.input("change-project", "b"), sessionId: a.work.sessionId }), /项目已固定/);
  await assert.rejects(cancelFriendWork(f.home, "friend", a.work.id, "stale-turn"), /执行已变化/);
});

test("LA1 cancellation of detached work does not cancel or replace the main conversation", { timeout: 15000 }, async t => {
  const f = await setup(t); const arrived = deferred(); const release = deferred();
  f.setHandler(async body => {
    if (JSON.stringify(body.messages).includes("BACKGROUND")) { arrived.resolve(); await release.promise; }
    return { content: "reply" };
  });
  const work = await startFriendWork(f.work("cancel")); await arrived.promise;
  await cancelFriendWork(f.home, "friend", work.work.id, work.execution.id);
  await drainLongAgentTurns(f.home, "friend", work.work.sessionId);
  assert.equal((await readFriendWork(f.home, "friend", work.work.id)).execution.status, "cancelled");
  const main = await executeLongAgentTurn({ ...f.input("still here", "a"), sessionId: f.origin.sessionId });
  assert.equal(main.sessionId, f.origin.sessionId); assert.equal(main.text, "reply"); release.resolve();
});

test("LA1 same work orders subsequent messages and keeps the original project", async t => {
  const f = await setup(t); const work = await startFriendWork(f.work("ordered"));
  const second = await acceptLongAgentTurn({ ...f.input("second-task-turn", "a"), sessionId: work.work.sessionId });
  await drainLongAgentTurns(f.home, "friend", work.work.sessionId);
  const turns = (await readLongAgentState(f.home)).turns.filter(turn => turn.workId === work.work.id);
  assert.equal(turns.length, 2); assert.ok(turns.every(turn => turn.status === "completed"));
  assert.equal(second.sessionId, work.work.sessionId);
  assert.match(JSON.stringify(f.requests.at(-2)), /BACKGROUND/);
  assert.match(JSON.stringify(f.requests.at(-1)), /second-task-turn/);
});

test("LA1 actual Workflow return writer waits for the parent and reopens its latest native branch", async t => {
  const f = await setup(t);
  const parent = await openChatSession({ chatHome: f.home, projectId: "friend", sessionId: f.origin.sessionId });
  const writer = createWorkflowCallWriter(parent.manager, "friend"); writer.release();
  const entered = deferred(), release = deferred();
  const concurrent = withChatSessionOperationLock(chatSessionOperationKey("friend", f.origin.sessionId), async () => {
    const fresh = SessionManager.open(parent.manager.getSessionFile()); entered.resolve(); await release.promise;
    fresh.appendMessage({ role: "user", content: "USER_AFTER_CHILD_STARTED", timestamp: Date.now() }); fresh.flush();
  });
  await entered.promise;
  const complete = () => writer.write(current => {
    if (current.getEntries().some(e => e.type === "custom" && e.customType === "test.return")) return;
    current.appendCustomEntry("test.return", { callId: "one" }); current.flush();
  });
  const pending = complete(); release.resolve(); await Promise.all([pending, concurrent]); await complete();
  const restored = SessionManager.open(parent.manager.getSessionFile());
  assert.match(JSON.stringify(restored.getBranch()), /USER_AFTER_CHILD_STARTED/);
  assert.equal(restored.getEntries().filter(e => e.type === "custom" && e.customType === "test.return").length, 1);
});

test("LA1 closing yesterday's origin keeps late results in the work inbox without reopening the old day", async t => {
  const f = await setup(t);
  const work = await startFriendWork(f.work("late")); await drainLongAgentTurns(f.home, "friend", work.work.sessionId);
  const { updateLongAgentState } = await import("../../src/long-agents/storage.ts");
  await updateLongAgentState(f.home, state => ({ state: { ...state, dailySessions: state.dailySessions.map(day => ({ ...day, summary: { ...day.summary, status: "completed" } })) }, result: undefined }));
  const before = (await openChatSession({ chatHome: f.home, projectId: "friend", sessionId: f.origin.sessionId })).manager.getEntries();
  await deliverFriendWorkReturns(f.home);
  const after = (await openChatSession({ chatHome: f.home, projectId: "friend", sessionId: f.origin.sessionId })).manager.getEntries();
  assert.deepEqual(after, before);
  assert.equal((await readFriendWork(f.home, "friend", work.work.id)).execution.status, "completed");
  assert.ok((await readFriendWork(f.home, "friend", work.work.id)).result);
});

test("LA1 cancel during assembly is durable and avoids invoking the model", async t => {
  const f = await setup(t);
  const work = await startFriendWork(f.work("initial")); await drainLongAgentTurns(f.home, "friend", work.work.sessionId);
  const entered = deferred(), release = deferred();
  const held = withChatSessionOperationLock(chatSessionOperationKey("friend", work.work.sessionId), async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const turn = await acceptLongAgentTurn({ ...f.input("cancel-before-model", "a"), sessionId: work.work.sessionId });
  const run = drainLongAgentTurns(f.home, "friend", work.work.sessionId);
  for (let i = 0; i < 100; i++) {
    if ((await readLongAgentState(f.home)).turns.find(t => t.turnId === turn.turnId).status === "running") break;
    await new Promise(r => setTimeout(r, 10));
  }
  await cancelFriendWork(f.home, "friend", work.work.id, turn.turnId);
  release.resolve(); await held; await run;
  assert.equal((await readFriendWork(f.home, "friend", work.work.id)).execution.status, "cancelled");
  assert.equal(f.requests.length, 4);
});

test("LA1 restart classifies unknown work as interrupted and never replays tools", async t => {
  const f = await setup(t);
  const work = await startFriendWork(f.work("restart")); await drainLongAgentTurns(f.home, "friend", work.work.sessionId);
  const turn = await acceptLongAgentTurn({ ...f.input("unknown-after-crash", "a"), sessionId: work.work.sessionId });
  const { updateTurnStatus } = await import("../../src/long-agents/turn-queue.ts");
  await updateTurnStatus(f.home, turn.turnId, "running");
  const { execFileSync } = await import("node:child_process");
  const recovery = new URL("../../src/long-agents/daily-maintenance.ts", import.meta.url).href;
  execFileSync(process.execPath, ["--import", "./scripts/typescript-test-loader.mjs", "--experimental-strip-types", "--input-type=module", "-e",
    `const {recoverLongAgentTurns}=await import(${JSON.stringify(recovery)});await recoverLongAgentTurns(${JSON.stringify(f.home)});`], { stdio: "pipe" });
  const result = await readFriendWork(f.home, "friend", work.work.id);
  assert.equal(result.execution.status, "interrupted");
  await drainLongAgentTurns(f.home, "friend", work.work.sessionId);
  assert.equal(f.requests.length, 4);
  await deliverFriendWorkReturns(f.home);
});

test("LA1 native edits serialize read-modify-write across independent Friend Sessions", async t => {
  const f = await setup(t);
  const { scopedFileTools } = await import("../../src/agents/scoped-file-tools.ts");
  const fs = await import("node:fs/promises"); const path = `${f.root}/a/shared.txt`;
  await fs.writeFile(path, "alpha\nbeta\n");
  const tools = scopedFileTools({ cwd: `${f.root}/a`, ownWorkspace: `${f.root}/a`, frozenFiles: new Map(), resourceRoots: [] });
  const edit = tools.find(tool => tool.name === "edit");
  await Promise.all([
    edit.execute("one", { path, edits: [{ oldText: "alpha", newText: "ALPHA" }] }),
    edit.execute("two", { path, edits: [{ oldText: "beta", newText: "BETA" }] }),
  ]);
  assert.equal(await fs.readFile(path, "utf8"), "ALPHA\nBETA\n");
});

test("LA1 concurrent admission caps active background Sessions without blocking direct chat", { timeout: 15000 }, async t => {
  const f = await setup(t); const release = deferred();
  f.setHandler(async body => {
    if (JSON.stringify(body.messages).includes("BACKGROUND")) await release.promise;
    return { content: "done" };
  });
  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => startFriendWork(f.work(`capacity-${i}`))));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 4);
  assert.equal(results.filter(r => r.status === "rejected").length, 2);
  const main = await executeLongAgentTurn({ ...f.input("capacity-main", "b"), sessionId: f.origin.sessionId });
  assert.equal(main.text, "done");
  release.resolve(); await drainLongAgentTurns(f.home, "friend");
});

test("LA1 a new failed attempt never presents the previous attempt's answer as its result", async t => {
  const f = await setup(t); const work = await startFriendWork(f.work("old-result")); await drainLongAgentTurns(f.home, "friend");
  const turn = await acceptLongAgentTurn({ ...f.input("not-executed", "a"), sessionId: work.work.sessionId });
  const { updateTurnStatus } = await import("../../src/long-agents/turn-queue.ts");
  await updateTurnStatus(f.home, turn.turnId, "interrupted", "unknown");
  assert.equal((await readFriendWork(f.home, "friend", work.work.id)).result, null);
});

test("LA1 the registered Friend tool starts the same identity and refuses an ordinary Workflow identity", async t => {
  const f = await setup(t);
  const { FRIEND_WORK_TOOL_PROVIDER } = await import("../../src/tools/builtins/friend-work/index.ts");
  const parent = await openChatSession({ chatHome: f.home, projectId: "friend", sessionId: f.origin.sessionId });
  const context = { purpose: "execution", projectId: "friend", collaborationProjectId: "a", chatHome: f.home,
    cwd: parent.cwd, sessionManager: parent.manager, sessionId: f.origin.sessionId, agentId: "friend", longAgentId: "friend", longAgentTurnId: "trusted-parent-turn" };
  const tool = FRIEND_WORK_TOOL_PROVIDER.create(context);
  const input = { operation: "start", title: "工具委派", text: "BACKGROUND" };
  const result = await tool.execute("call-1", input);
  assert.equal(result.details.work.longAgentId, "friend");
  assert.equal(result.details.work.contextProjectId, "a");
  await drainLongAgentTurns(f.home, "friend");
  const again = await tool.execute("call-1", input);
  assert.equal(again.details.work.id, result.details.work.id);
  assert.equal(f.requests.length, 4);
  const ordinary = FRIEND_WORK_TOOL_PROVIDER.create({ ...context, longAgentId: undefined });
  await assert.rejects(ordinary.execute("spoof", input), /当前Friend/);
  const read = await tool.execute("read", { operation: "get", workId: result.details.work.id });
  assert.equal(read.details.result.text, "ack");
});

test("LA1 queued work resumes in a new Backend process with the originally accepted project rules", { timeout: 15000 }, async t => {
  const f = await setup(t); const work = await startFriendWork(f.work("resume")); await drainLongAgentTurns(f.home, "friend");
  await acceptLongAgentTurn({ ...f.input("resume-frozen", "a"), sessionId: work.work.sessionId });
  const fs = await import("node:fs/promises"); await fs.writeFile(`${f.root}/a/AGENTS.md`, "CHANGED_RULE_MUST_NOT_APPEAR");
  const { execFile } = await import("node:child_process"); const { promisify } = await import("node:util");
  const queue = new URL("../../src/long-agents/turn-queue.ts", import.meta.url).href;
  await promisify(execFile)(process.execPath, ["--import", "./scripts/typescript-test-loader.mjs", "--experimental-strip-types", "--input-type=module", "-e",
    `const {drainLongAgentTurns}=await import(${JSON.stringify(queue)});await drainLongAgentTurns(${JSON.stringify(f.home)},"friend");`]);
  assert.equal((await readFriendWork(f.home, "friend", work.work.id)).execution.status, "completed");
  assert.equal(f.requests.length, 6);
  // The last request belongs to the memory writer; the WORK request is the one before it.
  assert.match(JSON.stringify(f.requests.at(-2)), /RULE_a/);
  assert.doesNotMatch(JSON.stringify(f.requests.at(-2)), /CHANGED_RULE_MUST_NOT_APPEAR/);
});

test("LA1 cancelling the main conversation leaves detached work running", { timeout: 15000 }, async t => {
  const f = await setup(t); const workArrived = deferred(), mainArrived = deferred(), release = deferred();
  f.setHandler(async body => {
    if (JSON.stringify(body.messages).includes("BACKGROUND")) workArrived.resolve(); else mainArrived.resolve();
    await release.promise; return { content: "background done" };
  });
  const work = await startFriendWork(f.work("detached")); await workArrived.promise;
  const main = await acceptLongAgentTurn({ ...f.input("cancel-main", "a"), sessionId: f.origin.sessionId });
  const running = drainLongAgentTurns(f.home, "friend", f.origin.sessionId); await mainArrived.promise;
  const { cancelFriendTurn } = await import("../../src/long-agents/turn-controls.ts");
  await cancelFriendTurn(f.home, "friend", main.turnId); await running;
  assert.equal((await readFriendWork(f.home, "friend", work.work.id)).execution.status, "running");
  release.resolve(); await drainLongAgentTurns(f.home, "friend", work.work.sessionId);
  assert.equal((await readFriendWork(f.home, "friend", work.work.id)).execution.status, "completed");
});

test("LA1 removing the origin never resurrects its file and does not hide the work result", async t => {
  const f = await setup(t); const work = await startFriendWork(f.work("origin-removed")); await drainLongAgentTurns(f.home, "friend");
  await deliverFriendWorkReturns(f.home);
  const parent = await openChatSession({ chatHome: f.home, projectId: "friend", sessionId: f.origin.sessionId });
  const writer = createWorkflowCallWriter(parent.manager, "friend"); writer.release();
  const fs = await import("node:fs/promises"); await fs.unlink(parent.manager.getSessionFile());
  await deliverFriendWorkReturns(f.home);
  await assert.rejects(writer.write(current => current.appendCustomEntry("test", {})), { code: "ENOENT" });
  await assert.rejects(fs.stat(parent.manager.getSessionFile()), { code: "ENOENT" });
  assert.equal((await readFriendWork(f.home, "friend", work.work.id)).result.text, "ack");
});
