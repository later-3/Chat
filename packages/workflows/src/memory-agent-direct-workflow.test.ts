import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  loadRunSpec: vi.fn(),
  recordNode: vi.fn(),
  retrieve: vi.fn(),
  freeze: vi.fn(),
  directCore: vi.fn(),
  write: vi.fn(),
  commitCandidate: vi.fn(),
  commitFailure: vi.fn(),
}));

vi.mock("./configurable-planning-steps.js", () => ({
  loadMemoryAgentDirectRunSpecStep: mocked.loadRunSpec,
  recordConfigurablePlanningNodeStep: mocked.recordNode,
}));
vi.mock("./memory-agent-workflow-steps.js", () => ({
  executeMemoryRetrievalAgentStep: mocked.retrieve,
  executeMemoryWriteAgentStep: mocked.write,
}));
vi.mock("./workflow-memory-steps.js", () => ({
  freezeWorkflowMemoryContextStep: mocked.freeze,
}));
vi.mock("./direct-agent-workflow.js", () => ({
  runDirectAgentWorkflowCore: mocked.directCore,
  commitDirectAgentCandidate: mocked.commitCandidate,
}));
vi.mock("./workflow-result-steps.js", () => ({
  commitRunFailureStep: mocked.commitFailure,
}));

import { memoryAgentDirectWorkflow } from "./memory-agent-direct-workflow.js";

const SHA = "a".repeat(64);
const input = {
  schemaVersion: "direct-agent-workflow-input.v1" as const,
  productRunId: "run_memoryagentdirect1" as never,
  workflowAttemptId: "att_memoryagentdirect1" as never,
  workflowRunSpecId: "wrs_memoryagentdirect1" as never,
};

function runSpec() {
  return {
    semanticRoot: {
      kind: "sequence",
      elements: [
        {
          kind: "task",
          definitionNodeId: "memory-agent.retrieve",
          nodeType: "agent.memory_retrieve",
          schemaVersion: 1,
          config: {},
        },
        {
          kind: "composite",
          definitionNodeId: "direct.agent",
          nodeType: "agent.direct",
          schemaVersion: 1,
          config: {},
        },
        {
          kind: "task",
          definitionNodeId: "memory-agent.write",
          nodeType: "agent.memory_write",
          schemaVersion: 1,
          config: {},
        },
      ],
    },
  } as never;
}

const candidate = {
  outcome: "candidate_ready" as const,
  productRunId: input.productRunId,
  directAgentAttemptId: "att_directagentmemory1",
  directAgentCandidateId: "drc_memoryagent1",
  candidateSha256: SHA,
};

