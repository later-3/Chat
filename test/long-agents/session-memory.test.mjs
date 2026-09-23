import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fixture } from "./daily-fixture.mjs";
import { readLongAgentRegistry, writeLongAgentRegistry } from "../../src/long-agents/storage.ts";
import { executeLongAgentTurn } from "../../src/long-agents/runtime.ts";
import {
  markSessionMemoryOrphan,
  purgeSessionMemory,
  readSessionMemory,
  readSessionMemoryHistory,
  resolveSessionMemoryTarget,
  sessionMemoryFile,
  writeSessionMemoryEntry,
} from "../../src/long-agents/session-memory.ts";
import { purgeRemovedChatSession, removeChatSession, restoreRemovedChatSession } from "../../src/session-removal.ts";

const SESSION = "sess-session-memory-1";

test("P1 session memory: purpose-typed, append-only entries with revision CAS", async (t) => {
  const f = await fixture(t);
  const turn = await executeLongAgentTurn(f.input("smem-base"));
  const SESSION = turn.sessionId;
  let revision = 0;
  const write = async (input) => {
    const state = await writeSessionMemoryEntry({ chatHome: f.home, longAgentId: "friend", sessionId: SESSION, expectedRevision: revision, ...input });
    revision = state.revision;
    return state;
  };
  const first = await write({ operation: "write", purpose: "background", author: "agent", content: "服务跑在 JDK17" });
  assert.equal(first.revision, 1);
  assert.equal(first.entries.length, 1);
  assert.equal(fs.existsSync(sessionMemoryFile(f.home, "friend", SESSION)), true);

  // Append-only (review 18): the same content again is a NEW entry with a fresh identity —
  // content-addressed ids would collide with history and break supersede chains (A → B → A).
  const duplicate = await write({ operation: "write", purpose: "background", author: "agent", content: "服务跑在 JDK17" });
  assert.equal(duplicate.revision, 2);
  assert.equal(duplicate.entries.length, 2);
  assert.notEqual(duplicate.entries[1].entryId, duplicate.entries[0].entryId);

  // A stale revision is a conflict; validation errors fire against the CURRENT revision.
  await assert.rejects(
    writeSessionMemoryEntry({ chatHome: f.home, longAgentId: "friend", sessionId: SESSION, operation: "write", purpose: "finding", author: "agent", content: "其它", expectedRevision: 0 }),
    /revision/,
  );
  await assert.rejects(write({ operation: "write", purpose: "gossip", author: "agent", content: "x" }), /purpose/);
  await assert.rejects(write({ operation: "write", purpose: "finding", author: "model", content: "x" }), /author/);
  await assert.rejects(
    write({ operation: "write", purpose: "background", author: "agent", content: "x", supersedes: first.entries[0].entryId }),
    /write 不接受 supersedes/,
  );

  // Overturning is append-only: the old entry stays as history, the new one points at it.
  const before = duplicate.entries[0].entryId;
  const superseded = await write({ operation: "supersede", purpose: "background", author: "user", content: "服务实际跑在 JDK21", supersedes: before });
  assert.equal(superseded.revision, 3);
  assert.equal(superseded.entries.find((entry) => entry.entryId === before).status, "superseded");
  const replacement = superseded.entries.find((entry) => entry.supersedes === before);
  assert.equal(replacement.status, "active");
  assert.equal(replacement.author, "user");
  // Overturning the same entry twice is refused (it is already superseded).
  await assert.rejects(
    write({ operation: "supersede", purpose: "background", author: "user", content: "again", supersedes: before }),
    /已被推翻/,
  );
  // A fresh write on the current revision still succeeds and appends.
  const appended = await write({ operation: "write", purpose: "finding", author: "agent", content: "根因是 configLoader 返回 null" });
  assert.equal(appended.revision, 4);
  assert.equal(appended.entries.length, 4);

});

test("P1 session memory: the target only resolves for agent-home sessions", async (t) => {
  const f = await fixture(t);
  const turn = await executeLongAgentTurn(f.input("smem-target"));
  const target = await resolveSessionMemoryTarget({ chatHome: f.home, projectId: "friend", sessionId: turn.sessionId, longAgentId: "friend" });
  assert.equal(target.longAgentId, "friend");
  assert.equal(target.sessionId, turn.sessionId);
  // An ordinary project session must not gain agent-home memory access through the fallback.
  await assert.rejects(
    resolveSessionMemoryTarget({ chatHome: f.home, projectId: "a", sessionId: turn.sessionId, longAgentId: "friend" }),
    /不属于 Long Agent/,
  );
  // A trusted binding is honoured even when the caller's own project differs.
  const bound = await resolveSessionMemoryTarget({ chatHome: f.home, projectId: "a", sessionId: "other", longAgentId: "friend", binding: { storageProjectId: "friend", sessionId: turn.sessionId } });
  assert.equal(bound.sessionId, turn.sessionId);
  // A binding that cannot be verified is refused rather than trusted.
  await assert.rejects(
    resolveSessionMemoryTarget({ chatHome: f.home, projectId: "a", sessionId: turn.sessionId, binding: { storageProjectId: "a", sessionId: turn.sessionId } }),
    /只支持 Long Agent/,
  );
});

