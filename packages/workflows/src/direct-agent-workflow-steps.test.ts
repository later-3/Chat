import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("workflow", async (importOriginal) => {
  const original = await importOriginal<typeof import("workflow")>();
  return { ...original, getStepMetadata: () => ({ attempt: 1 }) };
});

import { setWorkflowRuntimeContext } from "./runtime-context.js";
import {
  claimPromptReviewHookStep,
  commitDirectAgentResultStep,
  loadPromptReviewDecisionStep,
  prepareDirectAgentOperationStep,
  recordDirectAgentNodeStep,
  startDirectAgentOperationStep,
  submitPromptReviewDecisionStep,
} from "./direct-agent-workflow-steps.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const review = {
  promptReviewRequestId: "prr_directstep1" as never,
  requestRevision: 1,
  revision: 1,
  requestIndex: 1,
  payloadSha256: SHA_A,
  reviewSha256: SHA_B,
};

function installContext(input: {
  readonly api?: Record<string, ReturnType<typeof vi.fn>>;
  readonly bindings?: Record<string, ReturnType<typeof vi.fn>>;
  readonly directExecutor?: {
    readonly start: ReturnType<typeof vi.fn>;
    readonly submitDecision: ReturnType<typeof vi.fn>;
  };
  readonly trace?: ReturnType<typeof vi.fn>;
}) {
  setWorkflowRuntimeContext({
    api: (input.api ?? {}) as never,
    bindings: (input.bindings ?? {}) as never,
    memoryBackends: { list: () => [], get: () => undefined },
    workflowMemoryProviders: {
      list: () => [],
      getQuery: () => undefined,
      getWrite: () => undefined,
    },
    trace: (input.trace ?? vi.fn()) as never,
    now: () => "2026-08-19T08:00:00.000Z",
    bailian: {} as never,
    planner: vi.fn() as never,
    noteCapture: vi.fn() as never,
    executor: vi.fn() as never,
    ...(input.directExecutor === undefined
      ? {}
      : { directExecutor: input.directExecutor as never }),
  });
}

afterEach(() => setWorkflowRuntimeContext(undefined));

