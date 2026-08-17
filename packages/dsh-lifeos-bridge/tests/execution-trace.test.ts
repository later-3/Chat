import assert from "node:assert/strict";
import test from "node:test";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { executionTraceDtoSchema, type ExecutionTraceDto } from "@chat/contracts/public";
import { ChatProductClient } from "../src/chat-client.ts";
import { executionTraceRoot } from "../src/client/execution-trace-definition.ts";
import { LIFEOS_EXECUTION_TRACE_EVENT } from "../src/execution-trace-events.ts";
import { ExecutionTraceRecorder } from "../src/execution-trace-recorder.ts";

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
    ],
    truncated: false,
  });
}

test("execution trace becomes a recursive native trajectory tool tree", () => {
  const root = executionTraceRoot(trace(), 12);
  assert.equal("kind" in root && root.kind, "tool-result");
  assert.equal(root.subCalls.length, 2);
  const planning = root.subCalls.find(
    (item) => ("kind" in item ? item.call?.name : item.name) === "任务规划",
  );
  assert.ok(planning !== undefined);
  assert.equal(planning.subCalls.length, 1);
  assert.equal(planning.subCalls[0]?.subCalls.length, 2);
  const serialized = JSON.stringify(root);
  assert.match(serialized, /submit_plan_candidate/u);
  assert.match(serialized, /promptTokens/u);
  assert.match(serialized, /Vercel Workflow Runtime/u);
  assert.doesNotMatch(
    serialized,
    /workflowRunId|hookToken|piSessionId|providerRequestId|"prompt"|"payload"/u,
  );
});

test("recorder appends start/update once per trace revision", async () => {
  const session = Session.create(SessionId("session-trace-test"));
  let current = trace();
  const client = new ChatProductClient(
    new URL("http://127.0.0.1:43111"),
    async () => new Response(JSON.stringify(current), { status: 200 }),
  );
  const recorder = new ExecutionTraceRecorder(client, { get: () => session } as never);
  await recorder.record(String(session.id), String(current.productRunId));
  await recorder.record(String(session.id), String(current.productRunId));
  current = trace("b".repeat(64));
  await recorder.record(String(session.id), String(current.productRunId));
  const events = session.events.filter((event) => event.type === LIFEOS_EXECUTION_TRACE_EVENT);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.data.eventKind, "start");
  assert.equal(events[1]?.data.eventKind, "update");
});
