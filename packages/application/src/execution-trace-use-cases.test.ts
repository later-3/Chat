import { describe, expect, it } from "vitest";
import {
  runActivityEventSchema,
  workflowRuntimeTraceDtoSchema,
  type RunActivityEvent,
  type RunActivityEventInput,
} from "@chat/contracts";
import { hashCanonical } from "@chat/domain";
import {
  executedWorkflowNodeRuns,
  boundPiActivities,
  projectPiActivities,
  runtimeRevisionValue,
} from "./execution-trace-use-cases.js";

let activitySequence = 0;
type TestActivityInput = RunActivityEventInput extends infer Event
  ? Event extends RunActivityEventInput
    ? Omit<Event, "productRunId" | "attemptId" | "sourceKind" | "sourceKey">
    : never
  : never;
function event(value: TestActivityInput): RunActivityEvent {
  activitySequence += 1;
  return runActivityEventSchema.parse({
    schemaVersion: "chat-run-activity.v1",
    sequence: activitySequence,
    productRunId: "run_pi1",
    attemptId: "att_pi1",
    sourceKind: "pi_executor",
    sourceOperationId: "pio_projection1",
    sourceSequence: activitySequence,
    sourceKey: `test:${String(activitySequence)}`,
    ...value,
  });
}

describe("Pi execution trace projection", () => {
  it("bounds long activity history without orphaning model/tool children", () => {
    const activities = Array.from({ length: 300 }, (_, index) => {
      const agentSequence = index * 2 + 1;
      const agent = {
        activityKey: `pi-agent-${String(index + 1)}`,
        attemptId: "att_pi1",
        sequence: agentSequence,
        kind: "agent",
        label: "执行 Agent",
        status: "succeeded",
        nodeKind: "executor",
        startedAt: "2026-08-21T00:00:00.000Z",
      } as const;
      const model = {
        activityKey: `pi-model-${String(index + 1)}`,
        parentActivityKey: agent.activityKey,
        attemptId: "att_pi1",
        sequence: agentSequence + 1,
        kind: "model",
        label: "模型调用",
        status: "succeeded",
        nodeKind: "executor",
        startedAt: "2026-08-21T00:00:00.000Z",
      } as const;
      return [agent, model];
    }).flat() as never;
    const bounded = boundPiActivities(activities);
    expect(bounded.truncated).toBe(true);
    expect(bounded.items).toHaveLength(500);
    const keys = new Set(bounded.items.map((activity) => activity.activityKey));
    for (const activity of bounded.items) {
      if (activity.parentActivityKey !== undefined) {
        expect(keys.has(activity.parentActivityKey)).toBe(true);
      }
    }
  });

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
    activitySequence = 0;
    const values = projectPiActivities(
      [
        event({
          timestamp: "2026-08-17T08:00:00.000Z",
          activityType: "agent",
          phase: "started",
          nodeKind: "executor",
        }),
        event({
          timestamp: "2026-08-17T08:00:00.100Z",
          activityType: "model",
          phase: "started",
          nodeKind: "executor",
          provider: "bailian",
          model: "qwen3.7-plus",
        }),
        event({
          timestamp: "2026-08-17T08:00:00.900Z",
          activityType: "model",
          phase: "completed",
          nodeKind: "executor",
          provider: "bailian",
          model: "qwen3.7-plus",
          tokenUsage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
          durationMs: 800,
        }),
        event({
          timestamp: "2026-08-17T08:00:01.000Z",
          activityType: "tool",
          phase: "started",
          nodeKind: "executor",
          toolCallId: "call_1",
          toolName: "bash",
          inputDisplay: '{"command":"node --version"}',
          inputDisplayTruncated: false,
        }),
        event({
          timestamp: "2026-08-17T08:00:01.100Z",
          activityType: "tool",
          phase: "completed",
          nodeKind: "executor",
          toolCallId: "call_1",
          toolName: "bash",
          resultDisplay: "v24.0.0",
          resultDisplayTruncated: false,
          durationMs: 100,
        }),
        event({
          timestamp: "2026-08-17T08:00:01.200Z",
          activityType: "agent",
          phase: "completed",
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
      inputDisplay: '{"command":"node --version"}',
      resultDisplay: "v24.0.0",
    });
    expect(JSON.stringify(values)).not.toContain("provider-1");
    expect(JSON.stringify(values)).not.toContain("inputManifestSha256");
  });
});
