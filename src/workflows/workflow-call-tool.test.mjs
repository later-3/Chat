import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createWorkflowCallTool } from "./workflow-call-tool.ts";

function context(purpose = "execution") {
  return {
    purpose,
    projectId: "project-1",
    chatHome: "/tmp/chat-home",
    cwd: "/tmp/project",
    sessionManager: SessionManager.inMemory("/tmp/project"),
    workflowId: "planner-orchestrator",
    workflowInvocationId: "parent-invocation",
    stageId: "delegate",
    agentId: "coordinator",
  };
}

function runtime(overrides = {}) {
  const unavailable = async () => {
    throw new Error("unexpected Workflow Call operation");
  };
  return {
    describe: unavailable,
    start: unavailable,
    wait: unavailable,
    cancel: unavailable,
    ...overrides,
  };
}

test("workflow_call is a parallel Pi Tool and forwards exact parent provenance", async () => {
  const calls = [];
  const updates = [];
  const toolContext = context();
  const tool = createWorkflowCallTool(toolContext, runtime({
    start: async (input) => {
      calls.push(input);
      return {
        status: "completed",
        callId: "call-1",
        workflowId: input.targetWorkflowId,
        runId: "run-1",
        workflowInvocationId: "child-invocation",
        sessionId: "child-session",
        startedAt: "2026-09-03T00:00:00.000Z",
        completedAt: "2026-09-03T00:00:01.000Z",
        durationMs: 1_000,
        text: "child result",
        model: null,
      };
    },
  }));
  const result = await tool.execute("tool-call-1", {
    action: "start",
    workflowId: "minimal-pi-coding-agent",
    prompt: "independent work package",
    agents: [{ agentId: "pi-coding-agent", tools: [], skills: [] }],
  }, undefined, (update) => updates.push(update));

  assert.equal(tool.executionMode, "parallel");
  assert.match(tool.description, /`minimal-pi-coding-agent` \(直接执行\)/);
  assert.match(tool.description, /`planning-execution` \(规划执行\)/);
  assert.match(tool.description, /`planner-orchestrator` \(规划协调\)/);
  assert.match(tool.description, /`memory` \(长期记忆\)/);
  assert.match(JSON.stringify(tool.parameters), /minimal-pi-coding-agent/);
  assert.match(JSON.stringify(tool.parameters), /memory/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].parentSessionManager, toolContext.sessionManager);
  assert.equal(typeof calls[0].onProgress, "function");
  const { onProgress: _onProgress, ...forwarded } = calls[0];
  assert.deepEqual({ ...forwarded, parentSessionManager: undefined }, {
    projectId: "project-1",
    chatHome: "/tmp/chat-home",
    cwd: "/tmp/project",
    parentSessionManager: undefined,
    parentWorkflowId: "planner-orchestrator",
    parentWorkflowInvocationId: "parent-invocation",
    parentStageId: "delegate",
    parentAgentId: "coordinator",
    toolCallId: "tool-call-1",
    targetWorkflowId: "minimal-pi-coding-agent",
    prompt: "independent work package",
    agents: [{ agentId: "pi-coding-agent", tools: [], skills: [] }],
  });
  assert.match(result.content[0].text, /child-session/);
  assert.match(result.content[0].text, /child result/);
  assert.equal(updates.length, 0);
});

test("workflow_call projects execution progress through Pi onUpdate", async () => {
  const updates = [];
  const tool = createWorkflowCallTool(context(), runtime({
    start: async (input) => {
      input.onProgress({
        callId: "call-2",
        workflowId: input.targetWorkflowId,
        workflowInvocationId: "child-invocation",
        sessionId: "child-session",
        runId: "child-run",
        status: "running",
        phase: "child_tool",
        stageId: "execute",
        agentId: "worker",
        childToolName: "bash",
        startedAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:01.000Z",
        elapsedMs: 1_000,
      });
      return {
        status: "completed",
        callId: "call-2",
        workflowId: input.targetWorkflowId,
        runId: "child-run",
        workflowInvocationId: "child-invocation",
        sessionId: "child-session",
        startedAt: "2026-09-03T00:00:00.000Z",
        completedAt: "2026-09-03T00:00:02.000Z",
        durationMs: 2_000,
        text: "done",
        model: null,
      };
    },
  }));

  await tool.execute("tool-call-2", {
    action: "start",
    workflowId: "minimal-pi-coding-agent",
    prompt: "run tests",
    agents: [{ agentId: "pi-coding-agent", tools: [], skills: [] }],
  }, undefined, (update) => updates.push(update));

  assert.equal(updates.length, 1);
  assert.match(updates[0].content[0].text, /bash · 1000ms/);
  assert.equal(updates[0].details.phase, "child_tool");
  assert.equal(updates[0].details.runId, "child-run");
});

