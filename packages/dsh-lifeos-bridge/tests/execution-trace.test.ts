import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCallBlock } from "@deepseek-ai/dsh-client-runtime/client";
import {
  workflowExecutionTraceDtoSchema,
  type WorkflowExecutionTraceDto,
} from "@chat/contracts/public";
import {
  createExecutionTraceBindingDefinition,
  createExecutionTraceDefinition,
  executionTraceCallLabels,
  executionTraceCallPreviews,
  executionTraceRoot,
} from "../src/client/execution-trace-definition.ts";

function trace(revision = "a".repeat(64)): WorkflowExecutionTraceDto {
  return workflowExecutionTraceDtoSchema.parse({
    schemaVersion: "chat-workflow-execution-trace.v2",
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
          nodeType: "execute.plan",
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
      nodeDetails: [
        {
          workflowNodeRunId: "wnr_plan1",
          input: [
            {
              label: "planning_context · 用户消息 #1",
              format: "markdown",
              text: "你知道我们现在在做什么项目吗？",
              truncated: false,
            },
          ],
          output: [
            {
              label: "plan · 计划 v1",
              format: "json",
              text: '{"objective":"说明当前项目"}',
              truncated: false,
            },
          ],
        },
        {
          workflowNodeRunId: "wnr_review1",
          input: [
            {
              label: "review · 计划 v1",
              format: "json",
              text: '{"objective":"说明当前项目"}',
              truncated: false,
            },
          ],
          output: [
            {
              label: "decision · 已批准",
              format: "json",
              text: '{"kind":"approve"}',
              truncated: false,
            },
          ],
        },
        {
          workflowNodeRunId: "wnr_execute1",
          input: [
            {
              label: "execution · 执行合同",
              format: "json",
              text: '{"steps":[{"stepId":"step_1","title":"说明项目"}]}',
              truncated: false,
            },
          ],
          output: [
            {
              label: "candidate · 执行候选结果",
              format: "json",
              text: '{"finalOutput":"Chat项目"}',
              truncated: false,
            },
          ],
        },
      ],
      executionSteps: [
        {
          parentWorkflowNodeRunId: "wnr_execute1",
          stepId: "step_1",
          title: "说明项目",
          status: "succeeded",
          startedAt: "2026-08-17T08:00:03.200Z",
          completedAt: "2026-08-17T08:00:03.900Z",
          durationMs: 700,
          input: [
            {
              label: "执行步骤输入 · 说明项目",
              format: "json",
              text: '{"selectedContextRefs":[],"dependencyRefs":[]}',
              truncated: false,
            },
          ],
          output: [
            {
              label: "执行步骤输出 · 说明项目",
              format: "json",
              text: '{"output":"Chat项目"}',
              truncated: false,
            },
          ],
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
        attemptId: "att_plan1",
        workflowNodeRunId: "wnr_plan1",
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
        attemptId: "att_plan1",
        workflowNodeRunId: "wnr_plan1",
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
        attemptId: "att_plan1",
        workflowNodeRunId: "wnr_plan1",
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
        attemptId: "att_exec1",
        workflowNodeRunId: "wnr_execute1",
        executionStepId: "step_1",
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
        attemptId: "att_exec1",
        workflowNodeRunId: "wnr_execute1",
        executionStepId: "step_1",
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
        attemptId: "att_exec1",
        workflowNodeRunId: "wnr_execute1",
        executionStepId: "step_1",
        sequence: 6,
        kind: "tool",
        label: "工具：submit_execution_result",
        status: "succeeded",
        nodeKind: "executor",
        toolName: "submit_execution_result",
        inputDisplay: '{"stepId":"step_1"}',
        inputDisplayTruncated: false,
        resultDisplay: "执行结果候选已提交",
        resultDisplayTruncated: false,
        startedAt: "2026-08-17T08:00:03.720Z",
        completedAt: "2026-08-17T08:00:03.750Z",
        durationMs: 30,
      },
    ],
    truncated: false,
  });
}

