import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  callChatWorkflow,
  cancelActiveChatWorkflowCall,
  MAX_CHAT_SUBWORKFLOW_DEPTH,
  waitForChatWorkflowCall,
} from "./workflow-call.ts";
import { MAX_CHAT_WORKFLOW_CALL_WAIT_TIMEOUT_MS } from "./workflow-call-contract.ts";
import { MAX_ACTIVE_CHAT_WORKFLOW_CALLS_PER_PARENT } from "./workflow-call-capacity.ts";
import { appendChatSubsessionRelation, appendChatWorkflowCall } from "./workflow-call-state.ts";

function callInput(manager, overrides = {}) {
  return {
    projectId: "workflow-call-test",
    chatHome: "/tmp/workflow-call-test-home",
    cwd: process.cwd(),
    parentSessionManager: manager,
    parentWorkflowId: "planner-orchestrator",
    parentWorkflowInvocationId: "parent-invocation",
    parentStageId: "delegate",
    parentAgentId: "coordinator",
    toolCallId: "tool-call-1",
    targetWorkflowId: "minimal-pi-coding-agent",
    prompt: "Execute one bounded package.",
    agents: [{ agentId: "pi-coding-agent", tools: [], skills: [] }],
    ...overrides,
  };
}

test("Workflow calls fail closed before creating a child Session for invalid targets", async () => {
  const manager = SessionManager.inMemory(process.cwd());

  await assert.rejects(
    callChatWorkflow(callInput(manager, { targetWorkflowId: "missing-workflow" })),
    /找不到目标Workflow/,
  );
  await assert.rejects(
    callChatWorkflow(callInput(manager, { targetWorkflowId: "rule-management" })),
    /Workflow不允许由Agent调用/,
  );
  await assert.rejects(
    callChatWorkflow(callInput(manager, { prompt: "   " })),
    /子Workflow任务书不能为空/,
  );
  await assert.rejects(
    callChatWorkflow(callInput(manager, {
      waitTimeoutMs: MAX_CHAT_WORKFLOW_CALL_WAIT_TIMEOUT_MS + 1,
    })),
    /Workflow等待超时必须是/,
  );
});

test("Workflow calls enforce the Subsession depth limit from explicit relation state", async () => {
  const manager = SessionManager.inMemory(process.cwd());
  appendChatSubsessionRelation(manager, {
    callId: "parent-call",
    parentSessionId: "ancestor-session",
    childSessionId: manager.getSessionId(),
    depth: MAX_CHAT_SUBWORKFLOW_DEPTH,
    createdAt: "2026-09-03T00:00:00.000Z",
  });

  await assert.rejects(
    callChatWorkflow(callInput(manager)),
    new RegExp(`不能超过${String(MAX_CHAT_SUBWORKFLOW_DEPTH)}`),
  );
});

test("Workflow wait and cancel fail closed for calls not owned by the current parent Session", async () => {
  const manager = SessionManager.inMemory(process.cwd());
  const controlInput = {
    parentSessionManager: manager,
    callId: "another-session-call",
    waitTimeoutMs: 0,
  };

  await assert.rejects(waitForChatWorkflowCall(controlInput), /当前父Session不存在Workflow调用/);
  await assert.rejects(cancelActiveChatWorkflowCall(controlInput), /当前父Session不存在Workflow调用/);
});

test("Workflow start enforces active capacity before reserving another child Session", async () => {
  const manager = SessionManager.inMemory(process.cwd());
  for (let index = 0; index < MAX_ACTIVE_CHAT_WORKFLOW_CALLS_PER_PARENT; index += 1) {
    appendChatWorkflowCall(manager, {
      schemaVersion: 1,
      callId: `active-${String(index)}`,
      toolCallId: `tool-${String(index)}`,
      parent: {
        sessionId: manager.getSessionId(),
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
      status: "running",
      startedAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z",
    });
  }

  await assert.rejects(
    callChatWorkflow(callInput(manager)),
    new RegExp(`不能超过${String(MAX_ACTIVE_CHAT_WORKFLOW_CALLS_PER_PARENT)}`),
  );
});