test("workflow_call exposes every eligible Workflow target, including its own definition", () => {
  const directContext = {
    ...context("inspection"),
    workflowId: "minimal-pi-coding-agent",
    stageId: "execute",
    agentId: "pi-coding-agent",
  };
  const tool = createWorkflowCallTool(directContext);
  const modelVisibleDefinition = `${tool.description}\n${tool.promptSnippet}\n${JSON.stringify(tool.parameters)}`;

  assert.match(modelVisibleDefinition, /`memory` \(长期记忆\)/);
  assert.match(modelVisibleDefinition, /由Memory Agent按用户的明确指令管理长期记忆/);
  assert.match(modelVisibleDefinition, /`minimal-pi-coding-agent` \(直接执行\)/);
  assert.match(modelVisibleDefinition, /`planning-execution` \(规划执行\)/);
  assert.match(modelVisibleDefinition, /`planner-orchestrator` \(规划协调\)/);
  assert.match(modelVisibleDefinition, /describe|start|wait|cancel/);
});

test("workflow_call returns a resumable handle and dispatches wait and cancel by callId", async () => {
  const operations = [];
  const toolContext = context();
  const tool = createWorkflowCallTool(toolContext, runtime({
    start: async (input) => {
      operations.push(["start", input]);
      return {
        status: "running",
        callId: "call-running",
        workflowId: input.targetWorkflowId,
        runId: "run-running",
        workflowInvocationId: "invocation-running",
        sessionId: "session-running",
        startedAt: "2026-09-03T00:00:00.000Z",
        observedAt: "2026-09-03T00:00:00.010Z",
        elapsedMs: 10,
        waitTimeoutMs: input.waitTimeoutMs,
      };
    },
    wait: async (input) => {
      operations.push(["wait", input]);
      return {
        status: "running",
        callId: input.callId,
        workflowId: "minimal-pi-coding-agent",
        runId: "run-running",
        workflowInvocationId: "invocation-running",
        sessionId: "session-running",
        startedAt: "2026-09-03T00:00:00.000Z",
        observedAt: "2026-09-03T00:00:00.030Z",
        elapsedMs: 30,
        waitTimeoutMs: input.waitTimeoutMs,
      };
    },
    cancel: async (input) => {
      operations.push(["cancel", input]);
      return {
        status: "cancelled",
        callId: input.callId,
        workflowId: "minimal-pi-coding-agent",
        runId: "run-running",
        workflowInvocationId: "invocation-running",
        sessionId: "session-running",
        startedAt: "2026-09-03T00:00:00.000Z",
        cancelledAt: "2026-09-03T00:00:00.040Z",
        durationMs: 40,
      };
    },
  }));

  const started = await tool.execute("tool-start", {
    action: "start",
    workflowId: "minimal-pi-coding-agent",
    prompt: "long task",
    agents: [{ agentId: "pi-coding-agent", tools: [], skills: [] }],
    waitTimeoutMs: 10,
  });
  const waited = await tool.execute("tool-wait", {
    action: "wait",
    callId: "call-running",
    waitTimeoutMs: 20,
  });
  const cancelled = await tool.execute("tool-cancel", {
    action: "cancel",
    callId: "call-running",
  });

  assert.match(started.content[0].text, /status=running|still running/);
  assert.match(started.content[0].text, /action=wait/);
  assert.match(waited.content[0].text, /call-running/);
  assert.match(cancelled.content[0].text, /was cancelled/);
  assert.deepEqual(operations.map(([operation]) => operation), ["start", "wait", "cancel"]);
  assert.equal(operations[0][1].waitTimeoutMs, 10);
  assert.equal(operations[1][1].waitTimeoutMs, 20);
  assert.equal(operations[2][1].parentSessionManager, toolContext.sessionManager);
});

test("workflow_call cannot execute from Agent inspection", async () => {
  const tool = createWorkflowCallTool(context("inspection"), runtime());
  await assert.rejects(
    tool.execute("tool-call-1", {
      action: "start",
      workflowId: "minimal-pi-coding-agent",
      prompt: "work",
      agents: [{ agentId: "pi-coding-agent", tools: [], skills: [] }],
    }),
    /检查期间不能调用Workflow/,
  );
});

test("workflow_call describe exposes exact selectable capability names", async () => {
  const tool = createWorkflowCallTool(context(), runtime({
    describe: async (input) => ({
      status: "described",
      workflowId: input.targetWorkflowId,
      name: "直接执行",
      description: "执行任务",
      agents: [{
        agentId: "pi-coding-agent",
        name: "Pi Coding Agent",
        description: "执行Agent",
        tools: [{ name: "read", address: "runtime:tool/read", description: "读取文件" }],
        skills: [{ name: "review", address: "project/p:skill/review", description: "审查代码" }],
      }],
    }),
  }));

  const result = await tool.execute("tool-describe", {
    action: "describe",
    workflowId: "minimal-pi-coding-agent",
  });

  assert.match(result.content[0].text, /Agent pi-coding-agent/);
  assert.match(result.content[0].text, /read: 读取文件/);
  assert.match(result.content[0].text, /review: 审查代码/);
  assert.equal(result.details.status, "described");
});
