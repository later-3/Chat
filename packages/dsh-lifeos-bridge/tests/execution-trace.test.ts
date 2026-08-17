import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCallBlock } from "@deepseek-ai/dsh-client-runtime/client";
import { executionTraceDtoSchema, type ExecutionTraceDto } from "@chat/contracts/public";
import {
  createExecutionTraceDefinition,
  executionTraceRoot,
} from "../src/client/execution-trace-definition.ts";

function trace(revision = "a".repeat(64)): ExecutionTraceDto {
  return executionTraceDtoSchema.parse({
    schemaVersion: "chat-execution-trace.v1",
    productRunId: "run_trace1",
    traceRevision: revision,
    updatedAt: "2026-08-17T08:00:04.000Z",
    run: {
      status: "succeeded",
      phase: "completed",
      createdAt: "2026-08-17T08:00:00.000Z",
      updatedAt: "2026-08-17T08:00:04.000Z",
    },
    workflow: {
      title: "生存计划",
      nodeRuns: [
        {
          workflowNodeRunId: "wnr_plan1",
          definitionNodeId: "plan",
          nodeType: "agent.plan",
          title: "任务规划",
          kind: "task",
          optional: false,
          executionPath: [],
          attemptNumber: 1,
          status: "succeeded",
          publicSummary: "计划已生成",
          startedAt: "2026-08-17T08:00:01.000Z",
          finishedAt: "2026-08-17T08:00:03.000Z",
          durationMs: 2_000,
          revision: 2,
          updatedAt: "2026-08-17T08:00:03.000Z",
          allowedActions: ["inspect"],
        },
        {
          workflowNodeRunId: "wnr_review1",
          definitionNodeId: "review",
          nodeType: "human.plan_review",
          title: "审核计划",
          kind: "human_review",
          optional: false,
          executionPath: [],
          attemptNumber: 1,
          status: "succeeded",
          publicSummary: "计划已批准",
          outcomeCode: "approve",
          startedAt: "2026-08-17T08:00:03.050Z",
          finishedAt: "2026-08-17T08:00:03.100Z",
          durationMs: 50,
          revision: 2,
          updatedAt: "2026-08-17T08:00:03.100Z",
          allowedActions: ["inspect"],
        },
        {
          workflowNodeRunId: "wnr_execute1",
          definitionNodeId: "execute",
          nodeType: "execute.plan_step",
          title: "执行计划",
          kind: "task",
          optional: false,
          executionPath: [],
          attemptNumber: 1,
          status: "succeeded",
          publicSummary: "计划执行完成",
          startedAt: "2026-08-17T08:00:03.200Z",
          finishedAt: "2026-08-17T08:00:03.900Z",
          durationMs: 700,
          revision: 2,
          updatedAt: "2026-08-17T08:00:03.900Z",
          allowedActions: ["inspect"],
        },
      ],
    },
    runtime: {
      schemaVersion: "chat-workflow-runtime-trace.v1",
      productRunId: "run_trace1",
      sourceKind: "vercel_workflow",
      availability: "available",
      workflowName: "planningExecutionWorkflow",
      runtimeStatus: "completed",
      isLive: false,
      refreshAfterMs: null,
      refreshedAt: "2026-08-17T08:00:04.000Z",
      createdAt: "2026-08-17T08:00:00.000Z",
      startedAt: "2026-08-17T08:00:00.100Z",
      completedAt: "2026-08-17T08:00:04.000Z",
      durationMs: 4_000,
      knownDurationMs: 4_000,
      eventCount: 3,
      truncated: false,
      spans: [
        {
          spanKey: "runtime-run-0",
          sequence: 0,
          kind: "run",
          name: "planningExecutionWorkflow",
          status: "completed",
          createdAt: "2026-08-17T08:00:00.000Z",
          startedAt: "2026-08-17T08:00:00.100Z",
          completedAt: "2026-08-17T08:00:04.000Z",
          offsetMs: 0,
          durationMs: 4_000,
          segments: [{ status: "completed", offsetMs: 0, durationMs: 4_000 }],
          eventSequences: [1],
        },
        {
          spanKey: "runtime-step-1",
          sequence: 1,
          kind: "step",
          name: "invokePlanner",
          status: "completed",
          attempt: 1,
          createdAt: "2026-08-17T08:00:01.000Z",
          startedAt: "2026-08-17T08:00:01.100Z",
          completedAt: "2026-08-17T08:00:03.000Z",
          offsetMs: 1_000,
          durationMs: 2_000,
          segments: [{ status: "completed", offsetMs: 0, durationMs: 2_000 }],
          eventSequences: [2, 3],
        },
      ],
      events: [
        {
          sequence: 1,
          type: "run_created",
          resourceKind: "run",
          spanKey: "runtime-run-0",
          recordedAt: "2026-08-17T08:00:00.000Z",
          offsetMs: 0,
        },
      ],
    },
    piActivities: [
      {
        activityKey: "pi-agent-1",
        sequence: 1,
        kind: "agent",
        label: "规划 Agent",
        status: "succeeded",
        nodeKind: "planner",
        startedAt: "2026-08-17T08:00:01.100Z",
        completedAt: "2026-08-17T08:00:02.900Z",
        durationMs: 1_800,
      },
      {
        activityKey: "pi-model-1",
        parentActivityKey: "pi-agent-1",
        sequence: 2,
        kind: "model",
        label: "模型调用：bailian/qwen3.7-plus",
        status: "succeeded",
        nodeKind: "planner",
        provider: "bailian",
        model: "qwen3.7-plus",
        startedAt: "2026-08-17T08:00:01.200Z",
        completedAt: "2026-08-17T08:00:02.000Z",
        durationMs: 800,
        tokenUsage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      },
      {
        activityKey: "pi-tool-1",
        parentActivityKey: "pi-agent-1",
        sequence: 3,
        kind: "tool",
        label: "工具：submit_plan_candidate",
        status: "succeeded",
        nodeKind: "planner",
        toolName: "submit_plan_candidate",
        startedAt: "2026-08-17T08:00:02.100Z",
        completedAt: "2026-08-17T08:00:02.200Z",
        durationMs: 100,
      },
      {
        activityKey: "pi-agent-2",
        sequence: 4,
        kind: "agent",
        label: "执行 Agent",
        status: "succeeded",
        nodeKind: "executor",
        startedAt: "2026-08-17T08:00:03.250Z",
        completedAt: "2026-08-17T08:00:03.850Z",
        durationMs: 600,
      },
      {
        activityKey: "pi-model-2",
        parentActivityKey: "pi-agent-2",
        sequence: 5,
        kind: "model",
        label: "模型调用：bailian/qwen3.7-plus",
        status: "succeeded",
        nodeKind: "executor",
        provider: "bailian",
        model: "qwen3.7-plus",
        startedAt: "2026-08-17T08:00:03.300Z",
        completedAt: "2026-08-17T08:00:03.700Z",
        durationMs: 400,
        tokenUsage: { promptTokens: 180, completionTokens: 40, totalTokens: 220 },
      },
      {
        activityKey: "pi-tool-2",
        parentActivityKey: "pi-agent-2",
        sequence: 6,
        kind: "tool",
        label: "工具：submit_execution_result",
        status: "succeeded",
        nodeKind: "executor",
        toolName: "submit_execution_result",
        startedAt: "2026-08-17T08:00:03.720Z",
        completedAt: "2026-08-17T08:00:03.750Z",
        durationMs: 30,
      },
    ],
    truncated: false,
  });
}