test("P1 session memory: removal marks orphan, purge deletes the file", async (t) => {
  const f = await fixture(t);
  const turn = await executeLongAgentTurn(f.input("smem-lifecycle"));
  await writeSessionMemoryEntry({ chatHome: f.home, longAgentId: "friend", sessionId: turn.sessionId, operation: "write", purpose: "finding", author: "user", content: "根因是配置加载返回 null", expectedRevision: 0 });
  await removeChatSession("friend", turn.sessionId, f.home);
  const orphaned = await readSessionMemory(f.home, "friend", turn.sessionId);
  assert.equal(orphaned.orphan, true, "a removed session keeps its memory for traceability");
  assert.equal(orphaned.entries.length, 1);
  await assert.rejects(
    writeSessionMemoryEntry({ chatHome: f.home, longAgentId: "friend", sessionId: turn.sessionId, operation: "write", purpose: "finding", author: "agent", content: "later", expectedRevision: 1 }),
    /已移除/,
  );
  await purgeRemovedChatSession("friend", turn.sessionId, f.home);
  assert.equal(fs.existsSync(sessionMemoryFile(f.home, "friend", turn.sessionId)), false, "purge deletes the memory file");
  // Direct helpers stay honest for the recovery paths.
  await markSessionMemoryOrphan(f.home, "friend", "missing-session");
  await purgeSessionMemory(f.home, "friend", "missing-session");
});

test("P1 session memory: the agent tool writes to the calling agent-home session through real assembly", async (t) => {
  const f = await fixture(t);
  const registry = await readLongAgentRegistry(f.home);
  await writeLongAgentRegistry({ ...registry, agents: registry.agents.map((agent) => ({
    ...agent,
    definition: { ...agent.definition, tools: { mode: "explicit", names: [], exclude: [], addresses: ["system:tool/session_memory"] } },
  })) }, f.home);
  f.setHandler((body) => body.messages.at(-1).role === "tool"
    ? { content: "已记录" }
    : { tool_calls: [{ index: 0, id: "remember-1", type: "function", function: { name: "session_memory", arguments: JSON.stringify({ operation: "write", purpose: "finding", author: "agent", content: "根因是 configLoader 返回 null 未判空", expectedRevision: 0 }) } }] });
  const state = await executeLongAgentTurn(f.input("smem-tool"));
  const memory = await readSessionMemory(f.home, "friend", state.sessionId);
  assert.equal(memory.entries.length, 1, "the tool wrote exactly one entry");
  assert.equal(memory.entries[0].content, "根因是 configLoader 返回 null 未判空");
  assert.equal(memory.entries[0].author, "agent");
  // The tool is bound to the session that actually ran the turn (not an arbitrary one).
  assert.equal(memory.sessionId, state.sessionId);
  assert.equal(fs.existsSync(sessionMemoryFile(f.home, "friend", state.sessionId)), true);
});

test("P1 review 18: A → B → A keeps three unique entries and never shortcuts a supersede", async (t) => {
  const f = await fixture(t);
  const turn = await executeLongAgentTurn(f.input("smem-review-18"));
  const SESSION = turn.sessionId;
  let revision = 0;
  const write = async (input) => {
    const state = await writeSessionMemoryEntry({ chatHome: f.home, longAgentId: "friend", sessionId: SESSION, expectedRevision: revision, ...input });
    revision = state.revision;
    return state;
  };
  const a1 = await write({ operation: "write", purpose: "finding", author: "agent", content: "结论 X" });
  const b1 = await write({ operation: "supersede", purpose: "finding", author: "agent", content: "结论 Y", supersedes: a1.entries.at(-1).entryId });
  const a2 = await write({ operation: "supersede", purpose: "finding", author: "agent", content: "结论 X", supersedes: b1.entries.at(-1).entryId });
  const ids = a2.entries.map((entry) => entry.entryId);
  assert.equal(new Set(ids).size, 3, "three writes must produce three distinct entry ids");
  assert.equal(a2.entries.find((entry) => entry.entryId === a1.entries[0].entryId).status, "superseded");
  assert.equal(a2.entries.find((entry) => entry.entryId === b1.entries[0].entryId).status, "superseded");
  assert.equal(a2.entries.find((entry) => entry.supersedes === b1.entries.at(-1).entryId).status, "active");
  // A later write with A-like content creates a NEW entry and must not touch the older ones
  // (no content-addressed shortcut): B stays exactly as the chain left it.
  const extra = await write({ operation: "write", purpose: "finding", author: "agent", content: "结论 Y" });
  assert.equal(extra.entries.length, 4);
  assert.equal(extra.entries.at(-1).status, "active");
  // Every earlier entry keeps the status the chain gave it — nothing is retroactively touched.
  assert.equal(extra.entries.find((entry) => entry.entryId === a1.entries[0].entryId).status, "superseded");
  assert.equal(extra.entries.find((entry) => entry.entryId === b1.entries[0].entryId).status, "superseded");
  assert.equal(extra.entries.find((entry) => entry.entryId === a2.entries.at(-1).entryId).status, "active");
});

