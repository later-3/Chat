import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  loadRunSpec: vi.fn(),
  query: vi.fn(),
  freeze: vi.fn(),
  directCore: vi.fn(),
  write: vi.fn(),
  commitCandidate: vi.fn(),
  commitFailure: vi.fn(),
  commitOutcomeUnknown: vi.fn(),
}));

vi.mock("./configurable-planning-steps.js", () => ({
  loadMemoryDirectRunSpecStep: mocked.loadRunSpec,
}));
vi.mock("./configurable-planning-resource-executors.js", () => ({
  executeWorkflowMemoryQuery: mocked.query,
  executeWorkflowMemoryWrite: mocked.write,
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
  commitRunOutcomeUnknownStep: mocked.commitOutcomeUnknown,
}));

import { memoryDirectAgentWorkflow } from "./memory-direct-agent-workflow.js";

const SHA = "a".repeat(64);
const input = {
  schemaVersion: "direct-agent-workflow-input.v1" as const,
  productRunId: "run_memorydirect1" as never,
  workflowAttemptId: "att_memorydirect1" as never,
  workflowRunSpecId: "wrs_memorydirect1" as never,
};

function runSpec(writeRequired: boolean) {
  return {
    semanticRoot: {
      kind: "sequence",
      elements: [
        {
          kind: "task",
          definitionNodeId: "memory-direct.query",
          nodeType: "memory.query",
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
          definitionNodeId: "memory-direct.write",
          nodeType: "memory.write",
          schemaVersion: 2,
          config: {},
        },
      ],
    },
    nodeResolutions: [
      {
        definitionNodeId: "memory-direct.query",
        nodeType: "memory.query",
        schemaVersion: 1,
        activation: "enabled",
        config: {
          providerId: "mbk_memmy",
          required: true,
          querySource: "source_message",
          maxResults: 8,
          maxContextCharacters: 8_000,
        },
      },
      {
        definitionNodeId: "direct.agent",
        nodeType: "agent.direct",
        schemaVersion: 1,
        activation: "enabled",
        config: { capabilityMode: "pi_cli_default", promptReviewMode: "manual" },
      },
      {
        definitionNodeId: "memory-direct.write",
        nodeType: "memory.write",
        schemaVersion: 2,
        activation: "enabled",
        config: {
          providerId: "mbk_memmy",
          source: "source_message",
          contentType: "conversation_turn",
          required: writeRequired,
        },
      },
    ],
  } as never;
}

const candidate = {
  outcome: "candidate_ready" as const,
  productRunId: input.productRunId,
  directAgentAttemptId: "att_memorydirectagent1",
  directAgentCandidateId: "drc_memorydirect1",
  candidateSha256: SHA,
};

describe("Memory Direct耐久Workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.loadRunSpec.mockResolvedValue(runSpec(false));
    mocked.query.mockResolvedValue("success");
    mocked.freeze.mockResolvedValue({
      status: "ready",
      contextRef: {
        workflowMemoryContextId: "wmc_memorydirect1",
        revision: 1,
        sha256: SHA,
      },
    });
    mocked.directCore.mockResolvedValue(candidate);
    mocked.write.mockResolvedValue("materialized");
    mocked.commitCandidate.mockResolvedValue({
      outcome: "product_committed",
      productRunId: input.productRunId,
    });
    mocked.commitFailure.mockResolvedValue(undefined);
    mocked.commitOutcomeUnknown.mockResolvedValue(undefined);
  });

  it("严格按query→freeze→Direct候选→write→Product Commit推进", async () => {
    const order: string[] = [];
    mocked.query.mockImplementation(async () => {
      order.push("query");
      return "success";
    });
    mocked.freeze.mockImplementation(async () => {
      order.push("freeze");
      return { status: "ready", contextRef: { revision: 1, sha256: SHA } };
    });
    mocked.directCore.mockImplementation(async () => {
      order.push("direct");
      return candidate;
    });
    mocked.write.mockImplementation(async () => {
      order.push("write");
      return "materialized";
    });
    mocked.commitCandidate.mockImplementation(async () => {
      order.push("commit");
      return { outcome: "product_committed", productRunId: input.productRunId };
    });

    await expect(memoryDirectAgentWorkflow(input)).resolves.toEqual({
      outcome: "product_committed",
      productRunId: input.productRunId,
    });
    expect(order).toEqual(["query", "freeze", "direct", "write", "commit"]);
    expect(mocked.query).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: input.workflowAttemptId }),
      expect.objectContaining({ definitionNodeId: "memory-direct.query", attemptNumber: 1 }),
    );
    expect(mocked.write).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: input.workflowAttemptId }),
      expect.objectContaining({ definitionNodeId: "memory-direct.write", attemptNumber: 1 }),
    );
  });

  it("可选写回失败仍提交候选，但必需写回结果未知停止且不重复提交", async () => {
    mocked.write.mockResolvedValueOnce("failed");
    await expect(memoryDirectAgentWorkflow(input)).resolves.toMatchObject({
      outcome: "product_committed",
    });
    expect(mocked.commitCandidate).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    mocked.loadRunSpec.mockResolvedValue(runSpec(true));
    mocked.query.mockResolvedValue("success");
    mocked.freeze.mockResolvedValue({ status: "ready", contextRef: { revision: 1, sha256: SHA } });
    mocked.directCore.mockResolvedValue(candidate);
    mocked.write.mockResolvedValue("outcome_unknown");
    mocked.commitOutcomeUnknown.mockResolvedValue(undefined);

    await expect(memoryDirectAgentWorkflow(input)).resolves.toEqual({
      outcome: "outcome_unknown",
      productRunId: input.productRunId,
      errorCode: "memory_direct.write_outcome_unknown",
    });
    expect(mocked.write).toHaveBeenCalledTimes(1);
    expect(mocked.commitOutcomeUnknown).toHaveBeenCalledTimes(1);
    expect(mocked.commitCandidate).not.toHaveBeenCalled();
  });

  it("必需查询不可用时在Direct和写回之前失败关闭", async () => {
    mocked.query.mockResolvedValue("required_unavailable");

    await expect(memoryDirectAgentWorkflow(input)).resolves.toEqual({
      outcome: "failed",
      productRunId: input.productRunId,
      errorCode: "memory_direct.query_required_unavailable",
    });
    expect(mocked.commitFailure).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "memory_direct.query_required_unavailable" }),
    );
    expect(mocked.freeze).not.toHaveBeenCalled();
    expect(mocked.directCore).not.toHaveBeenCalled();
    expect(mocked.write).not.toHaveBeenCalled();
    expect(mocked.commitCandidate).not.toHaveBeenCalled();
  });
});
