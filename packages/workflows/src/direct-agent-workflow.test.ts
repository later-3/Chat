import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createHook: vi.fn(),
  prepare: vi.fn(),
  start: vi.fn(),
  claimHook: vi.fn(),
  loadDecision: vi.fn(),
  submitDecision: vi.fn(),
  commitResult: vi.fn(),
  recordAgentNode: vi.fn(),
  commitFailure: vi.fn(),
  commitOutcomeUnknown: vi.fn(),
}));

vi.mock("workflow", () => ({
  defineHook: () => ({ create: mocked.createHook }),
}));

vi.mock("./direct-agent-workflow-steps.js", () => ({
  prepareDirectAgentOperationStep: mocked.prepare,
  startDirectAgentOperationStep: mocked.start,
  claimPromptReviewHookStep: mocked.claimHook,
  loadPromptReviewDecisionStep: mocked.loadDecision,
  submitPromptReviewDecisionStep: mocked.submitDecision,
  commitDirectAgentResultStep: mocked.commitResult,
  recordDirectAgentNodeStep: mocked.recordAgentNode,
}));

vi.mock("./workflow-result-steps.js", () => ({
  commitRunFailureStep: mocked.commitFailure,
  commitRunOutcomeUnknownStep: mocked.commitOutcomeUnknown,
}));

import { directAgentWorkflow } from "./direct-agent-workflow.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const input = {
  schemaVersion: "direct-agent-workflow-input.v1" as const,
  productRunId: "run_directworkflow1" as never,
  workflowAttemptId: "att_directworkflow1" as never,
  workflowRunSpecId: "wrs_directworkflow1" as never,
};

function review(requestIndex: number) {
  return {
    promptReviewRequestId: `prr_directreview${String(requestIndex)}` as never,
    requestRevision: 1,
    revision: 1,
    requestIndex,
    payloadSha256: SHA_A,
    reviewSha256: SHA_B,
  };
}

function waiting(requestIndex: number) {
  return {
    kind: "waiting_prompt_review" as const,
    operationId: "pio_directoperation1",
    requestSha256: SHA_C,
    review: review(requestIndex),
  };
}

function hookSignal(requestIndex: number) {
  return {
    schemaVersion: "prompt-review-decision-hook-payload.v1" as const,
    productRunId: input.productRunId,
    promptReviewRequestId: review(requestIndex).promptReviewRequestId,
    promptReviewDecisionId: `prd_directdecision${String(requestIndex)}` as never,
    requestRevision: 1,
    reviewSha256: SHA_B,
    payloadSha256: SHA_A,
  };
}

function decision(requestIndex: number, kind: "approve" | "reject" = "approve") {
  return {
    promptReviewDecisionId: `prd_directdecision${String(requestIndex)}` as never,
    promptReviewRequestId: review(requestIndex).promptReviewRequestId,
    productRunId: input.productRunId,
    requestRevision: 1,
    reviewSha256: SHA_B,
    payloadSha256: SHA_A,
    kind,
    revision: 1 as const,
    decisionSha256: SHA_C,
  };
}

function hookFor(signal: ReturnType<typeof hookSignal>) {
  const promise = Promise.resolve(signal);
  return {
    getConflict: async () => null,
    then: promise.then.bind(promise),
    [Symbol.dispose]: () => undefined,
  };
}