test("P1 review 19: a purge failure stays retriable instead of reporting success", async (t) => {
  const f = await fixture(t);
  const turn = await executeLongAgentTurn(f.input("smem-review-19"));
  await writeSessionMemoryEntry({ chatHome: f.home, longAgentId: "friend", sessionId: turn.sessionId, operation: "write", purpose: "background", author: "agent", content: "背景事实", expectedRevision: 0 });
  const memoryPath = sessionMemoryFile(f.home, "friend", turn.sessionId);
  await removeChatSession("friend", turn.sessionId, f.home);
  // Break the memory path: purge must fail loudly (not report success) and stay retriable.
  fs.rmSync(memoryPath); fs.mkdirSync(memoryPath);
  await assert.rejects(purgeRemovedChatSession("friend", turn.sessionId, f.home), undefined);
  assert.equal(fs.existsSync(memoryPath), true, "the broken memory path is preserved for retry");
  // Repair and retry: purge completes and deletes the memory file.
  fs.rmdirSync(memoryPath);
  await purgeRemovedChatSession("friend", turn.sessionId, f.home);
  assert.equal(fs.existsSync(memoryPath), false);
  // A late write after purge cannot recreate the file (active-session re-verification inside the lock).
  await assert.rejects(
    writeSessionMemoryEntry({ chatHome: f.home, longAgentId: "friend", sessionId: turn.sessionId, operation: "write", purpose: "finding", author: "agent", content: "late", expectedRevision: 2 }),
    /已移除或不存在/,
  );
  assert.equal(fs.existsSync(memoryPath), false, "no memory file may be recreated after purge");
});

test("P1 review 20: restoring a removed session clears the orphan marker and re-enables writes", async (t) => {
  const f = await fixture(t);
  const turn = await executeLongAgentTurn(f.input("smem-review-20"));
  await writeSessionMemoryEntry({ chatHome: f.home, longAgentId: "friend", sessionId: turn.sessionId, operation: "write", purpose: "finding", author: "agent", content: "根因是空指针", expectedRevision: 0 });
  await removeChatSession("friend", turn.sessionId, f.home);
  assert.equal((await readSessionMemory(f.home, "friend", turn.sessionId)).orphan, true);
  await assert.rejects(
    writeSessionMemoryEntry({ chatHome: f.home, longAgentId: "friend", sessionId: turn.sessionId, operation: "write", purpose: "rule", author: "user", content: "被拒绝", expectedRevision: 1 }),
    /已移除/,
  );
  await restoreRemovedChatSession("friend", turn.sessionId, f.home);
  const afterRestore = await readSessionMemory(f.home, "friend", turn.sessionId);
  assert.equal(afterRestore.orphan, false, "restore clears the orphan marker");
  const afterWrite = await writeSessionMemoryEntry({ chatHome: f.home, longAgentId: "friend", sessionId: turn.sessionId, operation: "write", purpose: "rule", author: "user", content: "恢复后可以继续写", expectedRevision: afterRestore.revision });
  assert.equal(afterWrite.orphan, false);
  assert.equal(afterWrite.entries.at(-1).content, "恢复后可以继续写");
});

