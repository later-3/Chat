import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isChatAgentContextEntry, openChatSession } from "./chat-session.ts";

test("Chat Session is created once and reopened by ID", { concurrency: false }, async (t) => {
  const previousCwd = process.cwd();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-session-"));
  t.after(() => {
    process.chdir(previousCwd);
    fs.rmSync(base, { recursive: true, force: true });
  });
  process.chdir(base);
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace);

  const created = await openChatSession({ cwd: workspace });
  created.manager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
  created.manager.appendMessage({
    role: "assistant",
    provider: "test",
    model: "test-model",
    content: [{ type: "text", text: "first response" }],
    timestamp: Date.now(),
  });

  const reopened = await openChatSession({
    cwd: workspace,
    sessionId: created.manager.getSessionId(),
  });
  assert.equal(reopened.manager.getSessionId(), created.manager.getSessionId());
  assert.equal(reopened.manager.getSessionFile(), created.manager.getSessionFile());
  assert.equal(reopened.manager.buildSessionContext().messages.length, 2);
  assert.deepEqual(fs.readdirSync(path.join(base, ".pi", "sessions")), [
    path.basename(created.manager.getSessionFile()),
  ]);
});

test("Chat Session rejects the same ID for another working directory", { concurrency: false }, async (t) => {
  const previousCwd = process.cwd();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-session-cwd-"));
  t.after(() => {
    process.chdir(previousCwd);
    fs.rmSync(base, { recursive: true, force: true });
  });
  process.chdir(base);
  const firstWorkspace = path.join(base, "first");
  const secondWorkspace = path.join(base, "second");
  fs.mkdirSync(firstWorkspace);
  fs.mkdirSync(secondWorkspace);

  const created = await openChatSession({ cwd: firstWorkspace });
  created.manager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
  created.manager.appendMessage({
    role: "assistant",
    provider: "test",
    model: "test-model",
    content: [{ type: "text", text: "first response" }],
    timestamp: Date.now(),
  });

  await assert.rejects(
    openChatSession({ cwd: secondWorkspace, sessionId: created.manager.getSessionId() }),
    /不属于工作目录/,
  );
});

test("legacy planning handoffs stay in storage but not Chat Agent context", { concurrency: false }, async (t) => {
  const previousCwd = process.cwd();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-session-legacy-handoff-"));
  t.after(() => {
    process.chdir(previousCwd);
    fs.rmSync(base, { recursive: true, force: true });
  });
  process.chdir(base);
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace);

  const created = await openChatSession({ cwd: workspace });
  created.manager.appendCustomEntry("chat.workflow_stage", {
    schemaVersion: 1,
    invocationId: "legacy-invocation",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
  });
  created.manager.appendMessage({ role: "user", content: "real request", timestamp: 1 });
  created.manager.appendMessage({
    role: "assistant",
    provider: "test",
    model: "planner-model",
    content: [{ type: "text", text: "legacy planner output" }],
    timestamp: 2,
  });
  created.manager.appendCustomEntry("chat.workflow_stage", {
    schemaVersion: 1,
    invocationId: "legacy-invocation",
    workflowId: "planning-execution",
    stageId: "execute",
    agentId: "pi-coding-agent",
  });
  created.manager.appendCustomMessageEntry(
    "planning-execution-handoff",
    "legacy internal handoff",
    false,
  );
  created.manager.appendMessage({
    role: "assistant",
    provider: "test",
    model: "executor-model",
    content: [{ type: "text", text: "final answer" }],
    timestamp: 3,
  });
  created.manager.flush();

  const reopened = await openChatSession({
    cwd: workspace,
    sessionId: created.manager.getSessionId(),
  });
  assert.equal(reopened.manager.getBranch().some(
    (entry) => entry.type === "custom_message" && !isChatAgentContextEntry(entry),
  ), true);
  assert.deepEqual(reopened.manager.buildSessionContext().messages.map((message) => message.role), [
    "user",
    "assistant",
  ]);
  assert.deepEqual(reopened.manager.buildSessionContext().messages, [
    { role: "user", content: "real request", timestamp: 1 },
    {
      role: "assistant",
      provider: "test",
      model: "executor-model",
      content: [{ type: "text", text: "final answer" }],
      timestamp: 3,
    },
  ]);
});
