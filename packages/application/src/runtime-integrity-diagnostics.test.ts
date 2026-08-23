import { createEmptySnapshot, type ProductSnapshot } from "@chat/contracts";
import { describe, expect, it, vi } from "vitest";
import { scanRuntimeIntegrity } from "./runtime-integrity-diagnostics.js";

describe("Runtime完整性只读诊断", () => {
  it("只返回安全状态对和建议，不修改Fixture或读取正文", async () => {
    const snapshot = createEmptySnapshot("2026-08-23T00:00:00.000Z");
    snapshot.entities.runs["run_diagnostic1"] = {
      schemaVersion: "product-run.v3",
      productRunId: "run_diagnostic1",
      sessionId: "psn_diagnostic1",
      sourceMessageId: "msg_diagnostic1",
      workflowViewDefinitionId: "wvw_diagnostic1",
      runKind: "planning",
      runnerFamily: "configurable-planning.v1",
      runnerBundleVersion: "configurable-planning.bundle.v1",
      status: "pending",
      phase: "queued",
      maxPlanRevisions: 5,
      revision: 1,
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
    } as ProductSnapshot["entities"]["runs"][string];
    snapshot.outbox["obx_diagnostic1"] = {
      schemaVersion: "outbox-entry.v1",
      outboxId: "obx_diagnostic1",
      kind: "workflow_start",
      status: "acknowledged",
      productRunId: "run_diagnostic1",
      runnerFamily: "configurable-planning.v1",
      runnerBundleVersion: "configurable-planning.bundle.v1",
      dispatchAttempts: 1,
      revision: 2,
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:01.000Z",
    } as ProductSnapshot["outbox"][string];
    const before = structuredClone(snapshot);
    const reader = vi.fn(async () => ({
      state: "terminal" as const,
      outcome: "failed" as const,
    }));

    await expect(scanRuntimeIntegrity(snapshot, reader)).resolves.toEqual([
      {
        productRunId: "run_diagnostic1",
        outboxId: "obx_diagnostic1",
        productStatus: "pending",
        outboxStatus: "acknowledged",
        runtimeRun: { state: "terminal", outcome: "failed" },
        recommendation: "settle_failed",
      },
    ]);
    expect(snapshot).toEqual(before);
    expect(reader).toHaveBeenCalledWith("run_diagnostic1");
  });
});