describe("Direct Agent Workflow Steps", () => {
  it("在同一Step内读取RunSpec并创建Attempt，checkpoint只返回引用与Hash", async () => {
    const loadWorkflowRunSpec = vi.fn(async () => ({
      runSpec: {
        productRunId: "run_directstep1",
        workflowRunSpecId: "wrs_directstep1",
        sha256: SHA_A,
        runner: {
          runnerFamily: "direct-agent.v1",
          runnerBundleVersion: "direct-agent.bundle.v1",
        },
        definitionRef: { blueprintKey: "direct" },
        businessInput: { kind: "direct_agent_message" },
        nodeResolutions: [
          {
            nodeType: "agent.direct",
            activation: "enabled",
            config: { capabilityMode: "read_only", promptReviewMode: "manual" },
          },
        ],
      },
    }));
    const beginDirectAgentAttempt = vi.fn(async () => ({
      directAgentAttemptId: "att_directagentstep1",
      inputManifestSha256: SHA_B,
      runRevision: 2,
    }));
    const trace = vi.fn();
    installContext({ api: { loadWorkflowRunSpec, beginDirectAgentAttempt }, trace });

    const result = await prepareDirectAgentOperationStep({
      productRunId: "run_directstep1",
      workflowAttemptId: "att_directworkflowstep1",
      workflowRunSpecId: "wrs_directstep1",
    });

    expect(result).toEqual({
      directAgentAttemptId: "att_directagentstep1",
      workflowRunSpecSha256: SHA_A,
      inputManifestSha256: SHA_B,
    });
    expect(beginDirectAgentAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        productRunId: "run_directstep1",
        workflowAttemptId: "att_directworkflowstep1",
      }),
    );
    const serialized = JSON.stringify({ result, events: trace.mock.calls });
    expect(serialized).not.toContain("canonicalPayloadJson");
    expect(serialized).not.toContain("sourceMessage");
  });

  it("Hook Binding只保存Request引用/版本/Hash，并从Product Store重载Decision引用", async () => {
    const claimPromptReviewHookBinding = vi.fn(async () => ({ alreadyExisted: false }));
    const loadPromptReviewDecision = vi.fn(async () => ({
      decision: {
        promptReviewDecisionId: "prd_directstep1",
        promptReviewRequestId: review.promptReviewRequestId,
        productRunId: "run_directstep1",
        requestRevision: 1,
        reviewSha256: SHA_B,
        payloadSha256: SHA_A,
        kind: "approve",
        revision: 1,
        decisionSha256: SHA_C,
      },
    }));
    installContext({
      api: { loadPromptReviewDecision },
      bindings: {
        getWorkflowBinding: vi.fn(() => ({
          workflowRunId: "wrun_private_directstep1",
          runnerFamily: "direct-agent.v1",
        })),
        claimPromptReviewHookBinding,
      },
    });

    await claimPromptReviewHookStep({
      productRunId: "run_directstep1",
      workflowAttemptId: "att_directworkflowstep1",
      review,
    });
    const decision = await loadPromptReviewDecisionStep({
      productRunId: "run_directstep1",
      workflowAttemptId: "att_directworkflowstep1",
      review,
      promptReviewDecisionId: "prd_directstep1",
    });

    expect(claimPromptReviewHookBinding).toHaveBeenCalledWith({
      promptReviewRequestId: "prr_directstep1",
      productRunId: "run_directstep1",
      startWorkflowRunId: "wrun_private_directstep1",
      requestRevision: 1,
      reviewSha256: SHA_B,
      hookToken: "prh-prr_directstep1",
      now: "2026-08-19T08:00:00.000Z",
    });
    expect(decision).toMatchObject({
      promptReviewDecisionId: "prd_directstep1",
      kind: "approve",
      decisionSha256: SHA_C,
    });
    expect(JSON.stringify(claimPromptReviewHookBinding.mock.calls)).not.toContain(
      "canonicalPayloadJson",
    );
  });

  it("只恢复同一个Direct Executor Operation，并在缺少Port时失败关闭", async () => {
    const start = vi.fn(async () => ({
      kind: "waiting_prompt_review" as const,
      operationId: "pio_directstep1",
      review,
    }));
    const submitDecision = vi.fn(async () => ({
      kind: "succeeded" as const,
      operationId: "pio_directstep1",
      result: { directAgentCandidateId: "drc_directstep1", sha256: SHA_C },
    }));
    const commitDirectAgentResult = vi.fn(async () => ({
      directAgentCandidateId: "drc_directstep1",
      messageId: "msg_directstep1",
      productRunId: "run_directstep1",
    }));
    installContext({
      api: { commitDirectAgentResult },
      directExecutor: { start, submitDecision },
    });

    const started = await startDirectAgentOperationStep({
      productRunId: "run_directstep1",
      workflowAttemptId: "att_directworkflowstep1",
      workflowRunSpecId: "wrs_directstep1",
      directAgentAttemptId: "att_directagentstep1",
      workflowRunSpecSha256: SHA_A,
      inputManifestSha256: SHA_B,
    });
    const resumed = await submitPromptReviewDecisionStep({
      productRunId: "run_directstep1",
      workflowAttemptId: "att_directworkflowstep1",
      operationId: started.operationId,
      directAgentAttemptId: "att_directagentstep1",
      review,
      promptReviewDecisionId: "prd_directstep1",
    });
    await commitDirectAgentResultStep({
      productRunId: "run_directstep1",
      workflowAttemptId: "att_directworkflowstep1",
      directAgentAttemptId: "att_directagentstep1",
      directAgentCandidateId: "drc_directstep1",
      candidateSha256: SHA_C,
    });

    expect(resumed.kind).toBe("succeeded");
    expect(start).toHaveBeenCalledTimes(1);
    expect(submitDecision).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "pio_directstep1", review }),
    );
    expect(commitDirectAgentResult).toHaveBeenCalledTimes(1);

    installContext({});
    await expect(
      startDirectAgentOperationStep({
        productRunId: "run_directstep1",
        workflowAttemptId: "att_directworkflowstep1",
        workflowRunSpecId: "wrs_directstep1",
        directAgentAttemptId: "att_directagentstep1",
        workflowRunSpecSha256: SHA_A,
        inputManifestSha256: SHA_B,
      }),
    ).rejects.toThrow("direct_executor.not_configured");
  });

  it("同一可见Agent节点承载执行与审核等待，attemptNumber=1且commandId稳定", async () => {
    const transitionConfigurablePlanningNode = vi.fn<
      (input: Record<string, unknown>) => Promise<{
        workflowNodeRunId: string;
        revision: number;
      }>
    >(async () => ({
      workflowNodeRunId: "wnr_directprojection1",
      revision: 2,
    }));
    installContext({ api: { transitionConfigurablePlanningNode } });

    const agentInput = {
      productRunId: "run_directstep1",
      workflowAttemptId: "att_directworkflowstep1",
      workflowRunSpecId: "wrs_directstep1",
      iteration: 3,
      toStatus: "waiting_human" as const,
      publicSummary: "等待审核",
    };
    await recordDirectAgentNodeStep(agentInput);
    await recordDirectAgentNodeStep(agentInput);
    await recordDirectAgentNodeStep({
      productRunId: "run_directstep1",
      workflowAttemptId: "att_directworkflowstep1",
      workflowRunSpecId: "wrs_directstep1",
      iteration: 3,
      toStatus: "running",
      publicSummary: "用户已批准",
    });

    const calls = transitionConfigurablePlanningNode.mock.calls.map(([call]) => call);
    expect(calls[0]).toMatchObject({
      definitionNodeId: "direct.agent",
      executionPath: [],
      attemptNumber: 1,
      toStatus: "waiting_human",
    });
    expect(calls[1]?.commandId).toBe(calls[0]?.commandId);
    expect(calls[2]).toMatchObject({
      definitionNodeId: "direct.agent",
      executionPath: [],
      attemptNumber: 1,
      toStatus: "running",
    });
    expect(calls[2]?.commandId).not.toBe(calls[0]?.commandId);
    expect(JSON.stringify(calls)).not.toContain("canonicalPayloadJson");
    expect(JSON.stringify(calls)).not.toContain("readablePrompt");
  });
});
