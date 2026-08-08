import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  load: vi.fn(),
  markDispatching: vi.fn(),
  call: vi.fn(),
  reconcile: vi.fn(),
  accepted: vi.fn(),
  materialized: vi.fn(),
  failed: vi.fn(),
  unknown: vi.fn(),
}));

vi.mock("./memory-import-workflow-steps.js", () => ({
  loadMemoryImportStep: mocked.load,
  markMemoryImportDispatchingStep: mocked.markDispatching,
  callMemoryImportStep: mocked.call,
  reconcileMemoryImportStep: mocked.reconcile,
  commitMemoryImportAcceptedStep: mocked.accepted,
  commitMemoryImportMaterializedStep: mocked.materialized,
  commitMemoryImportFailedStep: mocked.failed,
  commitMemoryImportUnknownStep: mocked.unknown,
}));

import { memoryImportWorkflow } from "./memory-import-workflow.js";

const input = {
  schemaVersion: "memory-import-workflow-input.v1" as const,
  memoryImportIntentId: "mii_workflow1" as never,
  memoryImportResultId: "mir_workflow1" as never,
  outboxId: "obx_workflow1" as never,
  expectedResultRevision: 1,
  mode: "import" as const,
};

const intent = {
  memoryImportIntentId: input.memoryImportIntentId,
  backendId: "mbk_memmy",
  operationId: input.memoryImportIntentId,
  requestSha256: "a".repeat(64),
};
const queued = {
  memoryImportResultId: input.memoryImportResultId,
  status: "queued",
  revision: 1,
  dispatchAttempts: 0,
  reconcileAttempts: 0,
};
const loaded = { intent, result: queued, adapterInput: {}, outboxId: input.outboxId };
const dispatching = { ...queued, status: "dispatching", revision: 2, dispatchAttempts: 1 };
const acceptedEvidence = {
  externalObjectId: "memory_workflow1",
  responseSha256: "b".repeat(64),
};
const accepted = {
  ...dispatching,
  status: "accepted",
  revision: 3,
  ...acceptedEvidence,
};
const materialized = {
  ...accepted,
  status: "materialized",
  revision: 4,
  verificationSha256: "c".repeat(64),
};

describe("MemoryImportWorkflow编排", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.load.mockResolvedValue(loaded);
    mocked.markDispatching.mockResolvedValue(dispatching);
    mocked.call.mockResolvedValue({
      status: "accepted",
      accepted: acceptedEvidence,
      durationMs: 12,
    });
    mocked.accepted.mockResolvedValue(accepted);
    mocked.reconcile.mockResolvedValue({
      status: "materialized",
      accepted: acceptedEvidence,
      verificationSha256: "c".repeat(64),
    });
    mocked.materialized.mockResolvedValue(materialized);
  });

  it("正常链严格按dispatching→单次外部写→accepted→对账→materialized推进", async () => {
    await expect(memoryImportWorkflow(input)).resolves.toEqual({
      memoryImportIntentId: input.memoryImportIntentId,
      status: "materialized",
    });
    expect(mocked.markDispatching).toHaveBeenCalledTimes(1);
    expect(mocked.call).toHaveBeenCalledWith({ loaded, dispatching });
    expect(mocked.accepted).toHaveBeenCalledWith(
      expect.objectContaining({ loaded, result: dispatching, durationMs: 12 }),
    );
    expect(mocked.reconcile).toHaveBeenCalledWith({
      loaded,
      result: accepted,
      externalObjectId: "memory_workflow1",
    });
    expect(mocked.materialized).toHaveBeenCalledTimes(1);
    expect(mocked.call.mock.invocationCallOrder[0]).toBeLessThan(
      mocked.accepted.mock.invocationCallOrder[0]!,
    );
  });

  it("外部响应丢失先提交outcome_unknown，再用同一Intent对账，绝不第二次走普通import", async () => {
    const unknown = {
      ...dispatching,
      status: "outcome_unknown",
      revision: 3,
      errorCode: "memory.import.connection_lost",
    };
    mocked.call.mockResolvedValueOnce({
      status: "outcome_unknown",
      errorCode: "memory.import.connection_lost",
      durationMs: 20,
    });
    mocked.unknown.mockResolvedValueOnce(unknown);
    mocked.reconcile.mockResolvedValueOnce({
      status: "materialized",
      accepted: acceptedEvidence,
      verificationSha256: "c".repeat(64),
    });

    await expect(memoryImportWorkflow(input)).resolves.toMatchObject({ status: "materialized" });
    expect(mocked.call).toHaveBeenCalledTimes(1);
    expect(mocked.unknown).toHaveBeenCalledWith(
      expect.objectContaining({ result: dispatching, errorCode: "memory.import.connection_lost" }),
    );
    expect(mocked.reconcile).toHaveBeenCalledWith({ loaded, result: unknown });
    expect(mocked.materialized).toHaveBeenCalledWith(expect.objectContaining({ result: unknown }));
  });

  it("人工reconcile模式只对账现有unknown，不执行mark-dispatching或普通call", async () => {
    const unknown = {
      ...queued,
      status: "outcome_unknown",
      revision: 5,
      reconcileAttempts: 1,
      errorCode: "memory.import.verify_unavailable",
    };
    mocked.load.mockResolvedValueOnce({ ...loaded, result: unknown });
    mocked.reconcile.mockResolvedValueOnce({
      status: "accepted",
      accepted: acceptedEvidence,
    });
    mocked.accepted.mockResolvedValueOnce({ ...accepted, revision: 6 });

    await expect(
      memoryImportWorkflow({ ...input, outboxId: "obx_reconcile2" as never, mode: "reconcile" }),
    ).resolves.toMatchObject({ status: "accepted" });
    expect(mocked.markDispatching).not.toHaveBeenCalled();
    expect(mocked.call).not.toHaveBeenCalled();
    expect(mocked.reconcile).toHaveBeenCalledTimes(1);
    expect(mocked.accepted).toHaveBeenCalledTimes(1);
  });
});
