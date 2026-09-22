import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture } from "./daily-fixture.mjs";
import { manageFriendTask, acceptTaskTrigger, dispatchTaskOccurrences } from "../../src/long-agents/tasks/service.ts";
import { readTaskState } from "../../src/long-agents/tasks/storage.ts";
import { readLongAgentState } from "../../src/long-agents/storage.ts";
import { drainLongAgentTurns } from "../../src/long-agents/turn-queue.ts";
import { listFriendArtifacts, reconcileFriendArtifacts, resubmitArtifact, reviseArtifact, submitArtifact, notifyArtifact } from "../../src/long-agents/artifacts/service.ts";
import { artifactFile, changeArtifactState, readArtifactState } from "../../src/long-agents/artifacts/storage.ts";
import { listLongAgentFeed, publishLongAgentPost, findPostByArtifactKey } from "../../src/long-agents/social.ts";
import { resolveProjectContext } from "../../src/projects/registry.ts";
import { parseTaskInput } from "../../src/long-agents/tasks/contract.ts";

const definition = (over = {}) => ({
  name: "夜间笔记", prompt: "NOTE_TASK", contextProjectId: null, timeZone: "Asia/Shanghai",
  schedule: { kind: "cron", expression: "0 22 * * *" }, missed: "skip", overlap: "queue-one",
  deliverable: { kind: "note", slot: "night-note" }, ...over,
});
async function setup(t) {
  const f = await fixture(t); const projections = new Map(); let offline = false;
  const original = globalThis.fetch; const token = process.env.CHAT_CHANNEL_GATEWAY_TOKEN;
  process.env.CHAT_CHANNEL_GATEWAY_TOKEN = "test-artifact-projection-token-32-characters";
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
  const command = (body) => manageFriendTask(f.home, "friend", { schemaVersion: 2, ...body });
  return { ...f, command };
}
async function runOnce(f, task) {
  const state = await readTaskState(f.home, "friend");
  const current = state.tasks.find((candidate) => candidate.id === task.id);
  await f.command({ operation: "run", taskId: task.id, expectedRevision: current.revision, requestId: `run-${Math.random()}` });
  await dispatchTaskOccurrences(f.home, "friend");
  const work = (await readLongAgentState(f.home)).works.at(-1);
  await drainLongAgentTurns(f.home, "friend", work.sessionId);
  const turn = (await readLongAgentState(f.home)).turns.find((candidate) => candidate.workId === work.id);
  return { work, turn };
}
async function createTask(f, over = {}, requestId = `t-${Math.random()}`) {
  return (await f.command({ operation: "create", requestId, definition: definition(over) })).tasks.at(-1);
}

