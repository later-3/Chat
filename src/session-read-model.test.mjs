import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  listChatSessions,
  normalizeMessageForFrontend,
  projectSessionContext,
} from "./session-read-model.ts";
import {
  appendChatWorkflowMessage,
  appendChatWorkflowStage,
} from "./workflows/workflow-stage.ts";

function userEntry(id, parentId, content) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content },
  };
}

function assistantEntry(id, parentId, content) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "assistant", provider: "test", model: "test-model", content },
  };
}

test("Pi toolCall fields are projected to the frontend contract", () => {
  assert.deepEqual(
    normalizeMessageForFrontend({
      role: "assistant",
      content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "/repo/a.ts" } }],
    }),
    {
      role: "assistant",
      content: [{
        type: "toolCall",
        toolCallId: "tool-1",
        toolName: "read",
        input: { path: "/repo/a.ts" },
      }],
    },
  );
});

test("compaction-aware messages stay aligned with entry ids", () => {
  const entries = [
    userEntry("u1", null, "old request"),
    assistantEntry("a1", "u1", [{ type: "text", text: "old answer" }]),
    userEntry("u2", "a1", "kept request"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "old exchange summary",
      firstKeptEntryId: "u2",
      tokensBefore: 123,
    },
    userEntry("u3", "cmp", "after compaction"),
  ];
  const context = projectSessionContext(entries);
  assert.deepEqual(context.entryIds, ["cmp", "u2", "u3"]);
  assert.equal(context.messages.length, context.entryIds.length);
  assert.equal(context.messages[0].role, "compactionSummary");
});

test("a selected branch does not include a later compaction on another branch", () => {
  const entries = [
    userEntry("u1", null, "root"),
    assistantEntry("a1", "u1", [{ type: "text", text: "answer" }]),
    userEntry("main", "a1", "main"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "main",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "main summary",
      firstKeptEntryId: "main",
      tokensBefore: 100,
    },
    userEntry("alternate", "a1", "alternate"),
  ];
  const context = projectSessionContext(entries, "alternate");
  assert.deepEqual(context.entryIds, ["u1", "a1", "alternate"]);
  assert.equal(context.messages.some((message) => message.role === "compactionSummary"), false);
  assert.deepEqual(projectSessionContext(entries, null).entryIds, []);
});

test("historical thinking is deferred only when requested", () => {
  const entries = [
    userEntry("u1", null, "start"),
    assistantEntry("a1", "u1", [
      { type: "thinking", thinking: "large reasoning" },
      { type: "text", text: "answer" },
    ]),
  ];
  const deferred = projectSessionContext(entries, undefined, { deferThinking: true });
  assert.deepEqual(deferred.messages[1].content[0], {
    type: "thinking",
    thinking: "",
    deferred: true,
  });
  assert.equal(projectSessionContext(entries).messages[1].content[0].thinking, "large reasoning");
});

test("Planner output stays visible after the user request without entering Pi context", () => {
  const manager = SessionManager.inMemory("/workspace");
  appendChatWorkflowStage(manager, {
    invocationId: "invocation-1",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
  });
  const plannerEntryId = appendChatWorkflowMessage(manager, {
    invocationId: "invocation-1",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
    message: {
      role: "assistant",
      provider: "test",
      model: "planner-model",
      content: [
        { type: "thinking", thinking: "planner reasoning" },
        { type: "text", text: "planner plan" },
      ],
      timestamp: 2,
    },
  });
  appendChatWorkflowStage(manager, {
    invocationId: "invocation-1",
    workflowId: "planning-execution",
    stageId: "execute",
    agentId: "pi-coding-agent",
  });
  const userEntryId = manager.appendMessage({ role: "user", content: "original request", timestamp: 3 });
  const executorEntryId = manager.appendMessage({
    role: "assistant",
    provider: "test",
    model: "executor-model",
    content: [{ type: "text", text: "final answer" }],
    timestamp: 4,
  });

  const projected = projectSessionContext(manager.getEntries(), undefined, { deferThinking: true });
  assert.deepEqual(projected.messages.map((message) => message.role), ["user", "assistant", "assistant"]);
  assert.deepEqual(projected.entryIds, [userEntryId, plannerEntryId, executorEntryId]);
  assert.equal(projected.messages[0].content, "original request");
  assert.equal(projected.messages[1].content[0].thinking, "planner reasoning");
  assert.equal(projected.messages[1].chatWorkflow.agentId, "planner");
  assert.equal(projected.messages[2].content[0].text, "final answer");
  assert.deepEqual(
    manager.buildSessionContext().messages.map((message) => message.role),
    ["user", "assistant"],
  );
});

test("only base64 tool-result images are omitted from the initial payload", () => {
  const entries = [
    userEntry("u1", null, [{ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJDRA==" } }]),
    {
      type: "message",
      id: "tr1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call1",
        content: [
          { type: "text", text: "result" },
          { type: "image", data: "QUJDRA==", mimeType: "image/png" },
          { type: "image", source: { type: "url", url: "https://example.com/result.png" } },
        ],
      },
    },
  ];
  const context = projectSessionContext(entries, undefined, { deferToolResultImages: true });
  assert.equal(context.messages[0].content.length, 1);
  assert.equal(context.messages[1].content[1].source.type, "url");
  assert.match(context.messages[1].content[2].text, /1 tool result image omitted.*image\/png.*~4 bytes/);
});

test("session listing scans only Chat .chat/sessions", { concurrency: false }, async (t) => {
  const previousCwd = process.cwd();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-session-list-"));
  t.after(() => {
    process.chdir(previousCwd);
    fs.rmSync(base, { recursive: true, force: true });
  });
  const workspace = path.join(base, "workspace");
  const chatSessionDir = path.join(base, ".chat", "sessions");
  const unrelatedDir = path.join(base, "unrelated-sessions");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(chatSessionDir, { recursive: true });
  fs.mkdirSync(unrelatedDir, { recursive: true });

  const included = SessionManager.create(workspace, chatSessionDir);
  included.appendMessage({ role: "user", content: "included", timestamp: Date.now() });
  included.appendMessage({
    role: "assistant",
    provider: "test",
    model: "test-model",
    content: [{ type: "text", text: "included response" }],
    timestamp: Date.now(),
  });
  const excluded = SessionManager.create(workspace, unrelatedDir);
  excluded.appendMessage({ role: "user", content: "excluded", timestamp: Date.now() });
  excluded.appendMessage({
    role: "assistant",
    provider: "test",
    model: "test-model",
    content: [{ type: "text", text: "excluded response" }],
    timestamp: Date.now(),
  });

  process.chdir(base);
  const sessions = await listChatSessions();
  assert.deepEqual(sessions.map((session) => session.id), [included.getSessionId()]);
  assert.equal(sessions[0].sessionSource, "chat");
  assert.equal(sessions[0].readOnly, false);
});
