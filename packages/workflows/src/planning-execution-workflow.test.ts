import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createHook: vi.fn(),
  sleep: vi.fn(),
  beginPlanningContextStep: vi.fn(),
  queryMemoryContextStep: vi.fn(),
  persistPlanningContextResultStep: vi.fn(),
  compilePlanningInputStep: vi.fn(),
  runPiPlannerStep: vi.fn(),
  publishPlanReviewStep: vi.fn(),
  claimDecisionHookStep: vi.fn(),
  expireApprovalStep: vi.fn(),
  loadCommittedDecisionStep: vi.fn(),
  beginExecutionAttemptStep: vi.fn(),
  completeRunAttemptStep: vi.fn(),
  compileExecutionContractStep: vi.fn(),
  runPiExecutorStep: vi.fn(),
  commitExecutionResultStep: vi.fn(),
  commitRejectedRunStep: vi.fn(),
  commitRunFailureStep: vi.fn(),
  persistExecutionCandidateStep: vi.fn(),
  validateExecutionStep: vi.fn(),
}));

vi.mock("workflow", () => ({
  defineHook: () => ({ create: mocked.createHook }),
  sleep: mocked.sleep,
}));

vi.mock("./workflow-planning-steps.js", () => ({
  beginPlanningContextStep: mocked.beginPlanningContextStep,
  queryMemoryContextStep: mocked.queryMemoryContextStep,
  persistPlanningContextResultStep: mocked.persistPlanningContextResultStep,
  compilePlanningInputStep: mocked.compilePlanningInputStep,
  runPiPlannerStep: mocked.runPiPlannerStep,
  publishPlanReviewStep: mocked.publishPlanReviewStep,
}));

vi.mock("./workflow-decision-steps.js", () => ({
  claimDecisionHookStep: mocked.claimDecisionHookStep,
  expireApprovalStep: mocked.expireApprovalStep,
  loadCommittedDecisionStep: mocked.loadCommittedDecisionStep,
}));

vi.mock("./workflow-execution-steps.js", () => ({
  beginExecutionAttemptStep: mocked.beginExecutionAttemptStep,
  completeRunAttemptStep: mocked.completeRunAttemptStep,
  compileExecutionContractStep: mocked.compileExecutionContractStep,
  runPiExecutorStep: mocked.runPiExecutorStep,
}));

vi.mock("./workflow-result-steps.js", () => ({
  commitExecutionResultStep: mocked.commitExecutionResultStep,
  commitRejectedRunStep: mocked.commitRejectedRunStep,
  commitRunFailureStep: mocked.commitRunFailureStep,
  persistExecutionCandidateStep: mocked.persistExecutionCandidateStep,
  validateExecutionStep: mocked.validateExecutionStep,
}));

import { planningExecutionWorkflow } from "./planning-execution-workflow.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const CONTEXT_PACKAGE_ID = "ctxp_frozenmemory1";
const MEMORY_REF = {
  refId: "mrs_frozenmemory1",
  revision: 1,
  sha256: SHA_B,
} as const;
const EXECUTION_CONTEXT_ITEM = {
  ...MEMORY_REF,
  title: "冻结周报事实",
  kind: "trace",
  layer: "L2",
  tags: ["weekly"],
  content: "Orchid 项目已进入已批准状态。",
} as const;
const MEMORY_QUERY = {
  memoryQueryId: "mqy_frozenmemory1",
  contextRequestId: "ctxr_frozenmemory1",
  productRunId: "run_contextreuse1",
  productSessionId: "psn_contextreuse1",
  backendId: "mbk_memmy",
  backendDescriptor: {
    backendId: "mbk_memmy",
    displayName: "memmy 本地记忆",
    kind: "memmy",
    adapterContractVersion: "memmy-http-query.v1",
    configured: true,
    authMode: "none",
    credentialRevision: "none",
    configurationFingerprint: SHA_B,
    capabilities: {
      query: true,
      tags: true,
      layers: ["L2"],
      maxLimit: 20,
      maxContextBudget: 8192,
    },
  },
  backendDescriptorSha256: SHA_A,
  requirement: "required",
  sourceMessageSha256: SHA_B,
  queryText: "根据冻结Memory规划周报",
  tags: ["weekly"],
  layers: ["L2"],
  limit: 3,
  contextBudget: 512,
} as const;