test("LA4 a note artifact writes immutable versions and never replaces the workspace file", async t => {
  const f = await setup(t);
  const task = await createTask(f, { deliverable: { kind: "note", slot: "night-note" } });
  const { turn } = await runOnce(f, task);
  const workspace = (await resolveProjectContext("friend", f.home)).projectRoot;
  const first = await submitArtifact(f.home, "friend", { kind: "note", path: "notes/night/2026-09-20.md", content: "第一版笔记内容", turnId: turn.turnId });
  assert.equal(first.state, "committed");
  assert.equal(first.slot, "night-note");
  assert.equal(first.taskId, task.id);
  assert.ok(first.occurrenceId && first.workId === turn.workId);
  const file = path.join(workspace, "notes/night/2026-09-20.md");
  // The artifact is verified through its immutable version file; the workspace copy is created once.
  assert.equal(fs.readFileSync(file, "utf8"), "第一版笔记内容");
  assert.notEqual(first.resourceId, fs.realpathSync(file));
  assert.match(first.resourceId, /\/\.chat-notes\/.*\/versions\/r1-[a-f0-9]{8}\.md$/);
  assert.equal(fs.readFileSync(first.resourceId, "utf8"), "第一版笔记内容");
  assert.equal(first.revisions.length, 1);
  assert.equal(first.revisions[0].origin, "generated");
  assert.equal(first.revisions[0].versionFile, first.resourceId);
  assert.equal(first.note.workspacePath, "notes/night/2026-09-20.md");
  assert.equal(first.note.workspaceState, "clean");
  assert.equal(first.note.conflict, null);
  const pointer = JSON.parse(fs.readFileSync(first.note.pointerFile, "utf8"));
  assert.equal(pointer.artifactId, first.id);
  assert.equal(pointer.revision, 1);
  assert.equal(pointer.versionFile, first.resourceId);
  assert.equal(pointer.workspaceState, "clean");
  // Same occurrence, same content: idempotent, no second version file.
  const again = await submitArtifact(f.home, "friend", { kind: "note", path: "notes/night/2026-09-20.md", content: "第一版笔记内容", turnId: turn.turnId });
  assert.equal(again.id, first.id);
  assert.equal(again.revision, 1);
  // Same occurrence, different content: conflict instead of silent overwrite.
  await assert.rejects(
    submitArtifact(f.home, "friend", { kind: "note", path: "notes/night/2026-09-20.md", content: "被替换的内容", turnId: turn.turnId }),
    /内容已变化/,
  );
  // An explicit revision adds an immutable version; the earlier version and the workspace file stay put.
  const revised = await reviseArtifact(f.home, "friend", { artifactId: first.id, content: "第二版笔记内容" });
  assert.equal(revised.revision, 2);
  assert.equal(revised.state, "committed");
  assert.equal(revised.revisions.length, 2);
  assert.notEqual(revised.resourceId, first.resourceId);
  assert.equal(fs.readFileSync(revised.resourceId, "utf8"), "第二版笔记内容");
  assert.equal(fs.readFileSync(first.resourceId, "utf8"), "第一版笔记内容", "旧版本文件保持不变");
  assert.equal(fs.readFileSync(file, "utf8"), "第一版笔记内容", "工作区文件不被服务端覆盖");
  assert.equal(revised.note.workspaceState, "older");
  assert.equal(JSON.parse(fs.readFileSync(revised.note.pointerFile, "utf8")).versionFile, revised.resourceId);
  const versions = fs.readdirSync(path.dirname(revised.resourceId)).filter((name) => name.endsWith(".md"));
  assert.equal(versions.length, 2, "每个版本各有自己的不可变文件");
  const listed = await listFriendArtifacts(f.home, "friend", {});
  assert.equal(listed.artifacts.length, 1);
  assert.equal(listed.pending, 0);
});
test("LA4 posts keep one artifact per occurrence and separate slots", async t => {
  const f = await setup(t);
  const morning = await createTask(f, { name: "morning", deliverable: { kind: "post", slot: "morning", audience: "friends" } }, "m");
  const noon = await createTask(f, { name: "noon", deliverable: { kind: "post", slot: "noon", audience: "self" } }, "n");
  const runMorning = await runOnce(f, morning);
  const first = await submitArtifact(f.home, "friend", { kind: "post", content: "早上好，今天推进第三章", turnId: runMorning.turn.turnId });
  assert.equal(first.state, "committed");
  assert.equal(first.target.kind, "social");
  assert.equal(first.target.audience, "friends");
  assert.ok(first.resourceId?.startsWith("post-"));
  const again = await submitArtifact(f.home, "friend", { kind: "post", content: "早上好，今天推进第三章", turnId: runMorning.turn.turnId });
  assert.equal(again.id, first.id);
  assert.equal((await listLongAgentFeed({ chatHome: f.home, viewerLongAgentId: "friend" })).length, 1);
  const runNoon = await runOnce(f, noon);
  const second = await submitArtifact(f.home, "friend", { kind: "post", content: "中午的记录", turnId: runNoon.turn.turnId });
  assert.notEqual(second.id, first.id);
  assert.equal(second.slot, "noon");
  assert.equal(second.target.audience, "self");
  // A self post stays out of another friend's feed.
  assert.equal((await listLongAgentFeed({ chatHome: f.home, viewerLongAgentId: "friend" })).length, 2);
  assert.equal((await listLongAgentFeed({ chatHome: f.home, viewerLongAgentId: "other" })).length, 1);
});

test("LA4 a crashed commit is recovered by identity without a second side effect", async t => {
  const f = await setup(t);
  const task = await createTask(f, { deliverable: { kind: "post", slot: "evening" } }, "evening");
  const { turn } = await runOnce(f, task);
  const artifact = await submitArtifact(f.home, "friend", { kind: "post", content: "晚上的收束", turnId: turn.turnId });
  assert.equal(artifact.state, "committed");
  // Simulate "side effect happened, receipt lost": reset the record to pending but keep the post.
  await changeArtifactState(f.home, "friend", (store) => {
    const current = store.artifacts.find((candidate) => candidate.id === artifact.id);
    current.state = "pending";
    current.resourceId = null;
    current.attempts = 0;
  });
  assert.equal((await listFriendArtifacts(f.home, "friend", {})).pending, 1);
  await reconcileFriendArtifacts(f.home, "friend");
  const recovered = (await listFriendArtifacts(f.home, "friend", {})).artifacts[0];
  assert.equal(recovered.state, "committed");
  assert.equal(recovered.resourceId, artifact.resourceId);
  assert.equal((await listLongAgentFeed({ chatHome: f.home, viewerLongAgentId: "friend" })).length, 1);
  // Recovery attempts are bounded and honest: one commit attempt for the backfill.
  assert.equal((await readArtifactState(f.home, "friend")).artifacts[0].attempts, 1);
});

