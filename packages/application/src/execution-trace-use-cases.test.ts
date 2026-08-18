import { describe, expect, it } from "vitest";
import { traceEventSchema, workflowRuntimeTraceDtoSchema, type TraceEvent } from "@chat/contracts";
import { hashCanonical } from "@chat/domain";
import {
  executedWorkflowNodeRuns,
  projectPiActivities,
  runtimeRevisionValue,
} from "./execution-trace-use-cases.js";

const common = {
  schemaVersion: 1,
  level: "info",
  traceId: "trc_pi1",
  productRunId: "run_pi1",
  attemptId: "att_pi1",
  promptTemplateVersion: "planner.v1",
  modelConfigVersion: "model.v1",
};

function event(value: Record<string, unknown>): TraceEvent {
  return traceEventSchema.parse({ ...common, ...value });
}

describe("Pi execution trace projection", () => {
  it("does not turn queued definitions or skipped optional nodes into execution records", () => {
    expect(
      executedWorkflowNodeRuns([
        { status: "succeeded", title: "任务规划" },
        { status: "queued", title: "执行计划" },
        { status: "queued", title: "读取记忆" },
        { status: "skipped", title: "读取记忆" },
      ]),
    ).toEqual([{ status: "succeeded", title: "任务规划" }]);
  });

  it("omits absent runtime timestamps before canonical revision hashing", () => {
    const runtime = workflowRuntimeTraceDtoSchema.parse({
      schemaVersion: "chat-workflow-runtime-trace.v1",
      productRunId: "run_pi1",
      sourceKind: "vercel_workflow",
      availability: "available",
      workflowName: "planning-execution",
      runtimeStatus: "running",
      isLive: true,
      refreshAfterMs: 750,
      refreshedAt: "2026-08-17T08:00:00.000Z",
      createdAt: "2026-08-17T08:00:00.000Z",
      durationMs: 0,
      knownDurationMs: 0,
      eventCount: 1,
      truncated: false,
      spans: [
        {
          spanKey: "runtime-run-1",
          sequence: 0,
          kind: "run",
          name: "planning-execution",
          status: "running",
          createdAt: "2026-08-17T08:00:00.000Z",
          offsetMs: 0,
          durationMs: 0,
          segments: [],
          eventSequences: [1],
        },
      ],
      events: [
        {
          sequence: 1,
          type: "run_created",
          resourceKind: "run",
          spanKey: "runtime-run-1",
          recordedAt: "2026-08-17T08:00:00.000Z",
          offsetMs: 0,
        },
      ],
    });

    expect(() =>
      hashCanonical("execution-trace-projection.v1", runtimeRevisionValue(runtime)),
    ).not.toThrow();
  });

  it("projects Agent, model and tool without private payloads", () => {
    const values = projectPiActivities(
      [
        event({
          eventId: "evt_pi1",
          timestamp: "2026-08-17T08:00:00.000Z",
          spanId: "span_pi1",
          eventName: "pi.node.started",
          outcome: "unknown",
          nodeKind: "executor",
        }),
        event({
          eventId: "evt_pi2",
          timestamp: "2026-08-17T08:00:00.100Z",
          spanId: "span_pi2",
          eventName: "provider.request.started",
          outcome: "unknown",
          provider: "bailian",
          model: "qwen3.7-plus",
          endpointHost: "dashscope.aliyuncs.com",
          operation: "chat_completion",
          inputManifestSha256: "a".repeat(64),
        }),
        event({
          eventId: "evt_pi3",
          timestamp: "2026-08-17T08:00:00.900Z",
          spanId: "span_pi3",
          eventName: "provider.request.completed",
          outcome: "success",
          provider: "bailian",
          model: "qwen3.7-plus",
          endpointHost: "dashscope.aliyuncs.com",
          operation: "chat_completion",
          httpStatus: 200,
          providerRequestId: "provider-1",
          tokenUsage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
          inputManifestSha256: "a".repeat(64),
          durationMs: 800,
        }),
        event({
          eventId: "evt_pi4",
          timestamp: "2026-08-17T08:00:01.000Z",
          spanId: "span_pi4",
          eventName: "pi.tool.intent_persisted",
          outcome: "unknown",
          piOperationId: "pio_op1",
          operationEventSequence: 4,
          sourceTimestamp: "2026-08-17T08:00:01.000Z",
          piRuntimeSessionId: "pis_session-1",
          turnIndex: 0,
          toolCallId: "call_1",
          toolName: "bash",
          inputSha256: "b".repeat(64),
          inputDisplay: '{"command":"node --version"}',
          inputDisplayTruncated: false,
        }),
        event({
          eventId: "evt_pi5",
          timestamp: "2026-08-17T08:00:01.100Z",
          spanId: "span_pi5",
          eventName: "pi.tool.completed",
          outcome: "success",
          piOperationId: "pio_op1",
          operationEventSequence: 5,
          sourceTimestamp: "2026-08-17T08:00:01.100Z",
          piRuntimeSessionId: "pis_session-1",
          turnIndex: 0,
          toolCallId: "call_1",
          toolName: "bash",
          resultSha256: "c".repeat(64),
          resultDisplay: "v24.0.0",
          resultDisplayTruncated: false,
          durationMs: 100,
        }),
        event({
          eventId: "evt_pi6",
          timestamp: "2026-08-17T08:00:01.200Z",
          spanId: "span_pi6",
          eventName: "pi.node.completed",
          outcome: "success",
          nodeKind: "executor",
          durationMs: 1_200,
        }),
      ],
      new Map([["att_pi1", { workflowNodeRunId: "wnr_pi1" as never, executionStepId: "step_1" }]]),
    );
    expect(values.map((item) => item.kind)).toEqual(["agent", "model", "tool"]);
    expect(values[1]).toMatchObject({
      parentActivityKey: "pi-agent-1",
      attemptId: "att_pi1",
      workflowNodeRunId: "wnr_pi1",
      executionStepId: "step_1",
      tokenUsage: { totalTokens: 12 },
    });
    expect(values[2]).toMatchObject({
      parentActivityKey: "pi-agent-1",
      toolName: "bash",
    });
    expect(JSON.stringify(values)).not.toContain("provider-1");
    expect(JSON.stringify(values)).not.toContain("inputManifestSha256");
  });
});