describe("PlanningExecutionWorkflow M1 ContextPackage复用", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let hookIndex = 0;
    mocked.createHook.mockImplementation(() => {
      hookIndex += 1;
      const signal = Promise.resolve({
        decisionId: hookIndex === 1 ? "dec_revision1" : "dec_approve1",
      });
      return {
        getConflict: async () => null,
        then: signal.then.bind(signal),
        [Symbol.dispose]: () => undefined,
      };
    });
    mocked.sleep.mockImplementation(() => new Promise(() => undefined));
    mocked.beginPlanningContextStep.mockResolvedValue({
      schemaVersion: "chat-internal-runtime.v1",
      status: "dispatch_required",
      query: MEMORY_QUERY,
    });
    mocked.queryMemoryContextStep.mockResolvedValue({
      outcome: "success",
      externalQueryId: "query-frozen-1",
      hitCount: 0,
      tokenEstimate: 0,
      resultSetSha256: SHA_B,
      sections: [],
    });
    mocked.persistPlanningContextResultStep.mockResolvedValue({
      schemaVersion: "chat-internal-runtime.v1",
      status: "ready",
      contextPackageRef: {
        contextPackageId: CONTEXT_PACKAGE_ID,
        revision: 1,
        sha256: SHA_A,
      },
    });
    mocked.compilePlanningInputStep.mockImplementation(
      async (input: { productRunId: string; planRevision: number }) => ({
        schemaVersion: "chat-internal-runtime.v1",
        productRunId: input.productRunId,
        attemptId: `att_plan${String(input.planRevision)}`,
        inputRunRevision: input.planRevision + 1,
        inputManifestSha256: input.planRevision === 1 ? SHA_A : SHA_B,
        sourceMessageRef: { messageId: "msg_source1", sha256: SHA_A },
        sourceMessageText: "根据冻结Memory规划周报",
        planRevision: input.planRevision,
        limits: { maxTurns: 1, timeoutMs: 120_000, tokenBudget: 4_096 },
        promptTemplateVersion: "planner-prompt.v2",
        modelConfigVersion: "bailian.qwen3.7-plus.v1",
      }),
    );
    mocked.runPiPlannerStep.mockResolvedValue({
      objective: "生成周报",
      summary: "使用已冻结上下文",
      assumptions: [],
      openQuestions: [],
      steps: [
        {
          stepId: "step-1",
          title: "生成",
          purpose: "生成周报",
          dependsOn: [],
          inputRefs: [MEMORY_REF],
          expectedOutput: "Markdown周报",
          successCriteria: ["有正式输出"],
          requestedCapabilities: ["markdown_text_compose"],
          risk: "low",
        },
      ],
      completionCriteria: ["周报完成"],
      warnings: [],
    });
    mocked.publishPlanReviewStep.mockImplementation(
      async (input: { planningAttemptId: string }) => {
        const revision = input.planningAttemptId.endsWith("1") ? 1 : 2;
        return {
          planId: "pln_plan1",
          planRevision: revision,
          planSha256: revision === 1 ? SHA_A : SHA_B,
          approvalRequestId: `apr_review${String(revision)}`,
          approvalExpiresAt: "2026-08-09T00:00:00.000Z",
        };
      },
    );
    mocked.claimDecisionHookStep.mockResolvedValue(undefined);
    mocked.loadCommittedDecisionStep
      .mockResolvedValueOnce({ decisionId: "dec_revision1", kind: "request_revision" })
      .mockResolvedValueOnce({ decisionId: "dec_approve1", kind: "approve" });
    mocked.compileExecutionContractStep.mockResolvedValue({
      executionContractId: "exc_contract1",
      approvedPlanSha256: SHA_B,
      steps: [{ stepId: "step-1", dependsOn: [], inputRefs: [MEMORY_REF] }],
    });
    mocked.beginExecutionAttemptStep.mockResolvedValue({
      attemptId: "att_execute1",
      inputManifestSha256: SHA_A,
      contextItems: [EXECUTION_CONTEXT_ITEM],
    });
    mocked.runPiExecutorStep.mockResolvedValue({
      stepId: "step-1",
      executionAttemptId: "att_execute1",
      inputManifestSha256: SHA_A,
      dependencyRefs: [],
      output: "周报",
      sections: [{ heading: "周报", body: "完成" }],
      successCriteriaEvidence: ["已生成"],
      criteriaEvidence: ["周报完成"],
      warnings: [],
      sha256: SHA_B,
    });
    mocked.completeRunAttemptStep.mockResolvedValue(undefined);
    mocked.persistExecutionCandidateStep.mockResolvedValue({
      executionCandidateId: "xcd_candidate1",
      sha256: SHA_B,
    });
    mocked.validateExecutionStep.mockResolvedValue({
      outcome: "pass",
      validationResultId: "val_result1",
      failures: [],
    });
    mocked.commitExecutionResultStep.mockResolvedValue(undefined);
  });

  it("在修订循环外只准备一次，Plan v1/v2传递同一ContextPackage", async () => {
    const result = await planningExecutionWorkflow({
      schemaVersion: "planning-execution-workflow-input.v1",
      productRunId: "run_contextreuse1" as never,
      attemptId: "att_workflow1" as never,
      maxPlanRevisions: 5,
    });

    expect(result.outcome).toBe("product_committed");
    expect(mocked.beginPlanningContextStep).toHaveBeenCalledTimes(1);
    expect(mocked.beginPlanningContextStep).toHaveBeenCalledWith({
      productRunId: "run_contextreuse1",
      attemptId: "att_workflow1",
    });
    expect(mocked.queryMemoryContextStep).toHaveBeenCalledTimes(1);
    expect(mocked.persistPlanningContextResultStep).toHaveBeenCalledTimes(1);
    expect(mocked.beginPlanningContextStep.mock.invocationCallOrder[0]).toBeLessThan(
      mocked.queryMemoryContextStep.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocked.queryMemoryContextStep.mock.invocationCallOrder[0]).toBeLessThan(
      mocked.persistPlanningContextResultStep.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocked.persistPlanningContextResultStep.mock.invocationCallOrder[0]).toBeLessThan(
      mocked.compilePlanningInputStep.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocked.compilePlanningInputStep).toHaveBeenCalledTimes(2);
    expect(mocked.compilePlanningInputStep.mock.calls.map(([input]) => input)).toEqual([
      {
        productRunId: "run_contextreuse1",
        attemptId: "att_workflow1",
        planRevision: 1,
        contextPackageRef: {
          contextPackageId: CONTEXT_PACKAGE_ID,
          revision: 1,
          sha256: SHA_A,
        },
      },
      {
        productRunId: "run_contextreuse1",
        attemptId: "att_workflow1",
        planRevision: 2,
        contextPackageRef: {
          contextPackageId: CONTEXT_PACKAGE_ID,
          revision: 1,
          sha256: SHA_A,
        },
      },
    ]);
    expect(mocked.runPiPlannerStep).toHaveBeenCalledTimes(2);
    expect(mocked.runPiExecutorStep).toHaveBeenCalledWith(
      expect.objectContaining({ contextItems: [EXECUTION_CONTEXT_ITEM] }),
    );
    expect(mocked.commitRunFailureStep).not.toHaveBeenCalled();
  });

  it("未选Memory时仍只准备一次且不伪造ContextPackage引用", async () => {
    mocked.beginPlanningContextStep.mockResolvedValueOnce({
      schemaVersion: "chat-internal-runtime.v1",
      status: "none",
    });

    const result = await planningExecutionWorkflow({
      schemaVersion: "planning-execution-workflow-input.v1",
      productRunId: "run_nocontext1" as never,
      attemptId: "att_workflow3" as never,
      maxPlanRevisions: 5,
    });

    expect(result.outcome).toBe("product_committed");
    expect(mocked.beginPlanningContextStep).toHaveBeenCalledTimes(1);
    expect(mocked.queryMemoryContextStep).not.toHaveBeenCalled();
    expect(mocked.persistPlanningContextResultStep).not.toHaveBeenCalled();
    expect(mocked.compilePlanningInputStep.mock.calls.map(([input]) => input)).toEqual([
      {
        productRunId: "run_nocontext1",
        attemptId: "att_workflow3",
        planRevision: 1,
      },
      {
        productRunId: "run_nocontext1",
        attemptId: "att_workflow3",
        planRevision: 2,
      },
    ]);
  });

  it("可选Memory失败后仍使用带Hash的排除包继续规划", async () => {
    mocked.queryMemoryContextStep.mockResolvedValueOnce({
      outcome: "failure",
      errorCode: "memory.backend.timeout",
    });
    mocked.persistPlanningContextResultStep.mockResolvedValueOnce({
      schemaVersion: "chat-internal-runtime.v1",
      status: "optional_failed",
      contextPackageRef: {
        contextPackageId: CONTEXT_PACKAGE_ID,
        revision: 1,
        sha256: SHA_A,
      },
    });

    const result = await planningExecutionWorkflow({
      schemaVersion: "planning-execution-workflow-input.v1",
      productRunId: "run_optional1" as never,
      attemptId: "att_workflow4" as never,
      maxPlanRevisions: 5,
    });

    expect(result.outcome).toBe("product_committed");
    expect(mocked.queryMemoryContextStep).toHaveBeenCalledTimes(1);
    expect(mocked.compilePlanningInputStep).toHaveBeenCalledWith({
      productRunId: "run_optional1",
      attemptId: "att_workflow4",
      planRevision: 1,
      contextPackageRef: {
        contextPackageId: CONTEXT_PACKAGE_ID,
        revision: 1,
        sha256: SHA_A,
      },
    });
    expect(mocked.commitRunFailureStep).not.toHaveBeenCalled();
  });

  it("必需Memory准备失败时在首次Planner前安全收敛", async () => {
    mocked.queryMemoryContextStep.mockResolvedValueOnce({
      outcome: "failure",
      errorCode: "memory.backend.timeout",
    });
    mocked.persistPlanningContextResultStep.mockResolvedValueOnce({
      schemaVersion: "chat-internal-runtime.v1",
      status: "required_failed",
    });

    const result = await planningExecutionWorkflow({
      schemaVersion: "planning-execution-workflow-input.v1",
      productRunId: "run_contextfailed1" as never,
      attemptId: "att_workflow2" as never,
      maxPlanRevisions: 5,
    });

    expect(result).toEqual({
      outcome: "failed",
      productRunId: "run_contextfailed1",
      errorCode: "memory_context_required_failed",
    });
    expect(mocked.compilePlanningInputStep).not.toHaveBeenCalled();
    expect(mocked.runPiPlannerStep).not.toHaveBeenCalled();
    expect(mocked.commitRunFailureStep).toHaveBeenCalledWith({
      productRunId: "run_contextfailed1",
      attemptId: "att_workflow2",
      errorCode: "memory_context_required_failed",
      summary: "必需Memory上下文不可用，后台工作已安全停止",
    });
  });
});