test("LA4 a failing side effect is bounded, reported and never regenerates content", async t => {
  const f = await setup(t);
  const task = await createTask(f, { deliverable: { kind: "post", slot: "broken" } }, "broken");
  const { turn } = await runOnce(f, task);
  // Publishing fails while the social store is unwritable.
  fs.rmSync(path.join(f.home, "social"), { recursive: true, force: true });
  fs.writeFileSync(path.join(f.home, "social"), "not-a-directory");
  const artifact = await submitArtifact(f.home, "friend", { kind: "post", content: "冻结的内容", turnId: turn.turnId });
  assert.equal(artifact.state, "failed");
  assert.equal(artifact.content, "冻结的内容");
  assert.ok(artifact.failure && artifact.failure.length > 0);
  const worksBefore = (await readLongAgentState(f.home)).works.length;
  for (let i = 0; i < 6; i++) await reconcileFriendArtifacts(f.home, "friend");
  const after = (await readArtifactState(f.home, "friend")).artifacts[0];
  assert.equal(after.state, "failed");
  assert.ok(after.attempts <= 6, `attempts must stay bounded, got ${after.attempts}`);
  assert.equal(after.retryable, true);
  // Recovery never re-runs the model: no new work or turn appears.
  assert.equal((await readLongAgentState(f.home)).works.length, worksBefore);
  assert.equal((await listFriendArtifacts(f.home, "friend", {})).pending, 1);
  // Once the store is writable again, the frozen content commits without any model call.
  fs.rmSync(path.join(f.home, "social"), { force: true });
  const recovered = await resubmitArtifact(f.home, "friend", after.id);
  assert.equal(recovered.state, "committed");
  assert.equal(recovered.content, "冻结的内容");
  assert.equal((await listLongAgentFeed({ chatHome: f.home, viewerLongAgentId: "friend" })).length, 1);
});

test("LA4 artifact submission validates task configuration, path scope and work context", async t => {
  const f = await setup(t);
  const plain = await createTask(f, { name: "plain", deliverable: undefined, prompt: "PLAIN" }, "plain");
  const plainRun = await runOnce(f, plain);
  await assert.rejects(submitArtifact(f.home, "friend", { kind: "note", path: "a.md", content: "x", turnId: plainRun.turn.turnId }), /未配置为产物任务/);
  const noteTask = await createTask(f, { name: "note", deliverable: { kind: "note", slot: "night-note" } }, "note");
  const { turn } = await runOnce(f, noteTask);
  await assert.rejects(submitArtifact(f.home, "friend", { kind: "post", content: "x", turnId: turn.turnId }), /配置的是 note 产物/);
  await assert.rejects(submitArtifact(f.home, "friend", { kind: "note", path: "../escape.md", content: "x", turnId: turn.turnId }), /相对路径/);
  await assert.rejects(submitArtifact(f.home, "friend", { kind: "note", path: "/tmp/escape.md", content: "x", turnId: turn.turnId }), /相对路径/);
  await assert.rejects(submitArtifact(f.home, "friend", { kind: "note", path: "ok.md", content: "", turnId: turn.turnId }), /内容为空/);
  await assert.rejects(submitArtifact(f.home, "friend", { kind: "note", path: "ok.md", content: "x", turnId: "chat-web:friend:main" }), /找不到该执行上下文/);
  // Configuration validation happens at the task boundary.
  assert.throws(() => parseTaskInput({ ...definition(), deliverable: { kind: "post", slot: "Morning" } }), /槽位/);
  assert.throws(() => parseTaskInput({ ...definition(), deliverable: { kind: "note", slot: "n", audience: "friends" } }), /受众/);
  assert.throws(() => parseTaskInput({ ...definition(), deliverable: { kind: "post", slot: "m", audience: "world" } }), /受众/);
});

test("LA4 artifacts stay isolated per friend and notices are deduplicated", async t => {
  const f = await setup(t);
  const task = await createTask(f, { deliverable: { kind: "post", slot: "morning" } }, "iso");
  const { turn } = await runOnce(f, task);
  const artifact = await submitArtifact(f.home, "friend", { kind: "post", content: "隔离测试", turnId: turn.turnId });
  assert.equal(fs.existsSync(artifactFile(f.home, "friend")), true);
  assert.equal(fs.existsSync(artifactFile(f.home, "other")), false);
  await assert.rejects(listFriendArtifacts(f.home, "other", {}), /找不到Friend/);
  assert.deepEqual(await notifyArtifact(f.home, "friend", artifact.id), { notified: true });
  assert.deepEqual(await notifyArtifact(f.home, "friend", artifact.id), { notified: false });
});

test("LA4 legacy posts without artifact metadata stay readable and unlinked", async t => {
  const f = await setup(t);
  const legacy = await publishLongAgentPost({ chatHome: f.home, longAgentId: "friend", text: "旧动态", date: "2026-09-19" });
  assert.equal(legacy.audience, "friends");
  assert.equal(await findPostByArtifactKey({ chatHome: f.home, artifactKey: "a".repeat(48) }), null);
  const feed = await listLongAgentFeed({ chatHome: f.home, viewerLongAgentId: "other" });
  assert.equal(feed.length, 1);
  assert.equal(feed[0].artifactKey, undefined);
});