test("P1 review 24: the automatic expiry purge retries when the memory deletion fails", async (t) => {
  const f = await fixture(t);
  const turn = await executeLongAgentTurn(f.input("smem-review-24"));
  await writeSessionMemoryEntry({ chatHome: f.home, longAgentId: "friend", sessionId: turn.sessionId, operation: "write", purpose: "finding", author: "agent", content: "会被自动过期清理", expectedRevision: 0 });
  const memoryPath = sessionMemoryFile(f.home, "friend", turn.sessionId);
  await removeChatSession("friend", turn.sessionId, f.home);
  // Break the memory path: the automatic expiry pass (listRemovedChatSessions with a far-future clock)
  // must fail instead of tombstoning the record with the memory still present.
  fs.rmSync(memoryPath); fs.mkdirSync(memoryPath);
  const { listRemovedChatSessions } = await import("../../src/session-removal.ts");
  await assert.rejects(
    listRemovedChatSessions("friend", f.home, new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000)),
    undefined,
  );
  assert.equal(fs.existsSync(memoryPath), true, "the broken memory path is preserved for retry");
  // Repair: the next expiry scan completes the purge and deletes the memory file.
  fs.rmdirSync(memoryPath);
  await listRemovedChatSessions("friend", f.home, new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000));
  assert.equal(fs.existsSync(memoryPath), false);
  // After the purge, a late write cannot recreate the memory file.
  await assert.rejects(
    writeSessionMemoryEntry({ chatHome: f.home, longAgentId: "friend", sessionId: turn.sessionId, operation: "write", purpose: "finding", author: "agent", content: "late", expectedRevision: 1 }),
    /已移除或不存在/,
  );
  assert.equal(fs.existsSync(memoryPath), false);
});

test("P1 review 22: history reads string content, chat custom messages, and rejects bad cursors", async (t) => {
  const f = await fixture(t);
  const turn = await executeLongAgentTurn(f.input("smem-review-22"));
  const sessionId = turn.sessionId;
  const { openChatSession } = await import("../../src/chat-session.js");
  const session = await openChatSession({ chatHome: f.home, projectId: "friend", sessionId });
  // A native string user message (not block-shaped) must still be returned by history.
  session.manager.appendMessage({ role: "user", content: "原生字符串消息", text: undefined });
  session.manager.flush();
  // A chat.* custom message (the P2 integration summary shape) must be returned too.
  session.manager.appendCustomMessageEntry("chat.topic-integration-summary", "整合摘要：本主题的背景与目标", false, { topicId: "t1" });
  session.manager.flush();
  const history = await readSessionMemoryHistory({ chatHome: f.home, longAgentId: "friend", sessionId });
  const texts = history.entries.map((entry) => entry.text);
  assert.equal(texts.some((text) => text.includes("原生字符串消息")), true, "string content is returned");
  assert.equal(texts.some((text) => text.includes("整合摘要")), true, "chat.* custom messages are returned");
  // An unknown cursor must fail instead of silently restarting from the beginning.
  await assert.rejects(
    readSessionMemoryHistory({ chatHome: f.home, longAgentId: "friend", sessionId, afterEntryId: "does-not-exist" }),
    /游标无效/,
  );
  // A valid cursor continues after the referenced entry.
  const first = history.entries[0];
  const next = await readSessionMemoryHistory({ chatHome: f.home, longAgentId: "friend", sessionId, afterEntryId: first.entryId });
  assert.equal(next.entries[0]?.entryId === first.entryId, false, "a valid cursor continues after the entry");
});

test("P1 review 25: a restore failure stays retriable and the retry clears the orphan marker", async (t) => {
  const { resolveProjectContext } = await import("../../src/projects/registry.ts");
  const f = await fixture(t);
  const turn = await executeLongAgentTurn(f.input("smem-review-25"));
  await writeSessionMemoryEntry({ chatHome: f.home, longAgentId: "friend", sessionId: turn.sessionId, operation: "write", purpose: "background", author: "agent", content: "恢复前写一条", expectedRevision: 0 });
  const memoryPath = sessionMemoryFile(f.home, "friend", turn.sessionId);
  await removeChatSession("friend", turn.sessionId, f.home);
  // Break the memory path: the restore must fail loudly instead of restoring with a stale orphan.
  fs.rmSync(memoryPath); fs.mkdirSync(memoryPath);
  await assert.rejects(restoreRemovedChatSession("friend", turn.sessionId, f.home), undefined);
  assert.equal(fs.existsSync(memoryPath), true, "the broken memory path is preserved for retry");
  // Repair and retry: the interrupted restore is recovered (file back to active, orphan cleared).
  // The retried call itself reports that the removed-area record is gone — that is the expected
  // outcome of an already-recovered restore — but the two facts are consistent again.
  fs.rmdirSync(memoryPath);
  await restoreRemovedChatSession("friend", turn.sessionId, f.home).catch((error) => {
    assert.match(String(error), /移除区中找不到Session/, "a recovered restore reports it is no longer in the removed area");
  });
  const restored = await readSessionMemory(f.home, "friend", turn.sessionId);
  assert.equal(restored.orphan, false, "the recovered restore clears the orphan marker");
  const activeFiles = (await (await import("../../src/session-files.ts")).listActiveSessionFiles(await resolveProjectContext("friend", f.home))).some((candidate) => candidate.id === turn.sessionId);
  assert.equal(activeFiles, true, "the session file is back in the active directory");
  const afterWrite = await writeSessionMemoryEntry({ chatHome: f.home, longAgentId: "friend", sessionId: turn.sessionId, operation: "write", purpose: "rule", author: "user", content: "恢复后写入", expectedRevision: restored.revision });
  assert.equal(afterWrite.orphan, false);
});

