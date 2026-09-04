import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  MAX_ACTIVE_CHAT_WORKFLOW_CALLS_PER_PARENT,
  reserveChatWorkflowCallCapacity,
} from "./workflow-call-capacity.ts";
import { appendChatWorkflowCall } from "./workflow-call-state.ts";

function manager() {
  return SessionManager.inMemory("/tmp/chat-workflow-call-capacity-test");
}

function appendCall(session, index, status) {
  const startedAt = "2026-09-03T00:00:00.000Z";
  appendChatWorkflowCall(session, {
    schemaVersion: 1,
    callId: `call-${String(index)}`,
    toolCallId: `tool-${String(index)}`,
    parent: {
      sessionId: session.getSessionId(),
      workflowId: "minimal-pi-coding-agent",
      workflowInvocationId: "parent-invocation",
      stageId: "execute",
      agentId: "pi-coding-agent",
    },
    child: {
      sessionId: `child-${String(index)}`,
      workflowId: "minimal-pi-coding-agent",
      workflowInvocationId: `child-invocation-${String(index)}`,
      runId: `run-${String(index)}`,
    },
    status,
    startedAt,
    updatedAt: startedAt,
    ...(["completed", "failed", "cancelled"].includes(status)
      ? { finishedAt: startedAt, durationMs: 0 }
      : {}),
  });
}

test("Workflow call capacity closes the same-turn race before calls are persisted", () => {
  const session = manager();
  const releases = Array.from(
    { length: MAX_ACTIVE_CHAT_WORKFLOW_CALLS_PER_PARENT },
    () => reserveChatWorkflowCallCapacity("project-one", session),
  );
  assert.throws(
    () => reserveChatWorkflowCallCapacity("project-one", session),
    new RegExp(`不能超过${String(MAX_ACTIVE_CHAT_WORKFLOW_CALLS_PER_PARENT)}`),
  );
  releases[0]();
  const replacement = reserveChatWorkflowCallCapacity("project-one", session);
  replacement();
  for (const release of releases) release();
});

test("Workflow call capacity counts only durable non-terminal calls", () => {
  const session = manager();
  for (let index = 0; index < MAX_ACTIVE_CHAT_WORKFLOW_CALLS_PER_PARENT; index += 1) {
    appendCall(session, index, index === 0 ? "completed" : "running");
  }
  const release = reserveChatWorkflowCallCapacity("project-one", session);
  release();
  appendCall(session, MAX_ACTIVE_CHAT_WORKFLOW_CALLS_PER_PARENT, "starting");
  assert.throws(() => reserveChatWorkflowCallCapacity("project-one", session), /同时运行的子Workflow/);
});

test("pending Workflow call capacity remains isolated between Projects", () => {
  const session = manager();
  const releases = Array.from(
    { length: MAX_ACTIVE_CHAT_WORKFLOW_CALLS_PER_PARENT },
    () => reserveChatWorkflowCallCapacity("project-one", session),
  );
  const anotherProject = reserveChatWorkflowCallCapacity("project-two", session);
  anotherProject();
  for (const release of releases) release();
});