describe("Memory Agent Direct耐久Workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.loadRunSpec.mockResolvedValue(runSpec());
    mocked.recordNode.mockResolvedValue(undefined);
    mocked.retrieve.mockResolvedValue("success");
    mocked.freeze.mockResolvedValue({
      status: "ready",
      contextRef: { workflowMemoryContextId: "wmc_memoryagent1", revision: 1, sha256: SHA },
    });
    mocked.directCore.mockResolvedValue(candidate);
    mocked.write.mockResolvedValue({ outcome: "candidate_ready", candidateId: "mwc_memoryagent1" });
    mocked.commitCandidate.mockResolvedValue({
      outcome: "product_committed",
      productRunId: input.productRunId,
    });
    mocked.commitFailure.mockResolvedValue(undefined);
  });

  it("严格按retrieval→Direct候选→write候选→Product Commit推进", async () => {
    const order: string[] = [];
    mocked.retrieve.mockImplementation(async () => {
      order.push("retrieval");
      return "success";
    });
    mocked.freeze.mockImplementation(async () => {
      order.push("freeze");
      return { status: "ready", contextRef: { revision: 1, sha256: SHA } };
    });
    mocked.directCore.mockImplementation(async () => {
      order.push("direct_candidate");
      return candidate;
    });
    mocked.write.mockImplementation(async () => {
      order.push("write_candidate");
      return { outcome: "candidate_ready", candidateId: "mwc_memoryagent1" };
    });
    mocked.commitCandidate.mockImplementation(async () => {
      order.push("commit");
      return { outcome: "product_committed", productRunId: input.productRunId };
    });

    await expect(memoryAgentDirectWorkflow(input)).resolves.toEqual({
      outcome: "product_committed",
      productRunId: input.productRunId,
    });

    expect(order).toEqual(["retrieval", "freeze", "direct_candidate", "write_candidate", "commit"]);
    expect(mocked.retrieve).toHaveBeenCalledWith({
      identity: expect.objectContaining({
        definitionNodeId: "memory-agent.retrieve",
        attemptNumber: 1,
      }),
    });
    expect(mocked.recordNode).toHaveBeenCalledWith(
      expect.objectContaining({
        definitionNodeId: "memory-agent.retrieve",
        toStatus: "succeeded",
        outcomeCode: "success",
      }),
    );
    expect(mocked.write).toHaveBeenCalledWith({
      productRunId: input.productRunId,
      workflowAttemptId: input.workflowAttemptId,
      workflowRunSpecId: input.workflowRunSpecId,
      directAgentCandidateId: candidate.directAgentCandidateId,
      candidateSha256: candidate.candidateSha256,
    });
    expect(mocked.recordNode).toHaveBeenLastCalledWith(
      expect.objectContaining({
        definitionNodeId: "memory-agent.write",
        toStatus: "succeeded",
        outcomeCode: "candidate_ready",
      }),
    );
  });

  it("必需检索不可用时在Direct、写入候选和提交之前失败关闭", async () => {
    mocked.retrieve.mockResolvedValue("required_unavailable");

    await expect(memoryAgentDirectWorkflow(input)).resolves.toEqual({
      outcome: "failed",
      productRunId: input.productRunId,
      errorCode: "memory_agent_direct.retrieval_required_unavailable",
    });

    expect(mocked.commitFailure).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "memory_agent_direct.retrieval_required_unavailable" }),
    );
    expect(mocked.recordNode).toHaveBeenLastCalledWith(
      expect.objectContaining({
        definitionNodeId: "memory-agent.retrieve",
        toStatus: "failed",
        outcomeCode: "required_unavailable",
      }),
    );
    expect(mocked.freeze).not.toHaveBeenCalled();
    expect(mocked.directCore).not.toHaveBeenCalled();
    expect(mocked.write).not.toHaveBeenCalled();
    expect(mocked.commitCandidate).not.toHaveBeenCalled();
  });

  it("冻结Context缺失时把检索节点收敛为failed，并阻断Direct和提交", async () => {
    mocked.freeze.mockResolvedValue({ status: "missing" });

    await expect(memoryAgentDirectWorkflow(input)).resolves.toEqual({
      outcome: "failed",
      productRunId: input.productRunId,
      errorCode: "memory_agent_direct.context_missing",
    });

    expect(mocked.recordNode).toHaveBeenLastCalledWith(
      expect.objectContaining({
        definitionNodeId: "memory-agent.retrieve",
        toStatus: "failed",
        outcomeCode: "context_missing",
      }),
    );
    expect(mocked.directCore).not.toHaveBeenCalled();
    expect(mocked.write).not.toHaveBeenCalled();
    expect(mocked.commitCandidate).not.toHaveBeenCalled();
  });

  it("检索Agent抛错时先把检索节点收敛为failed，再失败关闭", async () => {
    mocked.retrieve.mockRejectedValue(new Error("memory_agent.provider_unavailable"));

    await expect(memoryAgentDirectWorkflow(input)).resolves.toEqual({
      outcome: "failed",
      productRunId: input.productRunId,
      errorCode: "memory_agent.provider_unavailable",
    });

    expect(mocked.recordNode).toHaveBeenLastCalledWith(
      expect.objectContaining({
        definitionNodeId: "memory-agent.retrieve",
        toStatus: "failed",
        outcomeCode: "memory_agent.provider_unavailable",
      }),
    );
    expect(mocked.directCore).not.toHaveBeenCalled();
    expect(mocked.write).not.toHaveBeenCalled();
    expect(mocked.commitCandidate).not.toHaveBeenCalled();
  });

  it("必需写入候选不可用时阻断Product Commit", async () => {
    mocked.write.mockResolvedValue({
      outcome: "required_unavailable",
      errorCode: "memory_agent.not_configured",
    });

    await expect(memoryAgentDirectWorkflow(input)).resolves.toEqual({
      outcome: "failed",
      productRunId: input.productRunId,
      errorCode: "memory_agent.not_configured",
    });

    expect(mocked.recordNode).toHaveBeenLastCalledWith(
      expect.objectContaining({
        definitionNodeId: "memory-agent.write",
        toStatus: "failed",
        outcomeCode: "required_unavailable",
      }),
    );
    expect(mocked.commitFailure).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "memory_agent.not_configured" }),
    );
    expect(mocked.commitCandidate).not.toHaveBeenCalled();
  });

  it("写入Agent抛错时先把写入节点收敛为failed，再阻断Product Commit", async () => {
    mocked.write.mockRejectedValue(new Error("memory_agent.provider_unavailable"));

    await expect(memoryAgentDirectWorkflow(input)).resolves.toEqual({
      outcome: "failed",
      productRunId: input.productRunId,
      errorCode: "memory_agent.provider_unavailable",
    });

    expect(mocked.recordNode).toHaveBeenLastCalledWith(
      expect.objectContaining({
        definitionNodeId: "memory-agent.write",
        toStatus: "failed",
        outcomeCode: "memory_agent.provider_unavailable",
      }),
    );
    expect(mocked.commitCandidate).not.toHaveBeenCalled();
  });

  it("可选写入候选不可用时仍提交Direct候选", async () => {
    mocked.write.mockResolvedValue({
      outcome: "optional_unavailable",
      errorCode: "memory_agent.not_configured",
    });

    await expect(memoryAgentDirectWorkflow(input)).resolves.toEqual({
      outcome: "product_committed",
      productRunId: input.productRunId,
    });

    expect(mocked.recordNode).toHaveBeenLastCalledWith(
      expect.objectContaining({
        definitionNodeId: "memory-agent.write",
        toStatus: "succeeded",
        outcomeCode: "optional_unavailable",
      }),
    );
    expect(mocked.commitFailure).not.toHaveBeenCalled();
    expect(mocked.commitCandidate).toHaveBeenCalledTimes(1);
  });
});