test("P1 review 21 (route): invalid operations and field combinations are rejected with 400", async (t) => {
  const f = await fixture(t);
  // The route resolves the Chat Home itself; point it at the isolated fixture home.
  const previousHome = process.env.CHAT_HOME;
  process.env.CHAT_HOME = f.home;
  t.after(() => { if (previousHome === undefined) delete process.env.CHAT_HOME; else process.env.CHAT_HOME = previousHome; });
  const turn = await executeLongAgentTurn(f.input("smem-review-21"));
  const { createRouter } = await import("nitro/h3");
  const patchHandler = (await import("../../src/routes/api/long-agents/[longAgentId]/sessions/[sessionId]/memory.patch.ts")).default;
  const router = createRouter();
  router.patch("/api/long-agents/:longAgentId/sessions/:sessionId/memory", patchHandler);
  const patch = (body) => router.fetch(new Request(`http://chat.test/api/long-agents/friend/sessions/${turn.sessionId}/memory`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  })).then(async (response) => ({ status: response.status, body: await response.json() }));
  assert.equal((await patch({ operation: "delete", purpose: "finding", content: "x", expectedRevision: 0 })).status, 400);
  assert.equal((await patch({ operation: "supersed", purpose: "finding", content: "x", expectedRevision: 0 })).status, 400);
  assert.equal((await patch({ operation: "write", purpose: "finding", content: "x", supersedes: "e1", expectedRevision: 0 })).status, 400);
  assert.equal((await patch({ operation: "supersede", purpose: "finding", content: "x", expectedRevision: 0 })).status, 400);
  const gossip = await patch({ operation: "write", purpose: "gossip", content: "x", expectedRevision: 0 });
  assert.ok([400, 403].includes(gossip.status), `invalid purpose must not be accepted (got ${String(gossip.status)})`);
  assert.equal((await patch({ operation: "write", purpose: "finding", content: "合法条目", expectedRevision: 0 })).status, 200);
});

test("P1 review 28: an index-write failure during remove leaves a state the next touch converges", async (t) => {
  const f = await fixture(t);
  const turn = await executeLongAgentTurn(f.input("smem-review-28"));
  await writeSessionMemoryEntry({ chatHome: f.home, longAgentId: "friend", sessionId: turn.sessionId, operation: "write", purpose: "background", author: "agent", content: "背景事实", expectedRevision: 0 });
  const { removedSessionDirectory } = await import("../../src/session-files.ts");
  const { resolveProjectContext } = await import("../../src/projects/registry.ts");
  const project = await resolveProjectContext("friend", f.home);
  const removedDir = removedSessionDirectory(project);
  // Make the removed-session index unwritable: the remove's index write fails AFTER the memory change.
  fs.mkdirSync(removedDir, { recursive: true });
  fs.chmodSync(removedDir, 0o500);
  await assert.rejects(removeChatSession("friend", turn.sessionId, f.home), undefined);
  fs.chmodSync(removedDir, 0o700);
  // Intent-first ordering: the pending index write fails before any memory change or file move, so
  // there is no half-completed state — the session is untouched and the memory is not orphan.
  const activeStill = (await (await import("../../src/session-files.ts")).listActiveSessionFiles(project)).some((s) => s.id === turn.sessionId);
  assert.equal(activeStill, true, "the session file is still in the active directory");
  assert.equal((await readSessionMemory(f.home, "friend", turn.sessionId)).orphan, false, "no half state: the memory is not orphan while the session is active");
  // A retried remove completes and marks the memory orphan.
  const removed = await removeChatSession("friend", turn.sessionId, f.home);
  assert.equal(removed.id, turn.sessionId);
  assert.equal((await readSessionMemory(f.home, "friend", turn.sessionId)).orphan, true);
});

