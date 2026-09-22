import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { fixture } from "./daily-fixture.mjs";
import { manageFriendTask, dispatchTaskOccurrences } from "../../src/long-agents/tasks/service.ts";
import { readTaskState } from "../../src/long-agents/tasks/storage.ts";
import { readLongAgentState } from "../../src/long-agents/storage.ts";
import { drainLongAgentTurns } from "../../src/long-agents/turn-queue.ts";
import { exportArtifactVersion, listFriendArtifacts, reconcileFriendArtifacts, resubmitArtifact, resolveNoteConflict, reviseArtifact, submitArtifact } from "../../src/long-agents/artifacts/service.ts";
import { changeArtifactState, readArtifactState } from "../../src/long-agents/artifacts/storage.ts";
import { commentOnLongAgentPost, listLongAgentFeed, publishLongAgentPost, findPostByArtifactKey } from "../../src/long-agents/social.ts";
import { resolveProjectContext } from "../../src/projects/registry.ts";
import { contentRevision } from "../../src/persistence/versioned-file.ts";
import { versionFileName } from "../../src/long-agents/artifacts/note-store.ts";
import { SOCIAL_MANAGE_TOOL_PROVIDER } from "../../src/tools/builtins/social-manage/index.ts";

const definition = (over = {}) => ({
  name: "夜间笔记", prompt: "NOTE_TASK", contextProjectId: null, timeZone: "Asia/Shanghai",
  schedule: { kind: "cron", expression: "0 22 * * *" }, missed: "skip", overlap: "queue-one",
  deliverable: { kind: "note", slot: "night-note" }, ...over,
});
async function setup(t) {
  const f = await fixture(t); const projections = new Map();
  const original = globalThis.fetch; const token = process.env.CHAT_CHANNEL_GATEWAY_TOKEN;
  process.env.CHAT_CHANNEL_GATEWAY_TOKEN = "test-artifact-projection-token-32-characters";
  t.after(() => { if (token === undefined) delete process.env.CHAT_CHANNEL_GATEWAY_TOKEN; else process.env.CHAT_CHANNEL_GATEWAY_TOKEN = token; });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (!String(url).includes("/v1/task-projections")) return original(url, init);
    const body = JSON.parse(init.body);
    if (body.operation === "claim") return Response.json({ schemaVersion: 1, timeZone: "Asia/Shanghai", tasks: [] });
    if (body.operation === "preview") return Response.json({ schemaVersion: 1, nextAt: null });
    if (body.operation === "apply") { const p = body.projection; projections.set(p.taskId, { taskId: p.taskId, rev: p.revision, nextAt: null }); return Response.json({ schemaVersion: 1, taskId: p.taskId, revision: p.revision, nextAt: null }); }
    return Response.json({ schemaVersion: 1, projections: [...projections.values()] });
  });
  const command = (body) => manageFriendTask(f.home, "friend", { schemaVersion: 2, ...body });
  return { ...f, command };
}
async function runOnce(f, task) {
  const current = (await readTaskState(f.home, "friend")).tasks.find((candidate) => candidate.id === task.id);
  await f.command({ operation: "run", taskId: task.id, expectedRevision: current.revision, requestId: `run-${Math.random()}` });
  await dispatchTaskOccurrences(f.home, "friend");
  const work = (await readLongAgentState(f.home)).works.at(-1);
  await drainLongAgentTurns(f.home, "friend", work.sessionId);
  return { work, turn: (await readLongAgentState(f.home)).turns.find((candidate) => candidate.workId === work.id) };
}
async function createTask(f, over = {}, requestId = `t-${Math.random()}`) {
  return (await f.command({ operation: "create", requestId, definition: definition(over) })).tasks.at(-1);
}

test("LA4-R1 a self post rejects comments from another Friend without leaking its body", async t => {
  const f = await setup(t);
  const post = await publishLongAgentPost({ chatHome: f.home, longAgentId: "friend", text: "private secret", audience: "self" });
  await assert.rejects(commentOnLongAgentPost({ chatHome: f.home, longAgentId: "other", postId: post.id, text: "hello" }), /找不到动态/);
  const visible = await commentOnLongAgentPost({ chatHome: f.home, longAgentId: "friend", postId: post.id, text: "自己的评论" });
  assert.equal(visible.comments.length, 1);
  assert.equal((await listLongAgentFeed({ chatHome: f.home, viewerLongAgentId: "other" })).length, 0);
});

