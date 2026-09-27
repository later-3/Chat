import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fixture } from "./long-agents/daily-fixture.mjs";
import { createChatPiAgentSession } from "../src/agents/pi-agent-session.ts";
import { openChatSession } from "../src/chat-session.ts";
import { readSessionMaintenance, startSessionMaintenance, cancelSessionMaintenance, parseSessionMaintenanceInput } from "../src/session-maintenance.ts";
import { withChatSessionOperationLock, chatSessionOperationKey } from "../src/session-operation-lock.ts";

async function setup(t, retry = false) {
  const f = await fixture(t);
  const file = path.join(f.home, "agent/settings.json");
  const settings = JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify({ ...settings, retry: { enabled: retry, maxRetries: 2, baseDelayMs: 60000, provider: { maxRetries: 0 } } }));
  const chat = await openChatSession({ projectId: f.projects[0].projectId, chatHome: f.home });
  const { session } = await createChatPiAgentSession({ chatSession: chat, sessionManager: chat.manager,
    agent: { schemaVersion: 1, id: "test", name: "test", description: "test", systemPrompt: { mode: "replace", text: "Answer" }, customInstructions: [], tools: { mode: "none" }, resources: { mode: "explicit", skillPaths: [], extensionPaths: [], pluginSources: [] } } });
  t.after(() => session.dispose());
  await session.prompt("ORIGINAL " + "context ".repeat(200));
  await session.prompt("ABANDONED");
  const id = chat.manager.getSessionId(), projectId = chat.projectId;
  const read = () => readSessionMaintenance(projectId, id, f.home);
  const input = (requestId, more = {}) => ({ projectId, requestId, expectedLeafId: SessionManager.open(chat.manager.getSessionFile()).getLeafId(), kind: "compact", ...more });
  const start = value => startSessionMaintenance(id, value, f.home);
  const wait = async predicate => { let value; for (let i = 0; i < 200; i++) { value = await read(); if (predicate(value)) return value; await delay(10); } throw new Error(`Maintenance did not settle: ${JSON.stringify(value?.operation)}`); };
  return { ...f, chat, session, id, projectId, read, input, start, wait, reopen: () => SessionManager.open(chat.manager.getSessionFile()) };
}

test("native stats are read-only; manual compaction survives re-read and is idempotent", async t => {
  const f = await setup(t);
  const before = fs.readFileSync(f.chat.manager.getSessionFile(), "utf8");
  assert.equal((await f.read()).stats.tokens.total, 120);
  assert.equal(fs.readFileSync(f.chat.manager.getSessionFile(), "utf8"), before);
  assert.equal(f.requests.length, 2, "reading statistics must not call a model");
  f.setHandler(() => ({ content: "NATIVE_SUMMARY" }));
  const input = f.input("compact-once");
  assert.equal((await f.start(input)).status, "running");
  const completed = await f.wait(value => value.operation?.status === "completed");
  assert.equal(completed.stats.contextUsage.tokens, null);
  assert.ok(completed.stats.tokens.total > 120, "summary usage is included");
  const calls = f.requests.length;
  assert.deepEqual(await f.start(input), completed.operation);
  assert.equal(f.requests.length, calls);
  assert.equal(f.reopen().getEntries().filter(e => e.type === "compaction").length, 1);
  await assert.rejects(f.start({ ...input, instructions: "changed" }), /different operation/);
});

test("manual cancellation during retry settles without a checkpoint or delayed retry", async t => {
  const f = await setup(t, true);
  f.setHandler(() => ({ error: "terminated" }));
  await f.start(f.input("cancel-retry"));
  await f.wait(value => value.event?.type === "summarization_retry_scheduled");
  await cancelSessionMaintenance(f.projectId, f.id, "cancel-retry", f.home);
  assert.equal((await f.wait(value => value.operation?.status === "cancelled")).operation.status, "cancelled");
  assert.equal(f.requests.length, 3);
  assert.equal(f.reopen().getEntries().some(e => e.type === "compaction"), false);
  f.setHandler(() => ({ content: "RECOVERED" }));
  await f.start(f.input("after-cancel"));
  await f.wait(value => value.operation?.status === "completed");
});