test("P1 review 28: an index-write failure during restore leaves a state the next touch converges", async (t) => {
  const f = await fixture(t);
  const turn = await executeLongAgentTurn(f.input("smem-review-28b"));
  await writeSessionMemoryEntry({ chatHome: f.home, longAgentId: "friend", sessionId: turn.sessionId, operation: "write", purpose: "background", author: "agent", content: "背景事实", expectedRevision: 0 });
  await removeChatSession("friend", turn.sessionId, f.home);
  const { removedSessionDirectory } = await import("../../src/session-files.ts");
  const { resolveProjectContext } = await import("../../src/projects/registry.ts");
  const project = await resolveProjectContext("friend", f.home);
  const removedDir = removedSessionDirectory(project);
  fs.chmodSync(removedDir, 0o500);
  await assert.rejects(restoreRemovedChatSession("friend", turn.sessionId, f.home), undefined);
  fs.chmodSync(removedDir, 0o700);
  // Intent-first ordering: the pending index write fails before the memory change, so the session
  // stays in the removed area AND the memory stays orphan — the two facts remain consistent.
  const { findInactiveChatSessionState } = await import("../../src/removed-session-index.ts");
  assert.equal(await findInactiveChatSessionState(project, turn.sessionId), "removed");
  assert.equal((await readSessionMemory(f.home, "friend", turn.sessionId)).orphan, true, "no half state: memory stays orphan while the session is removed");
  // A retried restore completes and clears the orphan marker.
  await restoreRemovedChatSession("friend", turn.sessionId, f.home);
  const after = await readSessionMemory(f.home, "friend", turn.sessionId);
  assert.equal(after.orphan, false);
  await writeSessionMemoryEntry({ chatHome: f.home, longAgentId: "friend", sessionId: turn.sessionId, operation: "write", purpose: "rule", author: "user", content: "恢复后写入", expectedRevision: after.revision });
});

test("P1 review 29: a purge with a failing index write keeps the session restorable and the memory intact", async (t) => {
  const f = await fixture(t);
  const turn = await executeLongAgentTurn(f.input("smem-review-29"));
  await writeSessionMemoryEntry({ chatHome: f.home, longAgentId: "friend", sessionId: turn.sessionId, operation: "write", purpose: "background", author: "agent", content: "purge 前的背景", expectedRevision: 0 });
  const { removedSessionDirectory } = await import("../../src/session-files.ts");
  const { resolveProjectContext } = await import("../../src/projects/registry.ts");
  const project = await resolveProjectContext("friend", f.home);
  const removedDir = removedSessionDirectory(project);
  await removeChatSession("friend", turn.sessionId, f.home);
  fs.mkdirSync(removedDir, { recursive: true });
  fs.chmodSync(removedDir, 0o500);
  await assert.rejects(purgeRemovedChatSession("friend", turn.sessionId, f.home), undefined);
  fs.chmodSync(removedDir, 0o700);
  assert.equal(fs.existsSync(sessionMemoryFile(f.home, "friend", turn.sessionId)), true, "memory is not dropped while the session is restorable");
  const restored = await restoreRemovedChatSession("friend", turn.sessionId, f.home);
  assert.equal(restored.state, "active");
  assert.equal((await readSessionMemory(f.home, "friend", turn.sessionId)).entries.length, 1, "restoring recovers the memory intact");
  // A later purge completes normally and deletes the memory.
  await removeChatSession("friend", turn.sessionId, f.home).catch(() => undefined);
  await purgeRemovedChatSession("friend", turn.sessionId, f.home).catch(() => undefined);
  assert.equal(fs.existsSync(sessionMemoryFile(f.home, "friend", turn.sessionId)), false);
});

test("P1 review 28: convergeSessionMemoryWithLifecycle heals a crash-before-compensation state", async (t) => {
  const f = await fixture(t);
  const turn = await executeLongAgentTurn(f.input("smem-review-28c"));
  await writeSessionMemoryEntry({ chatHome: f.home, longAgentId: "friend", sessionId: turn.sessionId, operation: "write", purpose: "finding", author: "agent", content: "待收敛", expectedRevision: 0 });
  const { convergeSessionMemoryWithLifecycle } = await import("../../src/long-agents/session-memory.ts");
  const { resolveProjectContext } = await import("../../src/projects/registry.ts");
  const project = await resolveProjectContext("friend", f.home);
  // Simulate a crash before compensation: the memory orphan flag is stale (false) while the state
  // requires true. Direct convergence heals it (this is what the lifecycle ops run at their start).
  await convergeSessionMemoryWithLifecycle(project, turn.sessionId, "active");
  const first = await readSessionMemory(f.home, "friend", turn.sessionId);
  // An active session converges to orphan:false; converge is a no-op here.
  assert.equal(first.orphan, false);
  const fixed = JSON.parse(fs.readFileSync(sessionMemoryFile(f.home, "friend", turn.sessionId), "utf8"));
  fixed.orphan = true; // simulate the stale flag of an interrupted removal
  fs.writeFileSync(sessionMemoryFile(f.home, "friend", turn.sessionId), JSON.stringify(fixed));
  await convergeSessionMemoryWithLifecycle(project, turn.sessionId, "active");
  assert.equal((await readSessionMemory(f.home, "friend", turn.sessionId)).orphan, false, "an active session heals back to orphan:false");
  // The removed lifecycle converges the other way and keeps the entries.
  await convergeSessionMemoryWithLifecycle(project, turn.sessionId, "removed");
  const removedState = await readSessionMemory(f.home, "friend", turn.sessionId);
  assert.equal(removedState.orphan, true);
  assert.equal(removedState.entries.length, 1, "convergence never drops entries");
  // The purged lifecycle deletes the file.
  await convergeSessionMemoryWithLifecycle(project, turn.sessionId, "purged");
  assert.equal(fs.existsSync(sessionMemoryFile(f.home, "friend", turn.sessionId)), false);
});