test("LA4-R2 a symlinked parent directory cannot write outside the workspace", async t => {
  const f = await setup(t);
  const task = await createTask(f);
  const { turn } = await runOnce(f, task);
  const root = (await resolveProjectContext("friend", f.home)).projectRoot;
  const outside = path.join(f.root, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, "escape"));
  const artifact = await submitArtifact(f.home, "friend", { kind: "note", path: "escape/proof.md", content: "unauthorized", turnId: turn.turnId });
  assert.equal(artifact.state, "failed");
  assert.equal(artifact.retryable, false);
  assert.equal(fs.existsSync(path.join(outside, "proof.md")), false);
  // Retrying must not create the file either.
  await assert.rejects(resubmitArtifact(f.home, "friend", artifact.id), /越出授权工作区/);
  assert.equal(fs.existsSync(path.join(outside, "proof.md")), false);
});

test("LA4-R3 a lost old receipt cannot overwrite a regenerated note", async t => {
  const f = await setup(t);
  const task = await createTask(f);
  const first = await runOnce(f, task);
  const old = await submitArtifact(f.home, "friend", { kind: "note", path: "notes/night.md", content: "old", turnId: first.turn.turnId });
  await changeArtifactState(f.home, "friend", (store) => { const a = store.artifacts.find((x) => x.id === old.id); a.state = "pending"; a.resourceId = null; });
  const second = await runOnce(f, task);
  const fresh = await submitArtifact(f.home, "friend", { kind: "note", path: "notes/night.md", content: "new", turnId: second.turn.turnId });
  assert.notEqual(old.id, fresh.id);
  assert.equal(fresh.state, "committed");
  assert.equal(fs.readFileSync(fresh.resourceId, "utf8"), "new");
  await reconcileFriendArtifacts(f.home, "friend");
  assert.equal(fs.readFileSync(fresh.resourceId, "utf8"), "new");
  const blocked = (await readArtifactState(f.home, "friend")).artifacts.find((x) => x.id === old.id);
  assert.equal(blocked.state, "failed");
  assert.equal(blocked.retryable, false);
  assert.match(blocked.failure, /更新的产物版本/);
});

test("LA4-R3b a manual edit of the note file is preserved as its own version, never overwritten", async t => {
  const f = await setup(t);
  const task = await createTask(f);
  const { turn } = await runOnce(f, task);
  const root = (await resolveProjectContext("friend", f.home)).projectRoot;
  const file = path.join(root, "notes/manual.md");
  const artifact = await submitArtifact(f.home, "friend", { kind: "note", path: "notes/manual.md", content: "frozen", turnId: turn.turnId });
  assert.equal(fs.readFileSync(file, "utf8"), "frozen");
  fs.writeFileSync(file, "人工修改后的内容");
  await reconcileFriendArtifacts(f.home, "friend");
  assert.equal(fs.readFileSync(file, "utf8"), "人工修改后的内容", "the user file is never overwritten");
  const refreshed = (await readArtifactState(f.home, "friend")).artifacts.find((x) => x.id === artifact.id);
  assert.equal(refreshed.state, "committed");
  assert.equal(refreshed.note.workspaceState, "edited");
  assert.equal(refreshed.note.conflict.source, "workspace");
  assert.equal(refreshed.note.conflict.content, "人工修改后的内容");
  assert.equal(fs.readFileSync(refreshed.note.conflict.preservedFile, "utf8"), "人工修改后的内容");
  assert.equal(fs.readFileSync(refreshed.resourceId, "utf8"), "frozen", "the generated version survives");
  // Adopting the edit makes it the current version without rewriting any file.
  const adopted = await resolveNoteConflict(f.home, "friend", { artifactId: artifact.id, choice: "user" });
  assert.equal(adopted.revision, 2);
  assert.equal(adopted.content, "人工修改后的内容");
  assert.equal(adopted.revisions[1].origin, "user");
  assert.equal(adopted.note.workspaceState, "clean");
  assert.equal(adopted.note.conflict, null);
  assert.equal(fs.readFileSync(file, "utf8"), "人工修改后的内容");
  assert.equal(fs.readFileSync(adopted.resourceId, "utf8"), "人工修改后的内容");
});

