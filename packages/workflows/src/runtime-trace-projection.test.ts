import { describe, expect, it } from "vitest";
import type { LocalWorld } from "@workflow/world-local";
import { buildWorkflowRuntimeTrace } from "./runtime-trace-projection.js";

describe("Vercel Workflow World trace projection", () => {
  it("projects dynamic run and step events without runtime identities or I/O", async () => {
    const events = [
      {
        eventType: "run_created",
        eventData: {
          deploymentId: "deployment-private",
          workflowName: "src/workflow.ts//planningExecutionWorkflow",
          input: { secret: "must-not-leak" },
        },
        runId: "wrun_private",
        eventId: "event-private-1",
        createdAt: new Date("2026-08-17T08:00:00.000Z"),
      },
      {
        eventType: "run_started",
        eventData: {},
        runId: "wrun_private",
        eventId: "event-private-2",
        createdAt: new Date("2026-08-17T08:00:00.100Z"),
      },
      {
        eventType: "step_created",
        eventData: { stepName: "src/steps.ts//invokePlanner", attempt: 1 },
        correlationId: "step-private-1",
        runId: "wrun_private",
        eventId: "event-private-3",
        createdAt: new Date("2026-08-17T08:00:01.000Z"),
      },
      {
        eventType: "step_started",
        eventData: { stepName: "src/steps.ts//invokePlanner", attempt: 1 },
        correlationId: "step-private-1",
        runId: "wrun_private",
        eventId: "event-private-4",
        createdAt: new Date("2026-08-17T08:00:01.100Z"),
      },
      {
        eventType: "step_completed",
        eventData: {
          stepName: "src/steps.ts//invokePlanner",
          attempt: 1,
          output: { secret: "no" },
        },
        correlationId: "step-private-1",
        runId: "wrun_private",
        eventId: "event-private-5",
        createdAt: new Date("2026-08-17T08:00:02.000Z"),
      },
      {
        eventType: "run_completed",
        eventData: { output: { secret: "no" } },
        runId: "wrun_private",
        eventId: "event-private-6",
        createdAt: new Date("2026-08-17T08:00:02.100Z"),
      },
    ];
    const world = {
      runs: {
        get: async () => ({
          runId: "wrun_private",
          workflowName: "src/workflow.ts//planningExecutionWorkflow",
          status: "completed",
          createdAt: new Date("2026-08-17T08:00:00.000Z"),
          startedAt: new Date("2026-08-17T08:00:00.100Z"),
          completedAt: new Date("2026-08-17T08:00:02.100Z"),
          input: { secret: "must-not-leak" },
          output: { secret: "must-not-leak" },
        }),
      },
      events: {
        list: async () => ({ data: events, hasMore: false, cursor: null }),
      },
    } as unknown as LocalWorld;
    const trace = await buildWorkflowRuntimeTrace({
      productRunId: "run_public1" as never,
      workflowRunId: "wrun_private",
      world,
      now: new Date("2026-08-17T08:00:03.000Z"),
    });
    expect(trace.availability).toBe("available");
    if (trace.availability !== "available") throw new Error("trace unavailable");
    expect(trace.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "run", status: "completed" }),
        expect.objectContaining({ kind: "step", name: "invokePlanner", status: "completed" }),
      ]),
    );
    expect(trace.events).toHaveLength(6);
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain("wrun_private");
    expect(serialized).not.toContain("step-private-1");
    expect(serialized).not.toContain("event-private");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("deployment-private");
  });
});