// --- Review 31/32: an interrupted lifecycle operation must be converged by ANY recovering read, and
// --- the pending intent must survive until the companion memory actually converges.

const readOnlyMemoryDir = (f) => `${f.home}/long-agents/friend/session-memory`;

test("P1 review 31: an interrupted remove is converged by a recovering read (list and state check)", async (t) => {
  const f = await fixture(t);
  const turn = await executeLongAgentTurn(f.input("smem-r31-remove"));
  await writeSessionMemoryEntry({ chatHome: f.home, longAgentId: "friend", sessionId: turn.sessionId, operation: "write", purpose: "finding", author: "agent", content: "保留的内容", expectedRevision: 0 });
  const { resolveProjectContext } = await import("../../src/projects/registry.ts");
  const { listRemovedChatSessions } = await import("../../src/session-removal.ts");
  const { readRemovedSessionIndexState } = await import("../../src/removed-session-index.ts");
  const project = await resolveProjectContext("friend", f.home);
  // Break only the memory write (read-only dir): the pending intent and the file move succeed.
  fs.chmodSync(readOnlyMemoryDir(f), 0o500);
  await assert.rejects(removeChatSession("friend", turn.sessionId, f.home), undefined);
  fs.chmodSync(readOnlyMemoryDir(f), 0o700);
  // Stale pair: the session is in the removed area, the memory is not orphan — but the pending intent
  // is preserved and the entries are intact.
  assert.equal((await readRemovedSessionIndexState(project)).pendingOperation !== undefined, true, "the pending intent survives a failed convergence");
  assert.equal((await readSessionMemory(f.home, "friend", turn.sessionId)).orphan, false);
  assert.equal((await readSessionMemory(f.home, "friend", turn.sessionId)).entries.length, 1, "the content is preserved");
  // A recovering read (list) converges both facts and clears the pending intent.
  await listRemovedChatSessions("friend", f.home);
  const healed = await readSessionMemory(f.home, "friend", turn.sessionId);
  assert.equal(healed.orphan, true, "the recovering read converges the memory");
  assert.equal(healed.entries.length, 1);
  assert.equal((await readRemovedSessionIndexState(project)).pendingOperation, undefined, "the pending intent is cleared only after convergence");
});

test("P1 review 31: an interrupted restore leaves a stale orphan that the next index read or legitimate write converges", async (t) => {
  const f = await fixture(t);
  const turn = await executeLongAgentTurn(f.input("smem-r31-restore"));
  await writeSessionMemoryEntry({ chatHome: f.home, longAgentId: "friend", sessionId: turn.sessionId, operation: "write", purpose: "finding", author: "agent", content: "恢复内容", expectedRevision: 0 });
  const { resolveProjectContext } = await import("../../src/projects/registry.ts");
  const { readRemovedSessionIndexState } = await import("../../src/removed-session-index.ts");
  const { requireActiveChatSessionFile } = await import("../../src/session-state.ts");
  const project = await resolveProjectContext("friend", f.home);
  await removeChatSession("friend", turn.sessionId, f.home);
  fs.chmodSync(readOnlyMemoryDir(f), 0o500);
  await assert.rejects(restoreRemovedChatSession("friend", turn.sessionId, f.home), undefined);
  fs.chmodSync(readOnlyMemoryDir(f), 0o700);
  // Stale pair: the file is back in the active directory but the memory is still orphan.
  assert.equal((await readSessionMemory(f.home, "friend", turn.sessionId)).orphan, true);
  assert.equal((await readRemovedSessionIndexState(project)).pendingOperation !== undefined, true);
  // The state-check entry (used by session reads) finds the session active again, so it does not touch
  // the index; the stale orphan flag is healed by the write path, which never refuses a legitimate
  // write for an actually-active session (review 31).
  const info = await requireActiveChatSessionFile(project, turn.sessionId);
  assert.equal(info.id, turn.sessionId);
  const stale = await readSessionMemory(f.home, "friend", turn.sessionId);
  const healed = await writeSessionMemoryEntry({ chatHome: f.home, longAgentId: "friend", sessionId: turn.sessionId, operation: "write", purpose: "rule", author: "user", content: "恢复后写入", expectedRevision: stale.revision });
  assert.equal(healed.orphan, false, "a legitimate write self-heals the stale orphan flag");
  assert.equal(healed.entries.length, 2);
  // An index-touching read converges the pending intent too.
  const { listRemovedChatSessions } = await import("../../src/session-removal.ts");
  await listRemovedChatSessions("friend", f.home);
  assert.equal((await readRemovedSessionIndexState(project)).pendingOperation, undefined);
  assert.equal((await readSessionMemory(f.home, "friend", turn.sessionId)).orphan, false);
});