test("LA4-R3c keeping the generated version records the decision and still preserves the edit", async t => {
  const f = await setup(t);
  const task = await createTask(f);
  const { turn } = await runOnce(f, task);
  const root = (await resolveProjectContext("friend", f.home)).projectRoot;
  const file = path.join(root, "notes/kept.md");
  const artifact = await submitArtifact(f.home, "friend", { kind: "note", path: "notes/kept.md", content: "generated", turnId: turn.turnId });
  fs.writeFileSync(file, "my own words");
  await reconcileFriendArtifacts(f.home, "friend");
  const kept = await resolveNoteConflict(f.home, "friend", { artifactId: artifact.id, choice: "generated" });
  assert.equal(kept.revision, 1);
  assert.equal(kept.content, "generated");
  assert.equal(kept.note.conflictResolution, "generated");
  assert.equal(fs.readFileSync(file, "utf8"), "my own words", "the user file still holds the preserved edit");
  assert.equal(fs.readFileSync(kept.note.conflict.preservedFile, "utf8"), "my own words");
});
test("LA4-R4 post content length is rejected before freezing, and the body is verified on publish", async t => {
  const f = await setup(t);
  const task = await createTask(f, { deliverable: { kind: "post", slot: "morning" } });
  const { turn } = await runOnce(f, task);
  await assert.rejects(
    submitArtifact(f.home, "friend", { kind: "post", content: "x".repeat(4001), turnId: turn.turnId }),
    /4000 字符上限/,
  );
  const artifact = await submitArtifact(f.home, "friend", { kind: "post", content: "y".repeat(4000), turnId: turn.turnId });
  assert.equal(artifact.state, "committed");
  const post = await findPostByArtifactKey({ chatHome: f.home, artifactKey: artifact.artifactKey });
  assert.equal(post.text.length, artifact.content.length);
  assert.equal(post.text, artifact.content);
});

test("LA4-R5 concurrent same-key publication and resubmit stay unique", async t => {
  const f = await setup(t);
  await Promise.all(Array.from({ length: 20 }, () => publishLongAgentPost({ chatHome: f.home, longAgentId: "friend", text: "same", artifactKey: "a".repeat(48) })));
  assert.equal((await listLongAgentFeed({ chatHome: f.home, viewerLongAgentId: "friend" })).length, 1);
  const task = await createTask(f, { deliverable: { kind: "post", slot: "morning" } });
  const { turn } = await runOnce(f, task);
  fs.rmSync(path.join(f.home, "social"), { recursive: true, force: true });
  fs.writeFileSync(path.join(f.home, "social"), "blocked");
  const artifact = await submitArtifact(f.home, "friend", { kind: "post", content: "same", turnId: turn.turnId });
  assert.equal(artifact.state, "failed");
  assert.equal(artifact.retryable, true);
  fs.rmSync(path.join(f.home, "social"));
  await Promise.all(Array.from({ length: 20 }, () => resubmitArtifact(f.home, "friend", artifact.id)));
  assert.equal((await listLongAgentFeed({ chatHome: f.home, viewerLongAgentId: "friend" })).length, 1);
});

