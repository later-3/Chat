import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  load: vi.fn(),
  markDispatching: vi.fn(),
  callProvider: vi.fn(),
  reconcileProvider: vi.fn(),
  accepted: vi.fn(),
  materialized: vi.fn(),
  failed: vi.fn(),
  unknown: vi.fn(),
}));

vi.mock("./memory-write-workflow-steps.js", () => ({
  loadMemoryWriteStep: mocked.load,
  markMemoryWriteDispatchingStep: mocked.markDispatching,
  callMemoryWriteProviderStep: mocked.callProvider,
  reconcileMemoryWriteProviderStep: mocked.reconcileProvider,
  commitMemoryWriteAcceptedStep: mocked.accepted,
  commitMemoryWriteMaterializedStep: mocked.materialized,
  commitMemoryWriteFailedStep: mocked.failed,
  commitMemoryWriteUnknownStep: mocked.unknown,
}));

import { memoryWriteWorkflow } from "./memory-write-workflow.js";

const input = {
  schemaVersion: "memory-write-workflow-input.v1" as const,
  memoryWriteIntentId: "mwi_workflowmemory1" as never,
  memoryWriteResultId: "mwr_workflowmemory1" as never,
  outboxId: "obx_workflowmemory1" as never,
  expectedResultRevision: 1,
  mode: "write" as const,
};
const intent = {
  memoryWriteIntentId: input.memoryWriteIntentId,
  providerId: "mbk_tencentmemorycore",
  operationId: input.memoryWriteIntentId,
  requestSha256: "a".repeat(64),
};
const queued = {
  memoryWriteResultId: input.memoryWriteResultId,
  status: "queued",
  revision: 1,
  dispatchAttempts: 0,
  reconcileAttempts: 0,
};
const loaded = {
  intent,
  result: queued,
  adapterInput: { operationId: input.memoryWriteIntentId },
  outboxId: input.outboxId,
};
const dispatching = { ...queued, status: "dispatching", revision: 2, dispatchAttempts: 1 };
const acceptedEvidence = {
  externalObjectId: "memory-write:mwi_workflowmemory1",
  externalObjectVersion: "v1",
  externalStatus: "l0_accepted",
  responseSha256: "b".repeat(64),
};
const accepted = { ...dispatching, ...acceptedEvidence, status: "accepted", revision: 3 };
const materialized = {
  ...accepted,
  status: "materialized",
  revision: 4,
  verificationKind: "provider_query",
  verificationSha256: "c".repeat(64),
};

describe("MemoryWriteWorkflow编排", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.load.mockResolvedValue(loaded);
    mocked.markDispatching.mockResolvedValue(dispatching);
    mocked.callProvider.mockResolvedValue({ status: "accepted", accepted: acceptedEvidence });
    mocked.accepted.mockResolvedValue(accepted);
    mocked.reconcileProvider.mockResolvedValue({
      status: "materialized",
      accepted: { ...acceptedEvidence, externalStatus: "materialized" },
      verificationKind: "provider_query",
      verificationSha256: "c".repeat(64),
    });
    mocked.materialized.mockResolvedValue(materialized);
  });

  it("正常链只写一次，再用只读reconcile从accepted收敛为materialized", async () => {
    await expect(memoryWriteWorkflow(input)).resolves.toEqual({
      memoryWriteIntentId: input.memoryWriteIntentId,
      status: "materialized",
    });
    expect(mocked.markDispatching).toHaveBeenCalledTimes(1);
    expect(mocked.callProvider).toHaveBeenCalledTimes(1);
    expect(mocked.callProvider).toHaveBeenCalledWith({ loaded });
    expect(mocked.accepted).toHaveBeenCalledWith({
      loaded,
      result: dispatching,
      accepted: acceptedEvidence,
    });
    expect(mocked.reconcileProvider).toHaveBeenCalledWith({
      loaded,
      externalObjectId: acceptedEvidence.externalObjectId,
    });
    expect(mocked.materialized).toHaveBeenCalledWith(
      expect.objectContaining({ loaded, result: accepted, reconciled: true }),
    );
  });

  it("写响应丢失先提交outcome_unknown，随后只读对账，绝不第二次调用write", async () => {
    const unknown = {
      ...dispatching,
      status: "outcome_unknown",
      revision: 3,
      errorCode: "memory.write.connection_lost",
    };
    mocked.callProvider.mockResolvedValueOnce({
      status: "outcome_unknown",
      errorCode: "memory.write.connection_lost",
    });
    mocked.unknown.mockResolvedValueOnce(unknown);

    await expect(memoryWriteWorkflow(input)).resolves.toMatchObject({ status: "materialized" });
    expect(mocked.callProvider).toHaveBeenCalledTimes(1);
    expect(mocked.unknown).toHaveBeenCalledWith({
      loaded,
      result: dispatching,
      errorCode: "memory.write.connection_lost",
    });
    expect(mocked.reconcileProvider).toHaveBeenCalledWith({ loaded });
    expect(mocked.materialized).toHaveBeenCalledWith(
      expect.objectContaining({ result: unknown, reconciled: true }),
    );
  });

  it("显式reconcile模式只检查已有结果，不进入dispatching也不调用write", async () => {
    const unknown = {
      ...queued,
      status: "outcome_unknown",
      revision: 5,
      reconcileAttempts: 1,
      errorCode: "memory.write.verify_unavailable",
    };
    mocked.load.mockResolvedValueOnce({ ...loaded, result: unknown });
    mocked.reconcileProvider.mockResolvedValueOnce({
      status: "accepted",
      accepted: acceptedEvidence,
    });
    mocked.accepted.mockResolvedValueOnce({ ...accepted, revision: 6 });

    await expect(
      memoryWriteWorkflow({
        ...input,
        outboxId: "obx_workflowmemory2" as never,
        mode: "reconcile",
      }),
    ).resolves.toMatchObject({ status: "accepted" });
    expect(mocked.markDispatching).not.toHaveBeenCalled();
    expect(mocked.callProvider).not.toHaveBeenCalled();
    expect(mocked.reconcileProvider).toHaveBeenCalledTimes(1);
    expect(mocked.accepted).toHaveBeenCalledWith(
      expect.objectContaining({
        loaded: expect.objectContaining({ result: unknown }),
        reconciled: true,
      }),
    );
  });
});