function traceWithMemory(): WorkflowExecutionTraceDto {
  const value = structuredClone(trace()) as unknown as Record<string, unknown>;
  const workflow = value["workflow"] as Record<string, unknown>;
  const nodeRuns = workflow["nodeRuns"] as unknown[];
  const nodeDetails = workflow["nodeDetails"] as unknown[];
  nodeRuns.unshift(
    {
      workflowNodeRunId: "wnr_memoryquery1",
      definitionNodeId: "memory-planning.query",
      nodeType: "memory.query",
      title: "查询记忆",
      kind: "task",
      optional: false,
      executionPath: [],
      attemptNumber: 1,
      status: "succeeded",
      publicSummary: "Memory查询完成，冻结2条快照",
      outcomeCode: "success",
      startedAt: "2026-08-17T08:00:00.100Z",
      finishedAt: "2026-08-17T08:00:00.300Z",
      durationMs: 200,
      revision: 2,
      updatedAt: "2026-08-17T08:00:00.300Z",
      allowedActions: ["inspect"],
    },
    {
      workflowNodeRunId: "wnr_memorywrite1",
      definitionNodeId: "memory-planning.write",
      nodeType: "memory.write",
      title: "保存本次输入",
      kind: "task",
      optional: false,
      executionPath: [],
      attemptNumber: 1,
      status: "succeeded",
      publicSummary: "本次输入已写入并可查询",
      outcomeCode: "materialized",
      startedAt: "2026-08-17T08:00:00.400Z",
      finishedAt: "2026-08-17T08:00:00.700Z",
      durationMs: 300,
      revision: 2,
      updatedAt: "2026-08-17T08:00:00.700Z",
      allowedActions: ["inspect"],
    },
  );
  nodeDetails.unshift(
    {
      workflowNodeRunId: "wnr_memoryquery1",
      input: [],
      output: [
        {
          label: "snapshots · 冻结引用",
          format: "json",
          text: '{"count":2}',
          truncated: false,
        },
      ],
    },
    {
      workflowNodeRunId: "wnr_memorywrite1",
      input: [],
      output: [
        {
          label: "result · 写入状态",
          format: "json",
          text: '{"status":"materialized"}',
          truncated: false,
        },
      ],
    },
  );
  return workflowExecutionTraceDtoSchema.parse(value);
}

function assertTerminalSummaries(value: ToolCallBlock): void {
  if ("kind" in value) assert.ok(value.content.length > 0);
  for (const child of value.subCalls) assertTerminalSummaries(child);
}

function blockName(value: ToolCallBlock): string {
  return "kind" in value ? (value.call?.name ?? value.callId) : value.name;
}

test("execution trace becomes a recursive native trajectory tool tree", () => {
  const current = trace();
  const root = executionTraceRoot(current, 12);
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
  assert.equal(execution.subCalls[0]?.subCalls.length, 1);
  assert.equal(execution.subCalls[0]?.subCalls[0]?.subCalls.length, 2);
  assert.match(blockName(execution), /└─.*执行计划/u);
  assert.match(blockName(execution.subCalls[0]!), /└─.*说明项目/u);
  assert.match(blockName(execution.subCalls[0]!.subCalls[0]!), /└─.*执行 Agent/u);
  assertTerminalSummaries(root);
  const serialized = JSON.stringify(root);
  assert.match(serialized, /submit_plan_candidate/u);
  assert.match(serialized, /submit_execution_result/u);
  assert.match(serialized, /stepId.*step_1/u);
  assert.match(serialized, /执行结果候选已提交/u);
  assert.match(serialized, /规划 Agent · 模型/u);
  assert.match(serialized, /执行 Agent · 工具/u);
  assert.match(serialized, /120 tokens（输入 100 \/ 输出 20）/u);
  assert.match(serialized, /成功 · 1 次模型 · 1 次工具 · 220 tokens/u);
  assert.match(serialized, /decision.*批准/u);
  assert.match(serialized, /startedAt.*2026-08-17T08:00:01.100Z/u);
  assert.match(serialized, /promptTokens/u);
  assert.match(serialized, /3 个 Workflow 节点/u);
  assert.match(serialized, /你知道我们现在在做什么项目吗/u);
  assert.match(serialized, /说明当前项目/u);
  assert.match(serialized, /selectedContextRefs/u);
  assert.match(serialized, /inputNotice.*不是Provider原始Payload/u);
  assert.match(serialized, /runtimeSpans/u);
  assert.equal(trace().runtime.availability, "available");
  assert.doesNotMatch(
    serialized,
    /workflowRunId|hookToken|piSessionId|providerRequestId|"prompt"|"payload"/u,
  );
  const labels = executionTraceCallLabels(current);
  const previews = executionTraceCallPreviews(root);
  assert.equal(labels.get("lifeos-workflow-run_trace1"), "WORKFLOW");
  assert.equal(previews.get("lifeos-workflow-run_trace1")?.input, "");
  assert.match(previews.get("lifeos-node-wnr_plan1")?.output ?? "", /计划/u);
  assert.equal(labels.get("lifeos-node-wnr_plan1"), "NODE");
  assert.equal(labels.get("lifeos-step-wnr_execute1-step_1"), "STEP");
  assert.equal(labels.get("lifeos-pi-agent-1"), "AGENT");
  assert.equal(labels.get("lifeos-pi-model-1"), "MODEL");
  assert.equal(labels.get("lifeos-pi-tool-1"), "TOOL");
});