test("LA4-R6 overlapping retries cannot publish twice even if both read before the first append", async t => {
  const f = await setup(t);
  const task = await createTask(f, { deliverable: { kind: "post", slot: "morning" } });
  const { turn } = await runOnce(f, task);
  fs.rmSync(path.join(f.home, "social"), { recursive: true, force: true });
  fs.writeFileSync(path.join(f.home, "social"), "blocked");
  const artifact = await submitArtifact(f.home, "friend", { kind: "post", content: "same", turnId: turn.turnId });
  fs.rmSync(path.join(f.home, "social"));
  const original = fsp.readFile; let arrivals = 0; let release; const gate = new Promise((resolve) => { release = resolve; });
  const timer = setTimeout(release, 2000);
  t.mock.method(fsp, "readFile", async (...args) => {
    if (String(args[0]) === path.join(f.home, "social/posts.jsonl") && arrivals < 2) {
      let value, error; try { value = await original(...args); } catch (e) { error = e; }
      arrivals += 1; if (arrivals === 2) release(); await gate; if (error) throw error; return value;
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { clearTimeout(timer); t.mock.restoreAll(); syncBuiltinESMExports(); });
  await Promise.all([resubmitArtifact(f.home, "friend", artifact.id), resubmitArtifact(f.home, "friend", artifact.id)]);
  assert.equal(arrivals, 2);
  assert.equal((await listLongAgentFeed({ chatHome: f.home, viewerLongAgentId: "friend" })).length, 1);
});

test("LA4-R7 an owner reads its own self post through the real social tool", async t => {
  const f = await setup(t);
  const post = await publishLongAgentPost({ chatHome: f.home, longAgentId: "friend", text: "private", audience: "self" });
  const tool = SOCIAL_MANAGE_TOOL_PROVIDER.create({ purpose: "execution", chatHome: f.home, longAgentId: "friend" });
  const result = await tool.execute("read", { operation: "read" });
  assert.ok(result.details.posts.some((candidate) => candidate.id === post.id));
});

test("LA4-R8 a tighted audience is not bypassed by a late frozen publish", async t => {
  const f = await setup(t);
  const task = await createTask(f, { deliverable: { kind: "post", slot: "morning", audience: "friends" } });
  const { turn } = await runOnce(f, task);
  fs.rmSync(path.join(f.home, "social"), { recursive: true, force: true });
  fs.writeFileSync(path.join(f.home, "social"), "blocked");
  const artifact = await submitArtifact(f.home, "friend", { kind: "post", content: "now private", turnId: turn.turnId });
  assert.equal(artifact.state, "failed");
  const current = (await readTaskState(f.home, "friend")).tasks.find((candidate) => candidate.id === task.id);
  await f.command({ operation: "update", taskId: task.id, expectedRevision: current.revision, definition: definition({ deliverable: { kind: "post", slot: "morning", audience: "self" } }) });
  fs.rmSync(path.join(f.home, "social"));
  await reconcileFriendArtifacts(f.home, "friend");
  assert.equal((await listLongAgentFeed({ chatHome: f.home, viewerLongAgentId: "other" })).length, 0);
  const after = (await readArtifactState(f.home, "friend")).artifacts[0];
  assert.equal(after.state, "failed");
  assert.equal(after.retryable, false);
  assert.match(after.failure, /受众已/);
  // The artifact record and its frozen content are kept as history.
  assert.equal(after.content, "now private");
  assert.equal((await listFriendArtifacts(f.home, "friend", {})).artifacts.length, 1);
});

test("LA4-R9 two tasks writing the same note path: only the newest owner may write", async t => {
  const f = await setup(t);
  const first = await createTask(f, { name: "task-a", deliverable: { kind: "note", slot: "slot-a" } }, "r9-a");
  const second = await createTask(f, { name: "task-b", deliverable: { kind: "note", slot: "slot-b" } }, "r9-b");
  const runA = await runOnce(f, first);
  const owner = await submitArtifact(f.home, "friend", { kind: "note", path: "notes/shared.md", content: "A 的版本", turnId: runA.turn.turnId });
  const runB = await runOnce(f, second);
  const newer = await submitArtifact(f.home, "friend", { kind: "note", path: "notes/shared.md", content: "B 的版本", turnId: runB.turn.turnId });
  assert.equal(newer.state, "committed");
  assert.equal(fs.readFileSync(newer.resourceId, "utf8"), "B 的版本");
  // The older record's recovery must not clobber the newer owner.
  await changeArtifactState(f.home, "friend", (store) => { const a = store.artifacts.find((x) => x.id === owner.id); a.state = "pending"; a.resourceId = null; });
  await reconcileFriendArtifacts(f.home, "friend");
  assert.equal(fs.readFileSync(newer.resourceId, "utf8"), "B 的版本");
  const blocked = (await readArtifactState(f.home, "friend")).artifacts.find((x) => x.id === owner.id);
  assert.equal(blocked.state, "failed");
  assert.equal(blocked.retryable, false);
  assert.match(blocked.failure, /更新的产物版本/);
});

test("LA4-R10 a cancelled task blocks the late publish and keeps the record", async t => {
  const f = await setup(t);
  const task = await createTask(f, { deliverable: { kind: "post", slot: "cancelled-slot" } });
  const { turn } = await runOnce(f, task);
  fs.rmSync(path.join(f.home, "social"), { recursive: true, force: true });
  fs.writeFileSync(path.join(f.home, "social"), "blocked");
  const artifact = await submitArtifact(f.home, "friend", { kind: "post", content: "取消前的内容", turnId: turn.turnId });
  assert.equal(artifact.state, "failed");
  const current = (await readTaskState(f.home, "friend")).tasks.find((candidate) => candidate.id === task.id);
  await f.command({ operation: "cancel", taskId: task.id, expectedRevision: current.revision });
  fs.rmSync(path.join(f.home, "social"));
  await reconcileFriendArtifacts(f.home, "friend");
  const after = (await readArtifactState(f.home, "friend")).artifacts[0];
  assert.equal(after.state, "failed");
  assert.equal(after.retryable, false);
  assert.match(after.failure, /任务已取消/);
  assert.equal(after.content, "取消前的内容");
  assert.equal((await listLongAgentFeed({ chatHome: f.home, viewerLongAgentId: "friend" })).length, 0);
});

/** Pause the first `fsp[method]` call whose target (args[1], or args[0] for readFile) matches. */
function holdFs(t, method, match) {
  const original = fsp[method];
  let entered; let release;
  const ready = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let held = false;
  const index = method === "readFile" ? 0 : 1;
  const matches = (args) => (typeof match === "function" ? match(String(args[index]), args) : String(args[index]) === match);
  t.mock.method(fsp, method, async (...args) => {
    if (matches(args) && !held) { held = true; entered(); await gate; }
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { release(); t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { ready, release };
}

test("LA4-R11 managed writes to one path are serialized and never replace the workspace file", async t => {
  const f = await setup(t);
  const task = await createTask(f);
  const root = (await resolveProjectContext("friend", f.home)).projectRoot;
  const file = path.join(root, "notes/shared.md");
  const first = await runOnce(f, task);
  const older = await submitArtifact(f.home, "friend", { kind: "note", path: "notes/shared.md", content: "v1", turnId: first.turn.turnId });
  assert.equal(older.state, "committed");
  assert.equal(fs.readFileSync(file, "utf8"), "v1");
  const second = await runOnce(f, task);
  const secondHash = createHash("sha256").update("v2").digest("hex");
  const gate = holdFs(t, "link", (target) => target.endsWith(versionFileName(1, secondHash)));
  let secondDone = false;
  const fresh = submitArtifact(f.home, "friend", { kind: "note", path: "notes/shared.md", content: "v2", turnId: second.turn.turnId })
    .then((artifact) => { secondDone = true; return artifact; });
  await gate.ready;
  const third = await runOnce(f, task);
  let thirdDone = false;
  const newest = submitArtifact(f.home, "friend", { kind: "note", path: "notes/shared.md", content: "v3", turnId: third.turn.turnId })
    .then((artifact) => { thirdDone = true; return artifact; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(secondDone, false, "the in-flight write holds the path");
  assert.equal(thirdDone, false, "later writers queue behind the in-flight write");
  gate.release();
  const [secondArtifact, thirdArtifact] = await Promise.all([fresh, newest]);
  assert.equal(secondArtifact.state, "committed");
  assert.equal(thirdArtifact.state, "committed");
  assert.equal(fs.readFileSync(file, "utf8"), "v1", "the workspace file keeps the first materialization");
  assert.equal(fs.readFileSync(thirdArtifact.resourceId, "utf8"), "v3");
  const final = (await readArtifactState(f.home, "friend")).artifacts.find((x) => x.id === thirdArtifact.id);
  assert.equal(final.note.workspaceState, "older");
  const pointer = JSON.parse(fs.readFileSync(final.note.pointerFile, "utf8"));
  assert.equal(pointer.versionFile, thirdArtifact.resourceId, "the pointer pins the newest version");
  const versions = fs.readdirSync(path.dirname(thirdArtifact.resourceId)).filter((name) => name.endsWith(".md"));
  assert.equal(versions.length, 3, "every version kept its own immutable file");
});
test("LA4-R12 an external file that appears during the first write is preserved, not clobbered", async t => {
  const f = await setup(t);
  const task = await createTask(f);
  const { turn } = await runOnce(f, task);
  const root = (await resolveProjectContext("friend", f.home)).projectRoot;
  const file = path.join(root, "notes/appeared.md");
  const artifact = await submitArtifact(f.home, "friend", { kind: "note", path: "notes/appeared.md", content: "generated", turnId: turn.turnId });
  assert.equal(fs.readFileSync(file, "utf8"), "generated");
  // The user deletes the file; while the commit re-materializes it, an external write lands first.
  fs.rmSync(file);
  await changeArtifactState(f.home, "friend", (store) => {
    const a = store.artifacts.find((x) => x.id === artifact.id);
    a.state = "pending"; a.resourceId = null; a.retryable = true;
  });
  const gate = holdFs(t, "link", file);
  const pending = reconcileFriendArtifacts(f.home, "friend");
  await gate.ready;
  fs.writeFileSync(file, "manual edit");
  gate.release();
  await pending;
  assert.equal(fs.readFileSync(file, "utf8"), "manual edit", "a file created meanwhile is never overwritten");
  const final = (await readArtifactState(f.home, "friend")).artifacts.find((x) => x.id === artifact.id);
  assert.equal(final.state, "committed");
  assert.equal(final.note.workspaceState, "edited");
  assert.equal(final.note.conflict.content, "manual edit");
  assert.equal(fs.readFileSync(final.note.conflict.preservedFile, "utf8"), "manual edit");
  assert.equal(fs.readFileSync(final.resourceId, "utf8"), "generated");
});
test("LA4-R13 a stale recovery verification cannot commit a newer revision", async t => {
  const f = await setup(t);
  const task = await createTask(f);
  const { turn } = await runOnce(f, task);
  const artifact = await submitArtifact(f.home, "friend", { kind: "note", path: "notes/revised.md", content: "v1", turnId: turn.turnId });
  const file = artifact.resourceId;
  await changeArtifactState(f.home, "friend", (store) => { const a = store.artifacts.find((x) => x.id === artifact.id); a.state = "pending"; a.resourceId = null; });
  const gate = holdFs(t, "readFile", file);
  const maintenance = reconcileFriendArtifacts(f.home, "friend");
  await gate.ready;
  // A newer revision lands while the recovery is still verifying v1.
  await changeArtifactState(f.home, "friend", (store) => {
    const a = store.artifacts.find((x) => x.id === artifact.id);
    a.revision += 1; a.contentHash = contentRevision("v2"); a.content = "v2"; a.state = "pending";
    a.retryable = true; a.updatedAt = new Date().toISOString();
  });
  gate.release();
  await maintenance;
  const final = (await readArtifactState(f.home, "friend")).artifacts.find((x) => x.id === artifact.id);
  assert.equal(final.revision, 2);
  assert.equal(final.content, "v2");
  assert.notEqual(final.state, "committed", "a verification of v1 must not complete revision 2");
  assert.equal(fs.readFileSync(file, "utf8"), "v1");
});

test("LA4-R14 recovery with an existing post key but a different body is never committed", async t => {
  const f = await setup(t);
  const task = await createTask(f, { deliverable: { kind: "post", slot: "morning" } });
  const { turn } = await runOnce(f, task);
  const artifact = await submitArtifact(f.home, "friend", { kind: "post", content: "complete frozen body", turnId: turn.turnId });
  const file = path.join(f.home, "social/posts.jsonl");
  const post = JSON.parse(fs.readFileSync(file, "utf8").trim());
  post.text = "truncated";
  fs.writeFileSync(file, JSON.stringify(post) + "\n");
  await changeArtifactState(f.home, "friend", (store) => { const a = store.artifacts[0]; a.state = "pending"; a.resourceId = null; });
  await reconcileFriendArtifacts(f.home, "friend");
  const final = (await readArtifactState(f.home, "friend")).artifacts[0];
  assert.notEqual(final.state, "committed");
  assert.equal(final.retryable, false);
  assert.match(final.failure, /正文与冻结内容不一致/);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8").trim()).text, "truncated", "the divergent post must not be rewritten");
});

test("LA4-R15 a second writer for the same artifact waits for the in-flight write and then completes", async t => {
  const f = await setup(t);
  const task = await createTask(f);
  const { turn } = await runOnce(f, task);
  const root = (await resolveProjectContext("friend", f.home)).projectRoot;
  const file = path.join(root, "notes/queued.md");
  const artifact = await submitArtifact(f.home, "friend", { kind: "note", path: "notes/queued.md", content: "queued content", turnId: turn.turnId });
  await changeArtifactState(f.home, "friend", (store) => {
    const a = store.artifacts.find((x) => x.id === artifact.id);
    a.state = "pending"; a.resourceId = null; a.retryable = true;
  });
  const gate = holdFs(t, "link", artifact.resourceId);
  const first = reconcileFriendArtifacts(f.home, "friend");
  await gate.ready;
  let secondDone = false;
  const second = resubmitArtifact(f.home, "friend", artifact.id).then((result) => { secondDone = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(secondDone, false, "the same artifact is serialized on one commit lock");
  gate.release();
  await first;
  const final = await second;
  assert.equal(final.state, "committed");
  assert.equal(fs.readFileSync(artifact.resourceId, "utf8"), "queued content");
  assert.equal(fs.readFileSync(file, "utf8"), "queued content");
});
test("LA4-R16 a hand-edited version file is preserved and re-materialized at a new immutable path", async t => {
  const f = await setup(t);
  const task = await createTask(f);
  const { turn } = await runOnce(f, task);
  const artifact = await submitArtifact(f.home, "friend", { kind: "note", path: "notes/versioned.md", content: "v1", turnId: turn.turnId });
  fs.writeFileSync(artifact.resourceId, "伪造的版本内容");
  await reconcileFriendArtifacts(f.home, "friend");
  const refreshed = (await readArtifactState(f.home, "friend")).artifacts.find((x) => x.id === artifact.id);
  assert.notEqual(refreshed.note.versionFile, artifact.resourceId, "our content moves to a new immutable path");
  assert.equal(fs.readFileSync(refreshed.note.versionFile, "utf8"), "v1");
  assert.equal(fs.readFileSync(artifact.resourceId, "utf8"), "伪造的版本内容", "the external edit is not overwritten");
  assert.equal(refreshed.note.conflict.source, "version-file");
  assert.equal(refreshed.note.conflict.content, "伪造的版本内容");
  assert.equal(fs.readFileSync(refreshed.note.conflict.preservedFile, "utf8"), "伪造的版本内容");
  const pointer = JSON.parse(fs.readFileSync(refreshed.note.pointerFile, "utf8"));
  assert.equal(pointer.versionFile, refreshed.note.versionFile, "the pointer follows the re-created version");
  const versions = fs.readdirSync(path.dirname(artifact.resourceId)).filter((name) => name.endsWith(".md"));
  assert.equal(versions.length, 2, "the original file is kept next to the re-created one");
  const userFiles = fs.readdirSync(path.dirname(refreshed.note.conflict.preservedFile)).filter((name) => name.endsWith(".md"));
  assert.equal(userFiles.length, 1);
});

test("LA4-R17 exporting the current version always writes a new file", async t => {
  const f = await setup(t);
  const task = await createTask(f);
  const { turn } = await runOnce(f, task);
  const artifact = await submitArtifact(f.home, "friend", { kind: "note", path: "notes/export.md", content: "export content", turnId: turn.turnId });
  const first = await exportArtifactVersion(f.home, "friend", { artifactId: artifact.id });
  assert.ok(first.path.endsWith(".v1.md"));
  assert.equal(fs.readFileSync(first.path, "utf8"), "export content");
  // Idempotent while the target is untouched...
  const repeat = await exportArtifactVersion(f.home, "friend", { artifactId: artifact.id });
  assert.equal(repeat.path, first.path);
  // ...and never a replacement once the user (or anything else) changed that file.
  fs.writeFileSync(first.path, "user tweak");
  const second = await exportArtifactVersion(f.home, "friend", { artifactId: artifact.id });
  assert.notEqual(second.path, first.path, "an existing file is never replaced");
  assert.equal(fs.readFileSync(first.path, "utf8"), "user tweak");
  assert.equal(fs.readFileSync(second.path, "utf8"), "export content");
});

test("LA4-R18 a deleted or tampered pointer is rebuilt from the record", async t => {
  const f = await setup(t);
  const task = await createTask(f);
  const { turn } = await runOnce(f, task);
  const artifact = await submitArtifact(f.home, "friend", { kind: "note", path: "notes/pointer.md", content: "pointer content", turnId: turn.turnId });
  const pointerFile = artifact.note.pointerFile;
  fs.rmSync(pointerFile);
  await reconcileFriendArtifacts(f.home, "friend");
  const rebuilt = JSON.parse(fs.readFileSync(pointerFile, "utf8"));
  assert.equal(rebuilt.versionFile, artifact.resourceId);
  assert.equal(rebuilt.revision, 1);
  fs.writeFileSync(pointerFile, "{ not json");
  await reconcileFriendArtifacts(f.home, "friend");
  const repaired = JSON.parse(fs.readFileSync(pointerFile, "utf8"));
  assert.equal(repaired.versionFile, artifact.resourceId);
  assert.equal(fs.readFileSync(repaired.versionFile, "utf8"), "pointer content");
});

test("LA4-R19 a symlinked note store directory is refused before anything is created", async t => {
  const f = await setup(t);
  const task = await createTask(f);
  const { turn } = await runOnce(f, task);
  const root = (await resolveProjectContext("friend", f.home)).projectRoot;
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  const outside = path.join(f.root, "outside-store");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, "notes/.chat-notes"));
  const artifact = await submitArtifact(f.home, "friend", { kind: "note", path: "notes/test.md", content: "generated", turnId: turn.turnId });
  assert.equal(artifact.state, "failed");
  assert.equal(artifact.retryable, false);
  assert.match(artifact.failure, /越出授权工作区|符号链接/);
  await assert.rejects(resubmitArtifact(f.home, "friend", artifact.id), /越出授权工作区/);
  assert.deepEqual(fs.readdirSync(outside), [], "nothing may be created outside the authorized root");
  assert.equal(fs.existsSync(path.join(root, "notes/test.md")), false, "the note file is not created either");
});

test("LA4-R20 a stale refresh cannot revert the current pointer after a revision", async t => {
  const f = await setup(t);
  const task = await createTask(f);
  const { turn } = await runOnce(f, task);
  const artifact = await submitArtifact(f.home, "friend", { kind: "note", path: "notes/refresh.md", content: "v1", turnId: turn.turnId });
  const gate = holdFs(t, "readFile", artifact.note.versionFile);
  const refresh = reconcileFriendArtifacts(f.home, "friend");
  await gate.ready;
  const newer = await reviseArtifact(f.home, "friend", { artifactId: artifact.id, content: "v2" });
  assert.equal(newer.state, "committed");
  gate.release();
  await refresh;
  const current = (await readArtifactState(f.home, "friend")).artifacts.find((x) => x.id === artifact.id);
  assert.equal(current.content, "v2");
  assert.equal(current.revision, 2);
  assert.equal(fs.readFileSync(current.note.versionFile, "utf8"), "v2", "the stale refresh must not move the version file back");
  assert.equal(JSON.parse(fs.readFileSync(current.note.pointerFile, "utf8")).revision, current.revision);
  assert.equal(JSON.parse(fs.readFileSync(current.note.pointerFile, "utf8")).versionFile, current.resourceId);
});

test("LA4-R21 resolving a conflict that changed since it was read is refused", async t => {
  const f = await setup(t);
  const task = await createTask(f);
  const { turn } = await runOnce(f, task);
  const root = (await resolveProjectContext("friend", f.home)).projectRoot;
  const file = path.join(root, "notes/redecide.md");
  const artifact = await submitArtifact(f.home, "friend", { kind: "note", path: "notes/redecide.md", content: "generated", turnId: turn.turnId });
  fs.writeFileSync(file, "edit one");
  await reconcileFriendArtifacts(f.home, "friend");
  await resolveNoteConflict(f.home, "friend", { artifactId: artifact.id, choice: "generated" });
  // A second, different edit must not inherit the earlier decision.
  fs.writeFileSync(file, "edit two");
  await reconcileFriendArtifacts(f.home, "friend");
  const conflicted = (await readArtifactState(f.home, "friend")).artifacts.find((x) => x.id === artifact.id);
  assert.equal(conflicted.note.conflict.content, "edit two");
  assert.equal(conflicted.note.conflictResolution, null, "the decision belongs to one conflict only");
  assert.equal(fs.readFileSync(file, "utf8"), "edit two");
  // Both sides stay recoverable and the new conflict can be resolved again.
  assert.equal(fs.readFileSync(conflicted.note.conflict.preservedFile, "utf8"), "edit two");
  assert.equal(fs.readFileSync(conflicted.resourceId, "utf8"), "generated");
  const kept = await resolveNoteConflict(f.home, "friend", { artifactId: artifact.id, choice: "user" });
  assert.equal(kept.content, "edit two");
  assert.equal(kept.revisions.at(-1).origin, "user");
  await assert.rejects(
    resolveNoteConflict(f.home, "friend", { artifactId: artifact.id, choice: "generated" }),
    /没有需要处理的冲突/,
  );
});

test("LA4-R22 exporting through a symlinked directory is refused", async t => {
  const f = await setup(t);
  const task = await createTask(f);
  const { turn } = await runOnce(f, task);
  const root = (await resolveProjectContext("friend", f.home)).projectRoot;
  const artifact = await submitArtifact(f.home, "friend", { kind: "note", path: "notes/export-guard.md", content: "content", turnId: turn.turnId });
  const outside = path.join(f.root, "outside-export");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, "notes/out"));
  await assert.rejects(
    exportArtifactVersion(f.home, "friend", { artifactId: artifact.id, path: "notes/out/leak.md" }),
    /越出授权工作区|符号链接/,
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});
