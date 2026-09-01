import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  appendChatWorkflowAgentInput,
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
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  };
}

test("Workflow Stage stores agent/human provenance without entering Pi context", () => {
  const manager = SessionManager.inMemory("/workspace");
  const agentMarkerId = appendChatWorkflowStage(manager, {
    invocationId: "invocation-1",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
  });
  const humanMarkerId = appendChatWorkflowStage(manager, {
    invocationId: "invocation-1",
    workflowId: "planning-execution",
    stageId: "review",
    nodeKind: "human",
  });
  assert.deepEqual(manager.buildSessionContext().messages, []);
  assert.deepEqual(collectChatWorkflowStageMarkers(manager.getEntries()), [
    {
      entryId: agentMarkerId,
      schemaVersion: 2,
      invocationId: "invocation-1",
      workflowId: "planning-execution",
      stageId: "plan",
      nodeKind: "agent",
      agentId: "planner",
    },
    {
      entryId: humanMarkerId,
      schemaVersion: 2,
      invocationId: "invocation-1",
      workflowId: "planning-execution",
      stageId: "review",
      nodeKind: "human",
    },
  ]);
});

test("Workflow Agent Input v2 stores only native MessageEntry references", () => {
  const manager = SessionManager.inMemory("/workspace");
  const userEntryId = manager.appendMessage({ role: "user", content: "original request", timestamp: 1 });
  const entryId = appendChatWorkflowAgentInput(manager, {
    invocationId: "invocation-1",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
    inputEntryIds: [userEntryId],
  });
  assert.deepEqual(collectChatWorkflowAgentInputs(manager.getEntries()), [{
    entryId,
    schemaVersion: 2,
    invocationId: "invocation-1",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
    inputEntryIds: [userEntryId],
  }]);
  assert.equal(JSON.stringify(manager.getEntry(entryId)).includes("original request"), false);
  assert.deepEqual(manager.buildSessionContext().messages, [
    { role: "user", content: "original request", timestamp: 1 },
  ]);
});

test("legacy value-copying entries remain readable only for migration compatibility", () => {
  const manager = SessionManager.inMemory("/workspace");
  const inputId = manager.appendCustomEntry("chat.workflow_agent_input", {
    schemaVersion: 1,
    invocationId: "legacy",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
    userPrompt: "legacy request",
  });
  const message = assistantMessage("legacy plan");
  const messageId = manager.appendCustomEntry("chat.workflow_message", {
    schemaVersion: 1,
    invocationId: "legacy",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
    message,
  });
  assert.equal(collectChatWorkflowAgentInputs(manager.getEntries())[0].entryId, inputId);
  assert.deepEqual(collectChatWorkflowMessages(manager.getEntries()), [{
    entryId: messageId,
    schemaVersion: 1,
    invocationId: "legacy",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
    message,
  }]);
  assert.deepEqual(manager.buildSessionContext().messages, []);
});

test("future or incomplete Workflow Stage schemas stay ordinary Pi entries", () => {
  const entries = [
    {
      type: "custom", id: "future", customType: "chat.workflow_stage",
      data: { schemaVersion: 3, invocationId: "i", workflowId: "w", stageId: "s", nodeKind: "agent", agentId: "a" },
    },
    {
      type: "custom", id: "incomplete", customType: "chat.workflow_stage",
      data: { schemaVersion: 2, workflowId: "future-workflow" },
    },
  ];
  assert.deepEqual(collectChatWorkflowStageMarkers(entries), []);
  assert.deepEqual(collectChatWorkflowStageEntryIds(entries), ["future", "incomplete"]);
});