function assertTerminalSummaries(value: ToolCallBlock): void {
  if ("kind" in value) assert.ok(value.content.length > 0);
  for (const child of value.subCalls) assertTerminalSummaries(child);
}

function blockName(value: ToolCallBlock): string {
  return "kind" in value ? (value.call?.name ?? value.callId) : value.name;
}

test("execution trace becomes a recursive native trajectory tool tree", () => {
  const root = executionTraceRoot(trace(), 12);
  assert.equal("kind" in root && root.kind, "tool-result");
  assert.equal(root.subCalls.length, 3);
  assert.match(blockName(root), /^Workflow · 生存计划$/u);
  const planning = root.subCalls.find((item) => blockName(item).endsWith("任务规划"));
  assert.ok(planning !== undefined);
  assert.equal(planning.subCalls.length, 1);
  assert.equal(planning.subCalls[0]?.subCalls.length, 2);
  assert.match(blockName(planning), /├─.*任务规划/u);
  assert.match(blockName(planning.subCalls[0]!), /│.*└─.*规划 Agent/u);
  assert.match(blockName(planning.subCalls[0]!.subCalls[0]!), /│.*├─.*规划 Agent · 模型/u);
  assert.match(blockName(planning.subCalls[0]!.subCalls[1]!), /│.*└─.*规划 Agent · 工具/u);
  const execution = root.subCalls.find((item) => blockName(item).endsWith("执行计划"));
  assert.ok(execution !== undefined);
  assert.equal(execution.subCalls.length, 1);
  assert.equal(execution.subCalls[0]?.subCalls.length, 2);
  assert.match(blockName(execution), /└─.*执行计划/u);
  assert.match(blockName(execution.subCalls[0]!), /└─.*执行 Agent/u);
  assertTerminalSummaries(root);
  const serialized = JSON.stringify(root);
  assert.match(serialized, /submit_plan_candidate/u);
  assert.match(serialized, /submit_execution_result/u);
  assert.match(serialized, /规划 Agent · 模型/u);
  assert.match(serialized, /执行 Agent · 工具/u);
  assert.match(serialized, /120 tokens（输入 100 \/ 输出 20）/u);
  assert.match(serialized, /成功 · 1 次模型 · 1 次工具 · 220 tokens/u);
  assert.match(serialized, /decision.*批准/u);
  assert.match(serialized, /startedAt.*2026-08-17T08:00:01.100Z/u);
  assert.match(serialized, /promptTokens/u);
  assert.match(serialized, /3 个 Workflow 节点/u);
  assert.doesNotMatch(serialized, /Vercel Workflow Runtime|invokePlanner|runtime-step/u);
  assert.equal(trace().runtime.availability, "available");
  assert.doesNotMatch(
    serialized,
    /workflowRunId|hookToken|piSessionId|providerRequestId|"prompt"|"payload"/u,
  );
});