describe("Direct Agent耐久Workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.prepare.mockResolvedValue({
      directAgentAttemptId: "att_directagent1",
      workflowRunSpecSha256: SHA_B,
      inputManifestSha256: SHA_C,
    });
    mocked.claimHook.mockResolvedValue(undefined);
    mocked.commitResult.mockResolvedValue({ messageId: "msg_directresult1" });
    mocked.recordAgentNode.mockResolvedValue(undefined);
    mocked.commitFailure.mockResolvedValue(undefined);
    mocked.commitOutcomeUnknown.mockResolvedValue(undefined);
  });

  it("两次批准始终恢复同一个Operation，并只在候选已持久化后做一次Product Commit", async () => {
    let hookIndex = 0;
    mocked.createHook.mockImplementation(() => {
      hookIndex += 1;
      return hookFor(hookSignal(hookIndex));
    });
    mocked.start.mockResolvedValue(waiting(1));
    mocked.loadDecision.mockResolvedValueOnce(decision(1)).mockResolvedValueOnce(decision(2));
    mocked.submitDecision.mockResolvedValueOnce(waiting(2)).mockResolvedValueOnce({
      kind: "succeeded",
      operationId: "pio_directoperation1",
      requestSha256: SHA_C,
      result: { directAgentCandidateId: "drc_directcandidate1", sha256: SHA_C },
    });

    await expect(directAgentWorkflow(input)).resolves.toEqual({
      outcome: "product_committed",
      productRunId: input.productRunId,
    });
    expect(mocked.prepare).toHaveBeenCalledTimes(1);
    expect(mocked.start).toHaveBeenCalledTimes(1);
    expect(mocked.claimHook).toHaveBeenCalledTimes(2);
    expect(mocked.submitDecision).toHaveBeenCalledTimes(2);
    expect(
      mocked.submitDecision.mock.calls.every(
        ([call]) => call.operationId === "pio_directoperation1",
      ),
    ).toBe(true);
    expect(mocked.commitResult).toHaveBeenCalledWith(
      expect.objectContaining({
        directAgentAttemptId: "att_directagent1",
        directAgentCandidateId: "drc_directcandidate1",
        candidateSha256: SHA_C,
      }),
    );
    expect(
      mocked.recordAgentNode.mock.calls.map(([call]) => ({
        iteration: call.iteration,
        toStatus: call.toStatus,
        outcomeCode: call.outcomeCode,
      })),
    ).toEqual([
      { iteration: 1, toStatus: "running", outcomeCode: undefined },
      { iteration: 1, toStatus: "waiting_human", outcomeCode: undefined },
      { iteration: 1, toStatus: "running", outcomeCode: undefined },
      { iteration: 2, toStatus: "waiting_human", outcomeCode: undefined },
      { iteration: 2, toStatus: "running", outcomeCode: undefined },
      { iteration: 3, toStatus: "succeeded", outcomeCode: "completed" },
    ]);
    expect(mocked.commitFailure).not.toHaveBeenCalled();
    expect(mocked.commitOutcomeUnknown).not.toHaveBeenCalled();
  });

  it("拒绝决定仍通知Executor清理同一Operation，但Product终态保持cancelled", async () => {
    mocked.createHook.mockReturnValue(hookFor(hookSignal(1)));
    mocked.start.mockResolvedValue(waiting(1));
    mocked.loadDecision.mockResolvedValue(decision(1, "reject"));
    mocked.submitDecision.mockResolvedValue({
      kind: "cancelled",
      operationId: "pio_directoperation1",
      requestSha256: SHA_C,
      errorCode: "direct_executor.user_rejected",
    });

    await expect(directAgentWorkflow(input)).resolves.toEqual({
      outcome: "cancelled",
      productRunId: input.productRunId,
    });
    expect(mocked.submitDecision).toHaveBeenCalledTimes(1);
    expect(mocked.commitResult).not.toHaveBeenCalled();
    expect(mocked.commitFailure).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "direct_agent.prompt_rejected" }),
    );
    expect(mocked.recordAgentNode).toHaveBeenLastCalledWith(
      expect.objectContaining({ iteration: 1, toStatus: "cancelled", outcomeCode: "rejected" }),
    );
  });

  it("批准后的Executor连接未知按Provider outcome_unknown收敛，绝不重启Operation", async () => {
    mocked.createHook.mockReturnValue(hookFor(hookSignal(1)));
    mocked.start.mockResolvedValue(waiting(1));
    mocked.loadDecision.mockResolvedValue(decision(1));
    mocked.submitDecision.mockRejectedValue(new Error("direct_executor.service_unavailable"));

    await expect(directAgentWorkflow(input)).resolves.toEqual({
      outcome: "outcome_unknown",
      productRunId: input.productRunId,
      errorCode: "direct_executor.service_unavailable",
    });
    expect(mocked.start).toHaveBeenCalledTimes(1);
    expect(mocked.submitDecision).toHaveBeenCalledTimes(1);
    expect(mocked.commitOutcomeUnknown).toHaveBeenCalledTimes(1);
    expect(mocked.commitFailure).not.toHaveBeenCalled();
    expect(mocked.recordAgentNode).toHaveBeenLastCalledWith(
      expect.objectContaining({ iteration: 2, toStatus: "outcome_unknown" }),
    );
  });

  it("Hook signal任一Hash漂移都会在读取Decision和恢复Executor前失败关闭", async () => {
    mocked.createHook.mockReturnValue(hookFor({ ...hookSignal(1), payloadSha256: "d".repeat(64) }));
    mocked.start.mockResolvedValue(waiting(1));

    await expect(directAgentWorkflow(input)).resolves.toMatchObject({
      outcome: "failed",
      errorCode: "direct_agent.prompt_review_hook_mismatch",
    });
    expect(mocked.loadDecision).not.toHaveBeenCalled();
    expect(mocked.submitDecision).not.toHaveBeenCalled();
    expect(mocked.commitFailure).toHaveBeenCalledTimes(1);
    expect(mocked.recordAgentNode).toHaveBeenLastCalledWith(
      expect.objectContaining({ iteration: 1, toStatus: "failed" }),
    );
  });

  it("最多创建16个审核Hook，第17个Provider边界失败关闭", async () => {
    let hookIndex = 0;
    mocked.createHook.mockImplementation(() => {
      hookIndex += 1;
      return hookFor(hookSignal(hookIndex));
    });
    mocked.start.mockResolvedValue(waiting(1));
    mocked.loadDecision.mockImplementation(async ({ review: currentReview }) =>
      decision(currentReview.requestIndex),
    );
    mocked.submitDecision.mockImplementation(async ({ review: currentReview }) =>
      waiting(currentReview.requestIndex + 1),
    );

    await expect(directAgentWorkflow(input)).resolves.toMatchObject({
      outcome: "failed",
      errorCode: "direct_agent.prompt_review_limit_reached",
    });
    expect(mocked.createHook).toHaveBeenCalledTimes(16);
    expect(mocked.submitDecision).toHaveBeenCalledTimes(16);
    expect(mocked.commitFailure).toHaveBeenCalledTimes(1);
    expect(mocked.commitResult).not.toHaveBeenCalled();
    expect(mocked.recordAgentNode).toHaveBeenLastCalledWith(
      expect.objectContaining({ iteration: 17, toStatus: "failed" }),
    );
  });

  it("第16次批准后允许第17个agent continuation仅收敛completed", async () => {
    let hookIndex = 0;
    mocked.createHook.mockImplementation(() => {
      hookIndex += 1;
      return hookFor(hookSignal(hookIndex));
    });
    mocked.start.mockResolvedValue(waiting(1));
    mocked.loadDecision.mockImplementation(async ({ review: currentReview }) =>
      decision(currentReview.requestIndex),
    );
    mocked.submitDecision.mockImplementation(async ({ review: currentReview }) =>
      currentReview.requestIndex === 16
        ? {
            kind: "succeeded" as const,
            operationId: "pio_directoperation1",
            requestSha256: SHA_C,
            result: { directAgentCandidateId: "drc_directcandidate16", sha256: SHA_C },
          }
        : waiting(currentReview.requestIndex + 1),
    );

    await expect(directAgentWorkflow(input)).resolves.toEqual({
      outcome: "product_committed",
      productRunId: input.productRunId,
    });
    expect(mocked.createHook).toHaveBeenCalledTimes(16);
    expect(mocked.submitDecision).toHaveBeenCalledTimes(16);
    expect(mocked.recordAgentNode).toHaveBeenLastCalledWith(
      expect.objectContaining({
        iteration: 17,
        toStatus: "succeeded",
        outcomeCode: "completed",
      }),
    );
    expect(mocked.commitResult).toHaveBeenCalledWith(
      expect.objectContaining({ directAgentCandidateId: "drc_directcandidate16" }),
    );
  });

  it("waiting节点创建后Hook claim失败会先把审核节点终结为failed", async () => {
    mocked.createHook.mockReturnValue(hookFor(hookSignal(1)));
    mocked.start.mockResolvedValue(waiting(1));
    mocked.claimHook.mockRejectedValue(new Error("workflow.binding_write_failed"));

    await expect(directAgentWorkflow(input)).resolves.toMatchObject({
      outcome: "failed",
      errorCode: "workflow.binding_write_failed",
    });
    expect(mocked.recordAgentNode).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ iteration: 1, toStatus: "waiting_human" }),
    );
    expect(mocked.recordAgentNode).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        iteration: 1,
        toStatus: "failed",
        outcomeCode: "direct_agent.hook_claim_failed",
      }),
    );
    expect(mocked.loadDecision).not.toHaveBeenCalled();
  });

  it("Hook身份冲突会把已创建的waiting审核节点终结为failed", async () => {
    const conflictHook = hookFor(hookSignal(1));
    mocked.createHook.mockReturnValue({
      ...conflictHook,
      getConflict: async () => ({ token: "prh-conflict" }),
    });
    mocked.start.mockResolvedValue(waiting(1));

    await expect(directAgentWorkflow(input)).resolves.toMatchObject({
      outcome: "failed",
      errorCode: "workflow.hook_conflict",
    });
    expect(mocked.recordAgentNode).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ iteration: 1, toStatus: "waiting_human" }),
    );
    expect(mocked.recordAgentNode).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        iteration: 1,
        toStatus: "failed",
        outcomeCode: "direct_agent.hook_conflict",
      }),
    );
    expect(mocked.claimHook).not.toHaveBeenCalled();
    expect(mocked.loadDecision).not.toHaveBeenCalled();
  });
});
