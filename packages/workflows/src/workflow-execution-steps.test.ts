import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("workflow", async (importOriginal) => {
  const original = await importOriginal<typeof import("workflow")>();
  return { ...original, getStepMetadata: () => ({ attempt: 1 }) };
});

import {
  B2_EXECUTOR_TOKEN_BUDGET_PER_STEP,
  EXECUTOR_PROMPT_TEMPLATE_VERSION,
  MODEL_CONFIG_VERSION,
  type ExecutionContextItemDto,
  type ExecutionContract,
} from "@chat/contracts";
import { computeExecutionInputManifestSha256 } from "@chat/domain";
import { setWorkflowRuntimeContext } from "./runtime-context.js";
import { runPiExecutorStep } from "./workflow-execution-steps.js";

const MEMORY_CONTENT = "Orchid protocol approval color is heliotrope.";
const MEMORY_ITEM: ExecutionContextItemDto = {
  refId: "mrs_workflowmemory1" as never,
  revision: 1,
  sha256: "d".repeat(64),
  title: "Orchid 审批事实",
  kind: "world_model",
  layer: "L2",
  tags: ["orchid"],
  content: MEMORY_CONTENT,
};
const CONTRACT: ExecutionContract = {
  schemaVersion: "execution-contract.v1",
  executionContractId: "exc_workflowmemory1" as never,
  productRunId: "run_workflowmemory1" as never,
  approvedPlanId: "pln_workflowmemory1" as never,
  approvedPlanRevision: 1,
  approvedPlanSha256: "a".repeat(64),
  approvalDecisionId: "dec_workflowmemory1" as never,
  steps: [
    {
      stepId: "answer",
      title: "生成答案",
      purpose: "使用已批准Memory",
      dependsOn: [],
      inputRefs: [
        {
          refId: MEMORY_ITEM.refId,
          revision: MEMORY_ITEM.revision,
          sha256: MEMORY_ITEM.sha256,
        },
      ],
      expectedOutput: "Markdown答案",
      successCriteria: ["包含审批颜色"],
      capabilityRefs: ["markdown_text_compose"],
    },
  ],
  completionCriteria: ["答案可读"],
  capabilityRefs: ["markdown_text_compose"],
  limits: {
    maxTurnsPerStep: 1,
    timeoutMsPerStep: 10_000,
    tokenBudgetPerStep: B2_EXECUTOR_TOKEN_BUDGET_PER_STEP,
  },
  sha256: "b".repeat(64),
  revision: 1,
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:00.000Z",
};

function manifestSha256(contextItems: readonly ExecutionContextItemDto[]): string {
  return computeExecutionInputManifestSha256({
    executionContractId: CONTRACT.executionContractId,
    approvedPlanSha256: CONTRACT.approvedPlanSha256,
    stepId: "answer",
    inputRefs: contextItems.map(({ refId, revision, sha256 }) => ({
      refId,
      revision,
      sha256,
    })),
    dependencyRefs: [],
    promptTemplateVersion: EXECUTOR_PROMPT_TEMPLATE_VERSION,
    modelConfigVersion: MODEL_CONFIG_VERSION,
  });
}

function installContext(executor: ReturnType<typeof vi.fn>, events: unknown[]): void {
  setWorkflowRuntimeContext({
    api: {} as never,
    bindings: {} as never,
    memoryBackends: { list: () => [], get: () => undefined },
    trace: (event) => events.push(event),
    now: () => "2026-08-08T00:00:00.000Z",
    bailian: {
      apiKey: "test-key",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      endpointHost: "dashscope.aliyuncs.com",
    },
    planner: vi.fn() as never,
    executor: executor as never,
  });
}

afterEach(() => setWorkflowRuntimeContext(undefined));

describe("runPiExecutorStep Memory输入证据", () => {
  it("只把当前Step的冻结条目传给pi Executor", async () => {
    const events: unknown[] = [];
    const executor = vi.fn(
      async (_input: { contextItems: readonly ExecutionContextItemDto[] }) => ({
        kind: "candidate" as const,
        candidate: {
          stepId: "answer",
          output: "审批颜色是heliotrope。",
          sections: [{ heading: "答案", body: "审批颜色是heliotrope。" }],
          successCriteriaEvidence: ["包含审批颜色：heliotrope"],
          criteriaEvidence: ["答案可读：已生成Markdown"],
          warnings: [],
        },
        durationMs: 10,
        providerCallCount: 1,
        providerMeta: {
          httpStatus: 200,
          providerRequestId: "req-memory-1",
          providerStopReason: "toolUse" as const,
          toolCallCount: 1,
        },
        usage: { inputTokens: 20, outputTokens: 10 },
      }),
    );
    installContext(executor, events);

    const result = await runPiExecutorStep({
      contract: CONTRACT,
      stepId: "answer",
      executionAttemptId: "att_workflowmemory1",
      inputManifestSha256: manifestSha256([MEMORY_ITEM]),
      contextItems: [MEMORY_ITEM],
      dependencyResults: [],
    });

    expect(result.output).toContain("heliotrope");
    expect(executor).toHaveBeenCalledWith(expect.objectContaining({ contextItems: [MEMORY_ITEM] }));
    expect(JSON.stringify(events)).not.toContain(MEMORY_CONTENT);
  });

  it("伪造revision/Hash与Approved Step不一致时不调用pi", async () => {
    const events: unknown[] = [];
    const executor = vi.fn();
    installContext(executor, events);
    const forged = { ...MEMORY_ITEM, sha256: "0".repeat(64) };

    await expect(
      runPiExecutorStep({
        contract: CONTRACT,
        stepId: "answer",
        executionAttemptId: "att_workflowmemory2",
        inputManifestSha256: manifestSha256([MEMORY_ITEM]),
        contextItems: [forged],
        dependencyResults: [],
      }),
    ).rejects.toMatchObject({ stableCode: "execution.context_ref_mismatch" });
    expect(executor).not.toHaveBeenCalled();
  });

  it("Provider成功但候选非法时只把pi节点记为失败", async () => {
    const events: Record<string, unknown>[] = [];
    const executor = vi.fn(async () => ({
      kind: "invalid_candidate" as const,
      errorCode: "schema_invalid" as const,
      durationMs: 12,
      providerCallCount: 1,
      providerMeta: {
        httpStatus: 200,
        providerRequestId: "req-memory-invalid-1",
        providerStopReason: "toolUse" as const,
        toolCallCount: 1,
      },
      usage: { inputTokens: 20, outputTokens: 5 },
      diagnostics: {
        stage: "tool_argument_schema" as const,
        fields: ["output"],
        issueCodes: ["invalid_type", "output.missing"],
      },
    }));
    installContext(executor, events);

    await expect(
      runPiExecutorStep({
        contract: CONTRACT,
        stepId: "answer",
        executionAttemptId: "att_workflowmemory3",
        inputManifestSha256: manifestSha256([MEMORY_ITEM]),
        contextItems: [MEMORY_ITEM],
        dependencyResults: [],
      }),
    ).rejects.toMatchObject({ stableCode: "model.candidate.schema_invalid" });

    expect(events.some((event) => event.eventName === "provider.request.completed")).toBe(true);
    expect(events.some((event) => event.eventName === "provider.request.failed")).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        eventName: "pi.node.failed",
        candidateValidation: {
          stage: "tool_argument_schema",
          fields: ["output"],
          issueCodes: ["invalid_type", "output.missing"],
        },
      }),
    );
  });
});