test("continuation commits a native branch, retains old history and rejects stale clients", async t => {
  const f = await setup(t);
  const entries = f.reopen().getEntries();
  const firstAssistant = entries.find(e => e.type === "message" && e.message.role === "assistant");
  const input = f.input("continue-once", { kind: "continue", entryId: firstAssistant.id });
  const calls = f.requests.length;
  assert.equal((await f.start(input)).status, "completed");
  assert.match(JSON.stringify(f.reopen().getEntries()), /ABANDONED/);
  assert.doesNotMatch(JSON.stringify(f.reopen().buildSessionContext()), /ABANDONED/);
  assert.equal((await f.read()).stats.userMessages, 2, "totals include the abandoned branch");
  assert.equal(f.requests.length, calls, "continuing does not replay tools or call a model");
  assert.equal((await f.start(input)).status, "completed");
  await assert.rejects(f.start({ ...input, requestId: "stale" }), /Session changed/);
  const firstUser = entries.find(e => e.type === "message" && e.message.role === "user");
  const editing = await f.start(f.input("edit-first", { kind: "continue", entryId: firstUser.id }));
  assert.match(editing.editorText, /ORIGINAL/);
  assert.equal(f.reopen().buildSessionContext().messages.length, 0);
});

test("busy locks and unfinished tool boundaries refuse maintenance without changing history", async t => {
  const f = await setup(t);
  await withChatSessionOperationLock(chatSessionOperationKey(f.projectId, f.id), async () => {
    await assert.rejects(f.start(f.input("busy")), /busy/);
  });
  const manager = f.reopen();
  const assistant = manager.getEntries().find(e => e.type === "message" && e.message.role === "assistant").message;
  const toolId = manager.appendMessage({ ...assistant, stopReason: "toolUse", content: [{ type: "toolCall", id: "t", name: "bash", arguments: { command: "touch file" } }] });
  const userId = manager.appendMessage({ role: "user", content: "interrupt", timestamp: Date.now() }); manager.flush();
  for (const entryId of [toolId, userId]) await assert.rejects(f.start(f.input(`invalid-${entryId}`, { kind: "continue", entryId })), /completed/);
  assert.equal(f.requests.length, 2);
});

test("orphaned maintenance is reported interrupted and never replayed on read/retry", async t => {
  const f = await setup(t);
  const manager = f.reopen(), input = f.input("interrupted");
  manager.appendCustomEntry("chat.session-maintenance.v1", { schemaVersion: 1, requestId: input.requestId, input,
    result: { schemaVersion: 1, sessionId: f.id, requestId: input.requestId, kind: "compact", status: "running" } }); manager.flush();
  const before = fs.readFileSync(manager.getSessionFile(), "utf8");
  assert.equal((await f.read()).operation.status, "interrupted");
  assert.equal((await f.start(input)).status, "interrupted");
  assert.equal(f.requests.length, 2);
  assert.equal(fs.readFileSync(manager.getSessionFile(), "utf8"), before);
});

test("maintenance request validation rejects ambiguous identities and unsupported fields", () => {
  for (const value of [{}, { projectId: "p", requestId: "r", kind: "compact" }, { projectId: "p", requestId: "r", kind: "continue", expectedLeafId: null }, { projectId: "p", requestId: "r", kind: "compact", expectedLeafId: null, entryId: "e" }]) assert.throws(() => parseSessionMaintenanceInput(value));
});

test("group work native bindings block generic maintenance even when absent from the navigation roster", async t => {
  const f = await setup(t), manager = f.reopen();
  manager.appendCustomEntry("chat.group-work-session.v1", { conversationId: "group", storageProjectId: f.projectId, longAgentId: "friend", participationEpoch: 1, boundAt: new Date().toISOString() }); manager.flush();
  assert.deepEqual((await f.read()).capabilities, { compact: false, continue: false });
  await assert.rejects(f.start(f.input("no-group-bypass")), /owner-specific/);
  assert.equal(f.requests.length, 2);
});