test("execution trace timestamps are a projection-only optional preference", () => {
  const compact = executionTraceRoot(trace(), 12);
  const timestamped = executionTraceRoot(trace(), 12, { showTimestamps: true });
  const compactText = JSON.stringify(compact);
  const timestampedText = JSON.stringify(timestamped);
  assert.doesNotMatch(compactText, /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} →/u);
  assert.match(
    timestampedText,
    /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} → \d{2}:\d{2}:\d{2}\.\d{3}\]/u,
  );
  assert.match(timestampedText, /规划 Agent/u);
  assert.match(timestampedText, /执行 Agent/u);
  assert.equal(trace().updatedAt, "2026-08-17T08:00:04.000Z");
});

test("definition anchors an external trace to the real user message without custom log events", () => {
  const current = trace();
  const definition = createExecutionTraceDefinition((messageId) =>
    messageId === "msg_dsh_trace1" ? current : undefined,
  );
  const matched = definition.match({
    type: "user/message",
    seq: 7,
    time: Date.parse("2026-08-17T08:00:00.000Z"),
    data: {
      id: "msg_dsh_trace1",
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: "执行工作流" }],
    },
    surfaceOp: "append",
  } as never);
  assert.deepEqual(matched, { id: "run_trace1", role: "start" });
  assert.equal(
    definition.match({
      type: "user/message",
      seq: 8,
      time: Date.now(),
      data: {
        id: "msg_unbound",
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: "普通DSH消息" }],
      },
      surfaceOp: "append",
    } as never),
    null,
  );
});
