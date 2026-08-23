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

    await expect(
      scanRuntimeIntegrity(snapshot, reader, { observedAt: "2026-08-23T00:01:00.000Z" }),
    ).resolves.toEqual([
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

  it("单次unknown只建议检查，只有耐久连续unknown超过宽限期才建议收敛", async () => {
    const snapshot = createEmptySnapshot("2026-08-23T00:00:00.000Z");
    snapshot.entities.runs["run_diagnosticunknown1"] = {
      schemaVersion: "product-run.v3",
      productRunId: "run_diagnosticunknown1",
      sessionId: "psn_diagnosticunknown1",
      sourceMessageId: "msg_diagnosticunknown1",
      workflowViewDefinitionId: "wvw_diagnosticunknown1",
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
    snapshot.outbox["obx_diagnosticunknown1"] = {
      schemaVersion: "outbox-entry.v1",
      outboxId: "obx_diagnosticunknown1",
      kind: "workflow_start",
      status: "acknowledged",
      productRunId: "run_diagnosticunknown1",
      dispatchAttempts: 1,
      revision: 2,
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:01.000Z",
    } as ProductSnapshot["outbox"][string];
    const reader = vi.fn(async () => ({ state: "unknown" as const }));

    const first = await scanRuntimeIntegrity(snapshot, reader, {
      observedAt: "2026-08-23T01:00:00.000Z",
    });
    expect(first[0]?.recommendation).toBe("inspect_dispatch");
    snapshot.outbox["obx_diagnosticunknown1"] = {
      ...snapshot.outbox["obx_diagnosticunknown1"]!,
      lastErrorCode: "workflow.runtime_query_unknown",
      updatedAt: "2026-08-23T00:59:00.000Z",
    };
    const continuous = await scanRuntimeIntegrity(snapshot, reader, {
      observedAt: "2026-08-23T01:00:00.000Z",
    });
    expect(continuous[0]?.recommendation).toBe("settle_outcome_unknown");
  });

  it("悬空Workflow Start形成明确finding且不调用Runtime reader", async () => {
    const snapshot = createEmptySnapshot("2026-08-23T00:00:00.000Z");
    snapshot.outbox["obx_diagnosticmissing1"] = {
      schemaVersion: "outbox-entry.v1",
      outboxId: "obx_diagnosticmissing1",
      kind: "workflow_start",
      status: "acknowledged",
      productRunId: "run_diagnosticmissing1",
      dispatchAttempts: 1,
      revision: 2,
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:01.000Z",
    } as ProductSnapshot["outbox"][string];
    const reader = vi.fn(async () => ({ state: "active" as const }));

    await expect(
      scanRuntimeIntegrity(snapshot, reader, { observedAt: "2026-08-23T01:00:00.000Z" }),
    ).resolves.toEqual([
      expect.objectContaining({
        productStatus: "missing",
        recommendation: "missing_product_run",
      }),
    ]);
    expect(reader).not.toHaveBeenCalled();
  });
});