test("Memory query/write node runs remain first-class nodes in the recursive DSH trajectory", () => {
  const current = traceWithMemory();
  const root = executionTraceRoot(current, 12);
  assert.equal(root.subCalls.length, 5);
  assert.match(blockName(root.subCalls[0]!), /查询记忆/u);
  assert.match(blockName(root.subCalls[1]!), /保存本次输入/u);
  assert.equal(root.subCalls[0]?.callId, "lifeos-node-wnr_memoryquery1");
  assert.equal(root.subCalls[1]?.callId, "lifeos-node-wnr_memorywrite1");
  const serialized = JSON.stringify(root);
  assert.match(serialized, /Memory查询完成，冻结2条快照/u);
  assert.match(serialized, /本次输入已写入并可查询/u);
  assert.match(serialized, /materialized/u);
  assert.doesNotMatch(serialized, /serviceId|teamId|bearer|Memory正文绝不能进入Trajectory/u);
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

test("definitions bind the user message but publish the trace at the following request Step", () => {
  const current = trace();
  const currentValue = {
    dshMessageId: "msg_dsh_trace1",
    boundaries: {
      dsh: {
        dshSessionId: "dsh_session_trace1",
        dshMessageId: "msg_dsh_trace1",
        userTextSha256: "a".repeat(64),
      },
      bridge: {
        messageCommandId: "cmd_trace1",
        productUserMessageId: "msg_product_trace1",
      },
    },
    trace: current,
  } as const;
  const binding = createExecutionTraceBindingDefinition((messageId) =>
    messageId === "msg_dsh_trace1" ? currentValue : undefined,
  );
  const userEvent = {
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
  } as const;
  const matched = binding.match(userEvent as never);
  assert.deepEqual(matched, { id: "run_trace1", role: "start" });
  assert.equal(
    binding.match({
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

  const stepLocation = {
    kind: "step",
    turn: { turn: 1 },
    step: { step: 1 },
  } as const;
  const userMatch = { event: userEvent, location: stepLocation };
  const requestEvent = {
    type: "request/header",
    seq: 11,
    time: Date.parse("2026-08-17T08:00:00.100Z"),
    data: {
      header: { config: { provider: "lifeos", model: "workflow" } },
      reason: "initial",
    },
    surfaceOp: "append",
  } as const;
  const requestMatch = { event: requestEvent, location: stepLocation };
  const definition = createExecutionTraceDefinition();
  assert.deepEqual(definition.match(requestEvent as never), { id: "11", role: "start" });
  const state = definition.start(
    {} as never,
    requestMatch as never,
    {
      previous: (kind: string) =>
        kind === "lifeos-execution-trace-binding"
          ? {
              key: "lifeos-execution-trace-binding:run_trace1",
              kind,
              id: "run_trace1",
              startSeq: 7,
              state: currentValue,
              matches: [userMatch],
            }
          : undefined,
    } as never,
  );
  const node = definition.buildViewNode?.({
    key: "lifeos-execution-trace:11",
    kind: "lifeos-execution-trace",
    id: "11",
    matches: [requestMatch],
    start: requestMatch,
    state,
    current: new Map(),
  } as never);
  assert.ok(node !== null && node !== undefined && "data" in node);
  const trajectoryNode = node as typeof node & {
    readonly anchorSeq: number;
    readonly location: unknown;
    readonly data: {
      readonly kind: "tool";
      readonly root: ToolCallBlock;
      readonly callLabels?: ReadonlyMap<string, string>;
      readonly callPreviews?: ReadonlyMap<
        string,
        { readonly input?: string; readonly output?: string }
      >;
    };
  };
  assert.equal(trajectoryNode.anchorSeq, 11);
  assert.equal(trajectoryNode.location, stepLocation);
  assert.equal(trajectoryNode.data.kind, "tool");
  assert.equal(trajectoryNode.data.root.callId, "lifeos-chat-turn-run_trace1");
  assert.deepEqual(
    trajectoryNode.data.root.subCalls.map((item) => item.callId),
    [
      "lifeos-boundary-dsh-msg_dsh_trace1",
      "lifeos-boundary-bridge-run_trace1",
      "lifeos-backend-run_trace1",
    ],
  );
  assert.equal(trajectoryNode.data.callLabels?.get("lifeos-boundary-dsh-msg_dsh_trace1"), "DSH");
  assert.equal(trajectoryNode.data.callLabels?.get("lifeos-boundary-bridge-run_trace1"), "BRIDGE");
  assert.equal(trajectoryNode.data.callLabels?.get("lifeos-workflow-run_trace1"), "WORKFLOW");
  assert.equal(trajectoryNode.data.callPreviews?.get("lifeos-workflow-run_trace1")?.input, "");
});
