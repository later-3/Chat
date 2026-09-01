import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  CHAT_SESSION_MIGRATION_CUSTOM_TYPE,
  migrateSessionNativeMessagesV1,
  restoreSessionNativeMessagesV1,
  SESSION_NATIVE_MESSAGES_MIGRATION_ID,
} from "./session-native-messages-v1.ts";

function assistant(text, timestamp) {
  return {
    role: "assistant",
    provider: "test",
    model: "test-model",
    api: "test",
    content: [{ type: "text", text }],
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

function stage(manager, stageId, agentId) {
  manager.appendCustomEntry("chat.workflow_stage", {
    schemaVersion: 1,
    invocationId: "invocation-1",
    workflowId: "planning-execution",
    stageId,
    agentId,
  });
}

test("legacy planning Session migrates to native conversation messages once with a recoverable backup", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "chat-native-session-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionDir = resolve(root, "sessions");
  const projectDataDir = resolve(root, "project-data");
  const manager = SessionManager.create("/workspace", sessionDir);
  stage(manager, "plan", "planner");
  const firstInputId = manager.appendCustomEntry("chat.workflow_agent_input", {
    schemaVersion: 1,
    invocationId: "invocation-1",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
    userPrompt: "original request",
  });
  const firstPlanId = manager.appendCustomEntry("chat.workflow_message", {
    schemaVersion: 1,
    invocationId: "invocation-1",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
    message: assistant("plan one", 2),
  });
  manager.appendCustomEntry("chat.plan_review_decision", {
    schemaVersion: 1,
    workflowId: "planning-execution",
    stageId: "review",
    kind: "request_revision",
    reviewId: "review-1",
    workflowInvocationId: "invocation-1",
    planRevision: 1,
    planSha256: "a".repeat(64),
    feedback: "add rollback",
    decidedAt: "2026-09-01T00:00:00.000Z",
  });
  stage(manager, "plan", "planner");
  manager.appendCustomEntry("chat.workflow_agent_input", {
    schemaVersion: 1,
    invocationId: "invocation-1",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
    userPrompt: "original request",
  });
  const finalPlanId = manager.appendCustomEntry("chat.workflow_message", {
    schemaVersion: 1,
    invocationId: "invocation-1",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
    message: assistant("plan two", 3),
  });
  stage(manager, "execute", "pi-coding-agent");
  const executeInputId = manager.appendCustomEntry("chat.workflow_agent_input", {
    schemaVersion: 1,
    invocationId: "invocation-1",
    workflowId: "planning-execution",
    stageId: "execute",
    agentId: "pi-coding-agent",
    userPrompt: "original request",
    upstream: { stageId: "plan", agentId: "planner", output: "plan two" },
  });
  const duplicateUserId = manager.appendMessage({ role: "user", content: "original request", timestamp: 4 });
  manager.appendMessage(assistant("done", 5));
  manager.flush();
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  const source = await readFile(sessionFile, "utf8");

  const first = await migrateSessionNativeMessagesV1({ sessionFile, projectDataDir });
  assert.equal(first.migrated, true);
  assert.equal(first.convertedMessageIds.includes(firstPlanId), true);
  assert.equal(first.convertedMessageIds.includes(finalPlanId), true);
  assert.ok(first.backupPath);
  assert.equal(await readFile(first.backupPath, "utf8"), source);

  const migrated = SessionManager.open(sessionFile, sessionDir);
  const entries = migrated.getEntries();
  const firstInput = migrated.getEntry(firstInputId);
  const executeInput = migrated.getEntry(executeInputId);
  assert.equal(firstInput.data.schemaVersion, 2);
  assert.equal("userPrompt" in firstInput.data, false);
  assert.equal(executeInput.data.schemaVersion, 2);
  assert.equal("upstream" in executeInput.data, false);
  assert.equal(migrated.getEntry(firstPlanId).type, "message");
  assert.equal(migrated.getEntry(finalPlanId).type, "message");
  assert.equal(migrated.getEntry(duplicateUserId).type, "custom_message");

  const nativeMessages = entries.filter((entry) => entry.type === "message");
  assert.deepEqual(nativeMessages.map((entry) => entry.message.role), [
    "user", "assistant", "user", "assistant", "assistant",
  ]);
  assert.deepEqual(nativeMessages
    .filter((entry) => entry.message.role === "user")
    .map((entry) => entry.message.content[0].text), ["original request", "add rollback"]);
  const decision = entries.find((entry) => entry.type === "custom" && entry.customType === "chat.plan_review_decision");
  assert.equal(migrated.getEntry(decision.data.feedbackEntryId).message.role, "user");
  assert.equal(entries.some((entry) => entry.type === "custom"
    && entry.customType === CHAT_SESSION_MIGRATION_CUSTOM_TYPE
    && entry.data.migrationId === SESSION_NATIVE_MESSAGES_MIGRATION_ID), true);

  const second = await migrateSessionNativeMessagesV1({ sessionFile, projectDataDir });
  assert.equal(second.migrated, false);
  await access(first.backupPath);
  await restoreSessionNativeMessagesV1({ sessionFile, backupPath: first.backupPath });
  assert.equal(await readFile(sessionFile, "utf8"), source);
});

test("already compliant Session is a no-op and creates no backup", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "chat-native-session-noop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = SessionManager.create("/workspace", resolve(root, "sessions"));
  manager.appendMessage({ role: "user", content: "native", timestamp: 1 });
  manager.appendMessage(assistant("native answer", 2));
  manager.flush();
  const before = await readFile(manager.getSessionFile(), "utf8");
  const result = await migrateSessionNativeMessagesV1({
    sessionFile: manager.getSessionFile(),
    projectDataDir: resolve(root, "project-data"),
  });
  assert.equal(result.migrated, false);
  assert.equal(result.backupPath, undefined);
  assert.equal(await readFile(manager.getSessionFile(), "utf8"), before);
});
