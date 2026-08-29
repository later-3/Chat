import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  appendChatWorkflowAgentInput,
  appendChatWorkflowMessage,
  appendChatWorkflowStage,
  collectChatWorkflowAgentInputs,
  collectChatWorkflowMessages,
  collectChatWorkflowStageEntryIds,
  collectChatWorkflowStageMarkers,
} from "./workflow-stage.ts";

function assistantMessage(text) {
  return {
    role: "assistant",
    provider: "test",
    model: "test-model",
    api: "test",
    content: [{ type: "text", text }],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  };
}

test("Workflow Stage uses Pi CustomEntry without entering the Agent context", () => {
  const manager = SessionManager.inMemory("/workspace");
  const markerId = appendChatWorkflowStage(manager, {
    invocationId: "invocation-1",
    workflowId: "future-workflow",
    stageId: "review",
    agentId: "critic-agent",
  });
  manager.appendMessage({ role: "user", content: "review this", timestamp: 1 });

  assert.deepEqual(manager.buildSessionContext().messages, [
    { role: "user", content: "review this", timestamp: 1 },
  ]);
  assert.deepEqual(collectChatWorkflowStageMarkers(manager.getEntries()), [{
    entryId: markerId,
    schemaVersion: 1,
    invocationId: "invocation-1",
    workflowId: "future-workflow",
    stageId: "review",
    agentId: "critic-agent",
  }]);
});

test("Workflow Message persists internal output without entering Agent context", () => {
  const manager = SessionManager.inMemory("/workspace");
  const message = assistantMessage("planner output");
  const entryId = appendChatWorkflowMessage(manager, {
    invocationId: "invocation-1",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
    message,
  });

  assert.deepEqual(manager.buildSessionContext().messages, []);
  assert.deepEqual(collectChatWorkflowMessages(manager.getEntries()), [{
    entryId,
    schemaVersion: 1,
    invocationId: "invocation-1",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
    message,
  }]);
});

test("Workflow Agent Input persists its user and upstream sources without entering later Agent context", () => {
  const manager = SessionManager.inMemory("/workspace");
  const entryId = appendChatWorkflowAgentInput(manager, {
    invocationId: "invocation-1",
    workflowId: "planning-execution",
    stageId: "execute",
    agentId: "pi-coding-agent",
    userPrompt: "original request",
    upstream: {
      stageId: "plan",
      agentId: "planner",
      output: "planner output",
    },
  });

  assert.deepEqual(manager.buildSessionContext().messages, []);
  assert.deepEqual(collectChatWorkflowAgentInputs(manager.getEntries()), [{
    entryId,
    schemaVersion: 1,
    invocationId: "invocation-1",
    workflowId: "planning-execution",
    stageId: "execute",
    agentId: "pi-coding-agent",
    userPrompt: "original request",
    upstream: {
      stageId: "plan",
      agentId: "planner",
      output: "planner output",
    },
  }]);
});

test("Workflow Agent Input also supports a first Stage with no upstream source", () => {
  const manager = SessionManager.inMemory("/workspace");
  const entryId = appendChatWorkflowAgentInput(manager, {
    invocationId: "invocation-1",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
    userPrompt: "original request",
  });

  assert.deepEqual(manager.buildSessionContext().messages, []);
  assert.deepEqual(collectChatWorkflowAgentInputs(manager.getEntries()), [{
    entryId,
    schemaVersion: 1,
    invocationId: "invocation-1",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
    userPrompt: "original request",
  }]);
});

test("unsupported or incomplete Workflow Stage schemas remain ordinary Pi entries", () => {
  const entries = [
    {
      type: "custom",
      id: "future",
      customType: "chat.workflow_stage",
      data: {
        schemaVersion: 2,
        invocationId: "invocation-2",
        workflowId: "future-workflow",
        stageId: "execute",
        agentId: "future-agent",
      },
    },
    {
      type: "custom",
      id: "incomplete",
      customType: "chat.workflow_stage",
      data: { schemaVersion: 1, workflowId: "future-workflow" },
    },
  ];
  assert.deepEqual(collectChatWorkflowStageMarkers(entries), []);
  assert.deepEqual(collectChatWorkflowStageEntryIds(entries), ["future", "incomplete"]);
});
