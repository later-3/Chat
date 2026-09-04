import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  appendChatSubsessionRelation,
  appendChatWorkflowCall,
  appendChatWorkflowDelegationOrigin,
  collectChatSubsessionRelation,
  collectChatWorkflowCalls,
  collectChatWorkflowDelegationOrigins,
  resolveChatWorkflowDelegationOrigins,
} from "./workflow-call-state.ts";

function manager() {
  return SessionManager.inMemory("/tmp/chat-workflow-call-test");
}

test("Workflow Call state keeps relationship IDs but not duplicated task or result text", () => {
  const session = manager();
  const base = {
    schemaVersion: 1,
    callId: "call-1",
    toolCallId: "tool-call-1",
    parent: {
      sessionId: "parent-session",
      workflowId: "planner-orchestrator",
      workflowInvocationId: "parent-invocation",
      stageId: "delegate",
      agentId: "coordinator",
    },
    child: {
      sessionId: "child-session",
      workflowId: "minimal-pi-coding-agent",
      workflowInvocationId: "child-invocation",
    },
    status: "starting",
    startedAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
  };
  appendChatWorkflowCall(session, base);
  appendChatWorkflowCall(session, {
    ...base,
    child: { ...base.child, runId: "run-1" },
    status: "completed",
    updatedAt: "2026-09-02T00:00:01.000Z",
    finishedAt: "2026-09-02T00:00:01.000Z",
    durationMs: 1_000,
  });

  assert.deepEqual(collectChatWorkflowCalls(session.getEntries()), [{
    ...base,
    child: { ...base.child, runId: "run-1" },
    status: "completed",
    updatedAt: "2026-09-02T00:00:01.000Z",
    finishedAt: "2026-09-02T00:00:01.000Z",
    durationMs: 1_000,
  }]);
  assert.doesNotMatch(JSON.stringify(session.getEntries()), /task text|result text/);
});

test("Subsession relation is independent from Workflow Run identity", () => {
  const session = manager();
  appendChatSubsessionRelation(session, {
    callId: "call-1",
    parentSessionId: "parent-session",
    childSessionId: "child-session",
    depth: 2,
    createdAt: "2026-09-02T00:00:00.000Z",
  });
  assert.deepEqual(collectChatSubsessionRelation(session.getEntries()), {
    schemaVersion: 1,
    relation: "subsession",
    callId: "call-1",
    parentSessionId: "parent-session",
    childSessionId: "child-session",
    depth: 2,
    createdAt: "2026-09-02T00:00:00.000Z",
  });
});

test("delegation origin records Agent authorship without duplicating the task", () => {
  const session = manager();
  appendChatWorkflowDelegationOrigin(session, {
    schemaVersion: 1,
    callId: "call-1",
    source: {
      sessionId: "parent-session",
      workflowId: "planner-orchestrator",
      workflowInvocationId: "parent-invocation",
      stageId: "delegate",
      agentId: "coordinator",
    },
    target: {
      sessionId: "child-session",
      workflowId: "memory",
      workflowInvocationId: "child-invocation",
    },
  });

  assert.deepEqual(collectChatWorkflowDelegationOrigins(session.getEntries()), [{
    schemaVersion: 1,
    callId: "call-1",
    source: {
      sessionId: "parent-session",
      workflowId: "planner-orchestrator",
      workflowInvocationId: "parent-invocation",
      stageId: "delegate",
      agentId: "coordinator",
    },
    target: {
      sessionId: "child-session",
      workflowId: "memory",
      workflowInvocationId: "child-invocation",
    },
  }]);
  assert.doesNotMatch(JSON.stringify(session.getEntries()), /delegated task text/);
});

test("legacy Child Sessions recover delegation authorship from Pi lineage and callId", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-workflow-origin-legacy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  const parent = SessionManager.create(root, sessionDir);
  parent.appendMessage({ role: "user", content: "parent request", timestamp: 1 });
  parent.flush();
  const child = SessionManager.create(root, sessionDir);
  child.newSession({ parentSession: parent.getSessionFile() });
  appendChatSubsessionRelation(child, {
    callId: "legacy-call",
    parentSessionId: parent.getSessionId(),
    childSessionId: child.getSessionId(),
    depth: 1,
    createdAt: "2026-09-02T00:00:00.000Z",
  });
  child.flush();
  appendChatWorkflowCall(parent, {
    schemaVersion: 1,
    callId: "legacy-call",
    toolCallId: "legacy-tool-call",
    parent: {
      sessionId: parent.getSessionId(),
      workflowId: "minimal-pi-coding-agent",
      workflowInvocationId: "parent-invocation",
      stageId: "execute",
      agentId: "pi-coding-agent",
    },
    child: {
      sessionId: child.getSessionId(),
      workflowId: "memory",
      workflowInvocationId: "child-invocation",
      runId: "child-run",
    },
    status: "completed",
    startedAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:01.000Z",
    finishedAt: "2026-09-02T00:00:01.000Z",
    durationMs: 1_000,
  });
  parent.flush();

  assert.deepEqual(await resolveChatWorkflowDelegationOrigins(child), [{
    schemaVersion: 1,
    callId: "legacy-call",
    source: {
      sessionId: parent.getSessionId(),
      workflowId: "minimal-pi-coding-agent",
      workflowInvocationId: "parent-invocation",
      stageId: "execute",
      agentId: "pi-coding-agent",
    },
    target: {
      sessionId: child.getSessionId(),
      workflowId: "memory",
      workflowInvocationId: "child-invocation",
    },
  }]);
});

test("legacy Child Sessions recover from Chat relation when Pi lineage is absent", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-workflow-origin-relation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  const parent = SessionManager.create(root, sessionDir);
  parent.appendMessage({ role: "user", content: "parent request", timestamp: 1 });
  parent.flush();
  const child = SessionManager.create(root, sessionDir);
  appendChatSubsessionRelation(child, {
    callId: "relation-only-call",
    parentSessionId: parent.getSessionId(),
    childSessionId: child.getSessionId(),
    depth: 1,
    createdAt: "2026-09-02T00:00:00.000Z",
  });
  child.flush();
  appendChatWorkflowCall(parent, {
    schemaVersion: 1,
    callId: "relation-only-call",
    toolCallId: "relation-only-tool-call",
    parent: {
      sessionId: parent.getSessionId(),
      workflowId: "minimal-pi-coding-agent",
      workflowInvocationId: "parent-invocation",
      stageId: "execute",
      agentId: "pi-coding-agent",
    },
    child: {
      sessionId: child.getSessionId(),
      workflowId: "memory",
      workflowInvocationId: "child-invocation",
    },
    status: "completed",
    startedAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:01.000Z",
    finishedAt: "2026-09-02T00:00:01.000Z",
    durationMs: 1_000,
  });
  parent.flush();

  const [origin] = await resolveChatWorkflowDelegationOrigins(child);
  assert.equal(origin?.callId, "relation-only-call");
  assert.equal(origin?.source.workflowId, "minimal-pi-coding-agent");
  assert.equal(origin?.source.agentId, "pi-coding-agent");
  assert.equal(origin?.target.workflowInvocationId, "child-invocation");
});