test("P1 review 31/32: an interrupted purge keeps the memory until the intent is converged", async (t) => {
  const f = await fixture(t);
  const turn = await executeLongAgentTurn(f.input("smem-r31-purge"));
  await writeSessionMemoryEntry({ chatHome: f.home, longAgentId: "friend", sessionId: turn.sessionId, operation: "write", purpose: "finding", author: "agent", content: "purge 前内容", expectedRevision: 0 });
  const { resolveProjectContext } = await import("../../src/projects/registry.ts");
  const { listRemovedChatSessions } = await import("../../src/session-removal.ts");
  const { readRemovedSessionIndexState } = await import("../../src/removed-session-index.ts");
  const project = await resolveProjectContext("friend", f.home);
  await removeChatSession("friend", turn.sessionId, f.home);
  fs.chmodSync(readOnlyMemoryDir(f), 0o500);
  await assert.rejects(purgeRemovedChatSession("friend", turn.sessionId, f.home), undefined);
  fs.chmodSync(readOnlyMemoryDir(f), 0o700);
  // The memory is still there (content intact) and the pending intent is preserved.
  assert.equal((await readSessionMemory(f.home, "friend", turn.sessionId)).entries.length, 1, "an incomplete purge must not drop the memory");
  assert.equal((await readRemovedSessionIndexState(project)).pendingOperation !== undefined, true);
  await listRemovedChatSessions("friend", f.home);
  assert.equal(fs.existsSync(sessionMemoryFile(f.home, "friend", turn.sessionId)), false, "the recovering read converges the purge");
  assert.equal((await readRemovedSessionIndexState(project)).pendingOperation, undefined);
  assert.equal((await readRemovedSessionIndexState(project)).tombstones[turn.sessionId] !== undefined, true);
});

test("P1 review 32: a failed convergence keeps the pending intent for the automatic expiry retry", async (t) => {
  const f = await fixture(t);
  const turn = await executeLongAgentTurn(f.input("smem-r32-auto"));
  await writeSessionMemoryEntry({ chatHome: f.home, longAgentId: "friend", sessionId: turn.sessionId, operation: "write", purpose: "background", author: "agent", content: "自动过期内容", expectedRevision: 0 });
  const { resolveProjectContext } = await import("../../src/projects/registry.ts");
  const { listRemovedChatSessions } = await import("../../src/session-removal.ts");
  const { readRemovedSessionIndexState } = await import("../../src/removed-session-index.ts");
  const project = await resolveProjectContext("friend", f.home);
  await removeChatSession("friend", turn.sessionId, f.home);
  const future = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000);
  fs.chmodSync(readOnlyMemoryDir(f), 0o500);
  await assert.rejects(listRemovedChatSessions("friend", f.home, future), undefined);
  fs.chmodSync(readOnlyMemoryDir(f), 0o700);
  assert.equal((await readSessionMemory(f.home, "friend", turn.sessionId)).entries.length, 1, "the memory survives the failed automatic purge");
  assert.equal((await readRemovedSessionIndexState(project)).pendingOperation !== undefined, true, "the pending intent stays for the retry");
  // The next expiry scan retries and converges.
  await listRemovedChatSessions("friend", f.home, future);
  assert.equal(fs.existsSync(sessionMemoryFile(f.home, "friend", turn.sessionId)), false);
  assert.equal((await readRemovedSessionIndexState(project)).pendingOperation, undefined);
});
