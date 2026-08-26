import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createHook: vi.fn(),
  sleep: vi.fn(),
  loadRunSpec: vi.fn(),
  recordNode: vi.fn(),
  prepareLegacyMemoryContext: vi.fn(),
  prepareMemoryContext: vi.fn(),
  prepareProjectContext: vi.fn(),
  prepareRulesContext: vi.fn(),
  beginWorkflowMemoryQuery: vi.fn(),
  queryWorkflowMemoryProvider: vi.fn(),
  persistWorkflowMemoryQueryResult: vi.fn(),
  freezeWorkflowMemoryContext: vi.fn(),
  generatePlan: vi.fn(),
  claimDecisionHook: vi.fn(),
  expireApproval: vi.fn(),
  loadDecision: vi.fn(),
  executePersist: vi.fn(),
  validateExecution: vi.fn(),
  commitExecutionResult: vi.fn(),
  commitRejectedRun: vi.fn(),
  commitRunFailure: vi.fn(),
  commitRunOutcomeUnknown: vi.fn(),
}));

vi.mock("workflow", () => ({
  defineHook: () => ({ create: mocked.createHook }),
  sleep: mocked.sleep,
}));

vi.mock("./configurable-planning-steps.js", () => ({
  loadConfigurablePlanningRunSpecStep: mocked.loadRunSpec,
  recordConfigurablePlanningNodeStep: mocked.recordNode,
}));

vi.mock("./workflow-planning-steps.js", () => ({
  preparePlanningLegacyMemoryContextStep: mocked.prepareLegacyMemoryContext,
  preparePlanningMemoryContextStep: mocked.prepareMemoryContext,
  preparePlanningProjectContextStep: mocked.prepareProjectContext,
  preparePlanningRulesContextStep: mocked.prepareRulesContext,
  generateAndPublishPlanStep: mocked.generatePlan,
}));

vi.mock("./workflow-memory-steps.js", () => ({
  beginWorkflowMemoryQueryStep: mocked.beginWorkflowMemoryQuery,
  queryWorkflowMemoryProviderStep: mocked.queryWorkflowMemoryProvider,
  persistWorkflowMemoryQueryResultStep: mocked.persistWorkflowMemoryQueryResult,
  freezeWorkflowMemoryContextStep: mocked.freezeWorkflowMemoryContext,
}));

vi.mock("./workflow-decision-steps.js", () => ({
  claimConfigurableDecisionHookStep: mocked.claimDecisionHook,
  expireApprovalStep: mocked.expireApproval,
  loadCommittedDecisionStep: mocked.loadDecision,
}));

vi.mock("./workflow-execution-steps.js", () => ({
  executeAndPersistApprovedPlanStep: mocked.executePersist,
}));

vi.mock("./workflow-result-steps.js", () => ({
  validateExecutionStep: mocked.validateExecution,
  commitExecutionResultStep: mocked.commitExecutionResult,
  commitRejectedRunStep: mocked.commitRejectedRun,
  commitRunFailureStep: mocked.commitRunFailure,
  commitRunOutcomeUnknownStep: mocked.commitRunOutcomeUnknown,
}));

import { configurablePlanningWorkflow } from "./configurable-planning-workflow.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

const task = (definitionNodeId: string, nodeType: string, config = {}) => ({
  kind: "task",
  definitionNodeId,
  nodeType,
  schemaVersion: 1,
  config,
});

function runSpecFixture() {
  const optional = [
    ["planning.memory", "context.memory", "optional_unavailable"],
    ["planning.project", "context.project", "optional_unavailable"],
    ["planning.rules", "policy.rules", "optional_unavailable"],
    ["planning.skills", "capability.skills", "optional_unavailable"],
    ["planning.research", "agent.research", "no_evidence"],
  ] as const;
  return {
    workflowRunSpecId: "wrs_configurabletest1",
    productRunId: "run_configurabletest1",
    semanticRoot: {
      kind: "sequence",
      elements: [
        ...optional.map(([definitionNodeId, nodeType]) => task(definitionNodeId, nodeType)),
        {
          kind: "bounded_loop",
          body: {
            kind: "sequence",
            elements: [
              task("planning.plan", "agent.plan", { maxSteps: 8 }),
              task("planning.review", "human.plan_review", { reviewMode: "manual" }),
            ],
          },
          outcomeFromDefinitionNodeId: "planning.review",
          continueOutcomes: ["request_revision"],
          exitOutcomes: ["approved", "rejected"],
          maxIterations: 5,
          exceededPolicy: "fail",
        },
        {
          kind: "composite",
          definitionNodeId: "planning.execute",
          nodeType: "execute.plan",
          schemaVersion: 1,
          config: { maxActions: 16 },
        },
        task("planning.validate", "result.validate", { strictEvidence: true }),
        task("planning.commit", "product.commit"),
      ],
    },
    nodeResolutions: [
      ...optional.map(([definitionNodeId, nodeType]) => ({
        definitionNodeId,
        nodeType,
        schemaVersion: 1,
        config: {},
        activation: "enabled",
      })),
      ...[
        ["planning.plan", "agent.plan", { maxSteps: 8 }],
        ["planning.review", "human.plan_review", { reviewMode: "manual" }],
        ["planning.execute", "execute.plan", { maxActions: 16 }],
        ["planning.validate", "result.validate", { strictEvidence: true }],
        ["planning.commit", "product.commit", {}],
      ].map(([definitionNodeId, nodeType, config]) => ({
        definitionNodeId,
        nodeType,
        schemaVersion: 1,
        config,
        activation: "enabled",
      })),
    ],
    resourceResolutions: optional.slice(0, 4).map(([definitionNodeId, nodeType]) => ({
      definitionNodeId,
      resourceKind:
        nodeType === "context.memory"
          ? "memory"
          : nodeType === "context.project"
            ? "project"
            : nodeType === "policy.rules"
              ? "rule"
              : "skill",
      resolution: "excluded",
      exclusionReason: "not_selected",
    })),
    limits: { runtime: { maxNodeExecutions: 256, maxWaits: 16 } },
  } as never;
}

function workflowMemoryRunSpecFixture(required = false) {
  const fixture = structuredClone(runSpecFixture()) as {
    semanticRoot: { elements: Array<Record<string, unknown>> };
    nodeResolutions: Array<Record<string, unknown>>;
    resourceResolutions: Array<Record<string, unknown>>;
  };
  const config = {
    providerId: "mbk_tencentmemorycore",
    required,
    querySource: "source_message",
    maxResults: 8,
    maxContextCharacters: 8_000,
  };
  fixture.semanticRoot.elements = fixture.semanticRoot.elements.map((element) =>
    element["definitionNodeId"] === "planning.memory"
      ? task("planning.memory-query", "memory.query", config)
      : element,
  );
  fixture.nodeResolutions = fixture.nodeResolutions.map((resolution) =>
    resolution["definitionNodeId"] === "planning.memory"
      ? {
          definitionNodeId: "planning.memory-query",
          nodeType: "memory.query",
          schemaVersion: 1,
          config,
          activation: "enabled",
        }
      : resolution,
  );
  fixture.resourceResolutions = fixture.resourceResolutions.filter(
    (resolution) => resolution["definitionNodeId"] !== "planning.memory",
  );
  return fixture as never;
}

describe("Configurable Planning固定Runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.loadRunSpec.mockResolvedValue(runSpecFixture());
    mocked.recordNode.mockResolvedValue(undefined);
    mocked.prepareLegacyMemoryContext.mockResolvedValue({ status: "none" });
    mocked.prepareMemoryContext.mockResolvedValue({
      status: "ready",
      selectionRef: {
        planningMemorySelectionId: "pmsl_configurable1",
        revision: 1,
        sha256: SHA_A,
      },
    });
    mocked.prepareProjectContext.mockResolvedValue({ status: "none" });
    mocked.prepareRulesContext.mockResolvedValue({ status: "none" });
    mocked.beginWorkflowMemoryQuery.mockResolvedValue({
      status: "dispatch_required",
      workflowMemoryQueryId: "wmq_configurable1",
      query: { operationId: "wmq_configurable1" },
    });
    mocked.queryWorkflowMemoryProvider.mockResolvedValue({
      outcome: "success",
      resultSetSha256: SHA_A,
      sections: [],
    });
    mocked.persistWorkflowMemoryQueryResult.mockResolvedValue({
      status: "completed",
      snapshotCount: 1,
    });
    mocked.freezeWorkflowMemoryContext.mockResolvedValue({ status: "none" });
    mocked.sleep.mockImplementation(() => new Promise(() => undefined));
    let hookIndex = 0;
    mocked.createHook.mockImplementation(() => {
      hookIndex += 1;
      const signal = Promise.resolve({
        decisionId: hookIndex === 1 ? "dec_revision1" : "dec_approve2",
      });
      return {
        getConflict: async () => null,
        then: signal.then.bind(signal),
        [Symbol.dispose]: () => undefined,
      };
    });
    mocked.generatePlan.mockImplementation(async (input: { planRevision: number }) => {
      const revision = input.planRevision;
      return {
        status: "published",
        review: {
          planId: "pln_configurable1",
          planRevision: revision,
          planSha256: revision === 1 ? SHA_A : SHA_B,
          approvalRequestId: `apr_configurable${String(revision)}`,
          approvalExpiresAt: "2026-08-11T00:00:00.000Z",
        },
      };
    });
    mocked.claimDecisionHook.mockResolvedValue(undefined);
    mocked.loadDecision
      .mockResolvedValueOnce({ decisionId: "dec_revision1", kind: "request_revision" })
      .mockResolvedValueOnce({ decisionId: "dec_approve2", kind: "approve" });
    mocked.executePersist.mockResolvedValue({
      status: "persisted",
      refs: {
        executionContractId: "exc_configurable1",
        approvedPlanSha256: SHA_B,
        executionCandidateId: "xcd_configurable1",
        executionCandidateSha256: SHA_B,
      },
    });
    mocked.validateExecution.mockResolvedValue({
      outcome: "pass",
      validationResultId: "val_configurable1",
      failures: [],
    });
    mocked.commitExecutionResult.mockResolvedValue(undefined);
    mocked.commitRunFailure.mockResolvedValue(undefined);
    mocked.commitRunOutcomeUnknown.mockResolvedValue(undefined);
  });

  it("按RunSpec跳过optional节点，两轮审核后复用真实执行/验证/提交边界", async () => {
    const result = await configurablePlanningWorkflow({
      schemaVersion: "configurable-planning-workflow-input.v1",
      productRunId: "run_configurabletest1",
      attemptId: "att_workflow1",
      workflowRunSpecId: "wrs_configurabletest1",
    });

    expect(result.outcome).toBe("product_committed");
    expect(mocked.loadRunSpec).toHaveBeenCalledTimes(1);
    expect(mocked.generatePlan).toHaveBeenCalledTimes(2);
    expect(mocked.claimDecisionHook).toHaveBeenCalledTimes(2);
    expect(mocked.executePersist).toHaveBeenCalledTimes(1);
    expect(mocked.validateExecution).toHaveBeenCalledTimes(1);
    expect(mocked.commitExecutionResult).toHaveBeenCalledTimes(1);
    expect(mocked.commitRunFailure).not.toHaveBeenCalled();
    expect(mocked.prepareLegacyMemoryContext).toHaveBeenCalledTimes(1);
    expect(
      mocked.recordNode.mock.calls
        .map(([call]) => call)
        .filter((call) => call.toStatus === "skipped"),
    ).toHaveLength(3);
    expect(mocked.prepareProjectContext).toHaveBeenCalledTimes(1);
    expect(mocked.prepareRulesContext).toHaveBeenCalledTimes(1);
    expect(
      mocked.recordNode.mock.calls
        .map(([call]) => call)
        .filter(
          (call) =>
            call.definitionNodeId === "planning.plan" ||
            call.definitionNodeId === "planning.review" ||
            call.definitionNodeId === "planning.execute" ||
            call.definitionNodeId === "planning.validate" ||
            call.definitionNodeId === "planning.commit",
        ),
    ).toEqual([]);
    expect(mocked.createHook).toHaveBeenNthCalledWith(1, {
      token: "apr_configurable1",
    });
    expect(mocked.claimDecisionHook).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ approvalRequestId: "apr_configurable1" }),
    );
  });

  it("服务端验证失败时阻断Product Commit并以稳定结果关闭Run", async () => {
    mocked.validateExecution.mockResolvedValueOnce({
      outcome: "fail",
      validationResultId: "val_configurable_failed1",
      failures: [{ code: "evidence_missing", message: "缺少完成门证据" }],
    });

    const result = await configurablePlanningWorkflow({
      schemaVersion: "configurable-planning-workflow-input.v1",
      productRunId: "run_configurabletest1",
      attemptId: "att_workflow1",
      workflowRunSpecId: "wrs_configurabletest1",
    });

    expect(result).toMatchObject({
      outcome: "failed",
      errorCode: "execution.validation_failed",
    });
    expect(mocked.executePersist).toHaveBeenCalledTimes(1);
    expect(mocked.validateExecution).toHaveBeenCalledTimes(1);
    expect(mocked.commitExecutionResult).not.toHaveBeenCalled();
    expect(mocked.commitRunFailure).toHaveBeenCalledTimes(1);
  });

  it("memory.query按独立耐久边界执行，并在第一个Planner前冻结唯一Context", async () => {
    mocked.loadRunSpec.mockResolvedValue(workflowMemoryRunSpecFixture());
    mocked.freezeWorkflowMemoryContext.mockResolvedValue({
      status: "ready",
      contextRef: {
        workflowMemoryContextId: "wmc_configurable1",
        revision: 1,
        sha256: SHA_A,
      },
    });

    const result = await configurablePlanningWorkflow({
      schemaVersion: "configurable-planning-workflow-input.v1",
      productRunId: "run_configurabletest1",
      attemptId: "att_workflow1",
      workflowRunSpecId: "wrs_configurabletest1",
    });

    expect(result.outcome).toBe("product_committed");
    expect(mocked.beginWorkflowMemoryQuery).toHaveBeenCalledTimes(1);
    expect(mocked.queryWorkflowMemoryProvider).toHaveBeenCalledTimes(1);
    expect(mocked.persistWorkflowMemoryQueryResult).toHaveBeenCalledTimes(1);
    expect(mocked.freezeWorkflowMemoryContext).toHaveBeenCalledTimes(1);
    expect(mocked.generatePlan).toHaveBeenCalledTimes(2);
    for (const [call] of mocked.generatePlan.mock.calls) {
      expect(call).toMatchObject({
        workflowMemoryContextRef: {
          workflowMemoryContextId: "wmc_configurable1",
          revision: 1,
          sha256: SHA_A,
        },
      });
    }
  });

  it("可选memory.query失败继续规划，必需失败则在Planner前关闭", async () => {
    mocked.loadRunSpec.mockResolvedValue(workflowMemoryRunSpecFixture());
    mocked.persistWorkflowMemoryQueryResult.mockResolvedValueOnce({
      status: "optional_failed",
      snapshotCount: 0,
    });
    mocked.freezeWorkflowMemoryContext.mockResolvedValueOnce({
      status: "ready",
      contextRef: {
        workflowMemoryContextId: "wmc_optionalfailed1",
        revision: 1,
        sha256: SHA_A,
      },
    });
    await expect(
      configurablePlanningWorkflow({
        schemaVersion: "configurable-planning-workflow-input.v1",
        productRunId: "run_configurabletest1",
        attemptId: "att_workflow1",
        workflowRunSpecId: "wrs_configurabletest1",
      }),
    ).resolves.toMatchObject({ outcome: "product_committed" });

    vi.clearAllMocks();
    mocked.loadRunSpec.mockResolvedValue(workflowMemoryRunSpecFixture(true));
    mocked.recordNode.mockResolvedValue(undefined);
    mocked.beginWorkflowMemoryQuery.mockResolvedValue({
      status: "required_failed",
      workflowMemoryQueryId: "wmq_requiredfailed1",
    });
    mocked.commitRunFailure.mockResolvedValue(undefined);
    await expect(
      configurablePlanningWorkflow({
        schemaVersion: "configurable-planning-workflow-input.v1",
        productRunId: "run_configurabletest1",
        attemptId: "att_workflow1",
        workflowRunSpecId: "wrs_configurabletest1",
      }),
    ).resolves.toMatchObject({
      outcome: "failed",
      errorCode: "configurable_planning.required_unavailable",
    });
    expect(mocked.queryWorkflowMemoryProvider).not.toHaveBeenCalled();
    expect(mocked.freezeWorkflowMemoryContext).not.toHaveBeenCalled();
    expect(mocked.generatePlan).not.toHaveBeenCalled();
    expect(mocked.commitRunFailure).toHaveBeenCalledTimes(1);
  });

  it("Composite结果未知不重试Executor，写Node与Product Run unknown且不进入验证/提交", async () => {
    mocked.loadDecision
      .mockReset()
      .mockResolvedValue({ decisionId: "dec_approve1", kind: "approve" });
    mocked.createHook.mockImplementation(() => {
      const signal = Promise.resolve({ decisionId: "dec_approve1" });
      return {
        getConflict: async () => null,
        then: signal.then.bind(signal),
        [Symbol.dispose]: () => undefined,
      };
    });
    mocked.executePersist.mockResolvedValueOnce({
      status: "outcome_unknown",
      errorCode: "execution.outcome_unknown",
    });

    const result = await configurablePlanningWorkflow({
      schemaVersion: "configurable-planning-workflow-input.v1",
      productRunId: "run_configurabletest1",
      attemptId: "att_workflow1",
      workflowRunSpecId: "wrs_configurabletest1",
    });

    expect(result).toMatchObject({ outcome: "outcome_unknown" });
    expect(mocked.executePersist).toHaveBeenCalledTimes(1);
    expect(mocked.commitRunOutcomeUnknown).toHaveBeenCalledTimes(1);
    expect(mocked.validateExecution).not.toHaveBeenCalled();
    expect(mocked.commitExecutionResult).not.toHaveBeenCalled();
    expect(mocked.commitRunFailure).not.toHaveBeenCalled();
    expect(
      mocked.recordNode.mock.calls
        .map(([call]) => call)
        .some((call) => call.definitionNodeId === "planning.execute"),
    ).toBe(false);
  });

  it("冻结Memory/Project/Rule资源只准备一次，并在两轮修订中复用同一ref编译Planning Input", async () => {
    const runSpec = runSpecFixture() as {
      resourceResolutions: Array<Record<string, unknown>>;
    };
    runSpec.resourceResolutions = runSpec.resourceResolutions.map((resolution) =>
      resolution["definitionNodeId"] === "planning.memory"
        ? {
            definitionNodeId: "planning.memory",
            resourceKind: "memory",
            resourceId: "mrs_selected1",
            expectedRevision: 1,
            expectedSha256: SHA_A,
            resolution: "included",
          }
        : resolution["definitionNodeId"] === "planning.project"
          ? {
              definitionNodeId: "planning.project",
              resourceKind: "project",
              resourceId: "prj_selected1",
              expectedRevision: 2,
              expectedSha256: SHA_A,
              resolution: "included",
            }
          : resolution["definitionNodeId"] === "planning.rules"
            ? {
                definitionNodeId: "planning.rules",
                resourceKind: "rule",
                resourceId: "rul_selected1",
                expectedRevision: 3,
                expectedSha256: SHA_B,
                resolution: "included",
              }
            : resolution,
    );
    mocked.loadRunSpec.mockResolvedValue(runSpec);
    mocked.prepareProjectContext.mockResolvedValue({
      status: "ready",
      contextRef: {
        planningProjectContextId: "pcx_configurable1",
        revision: 1,
        sha256: SHA_A,
      },
    });
    mocked.prepareRulesContext.mockResolvedValue({
      status: "ready",
      selectionRef: { ruleSelectionId: "rsl_configurable1", revision: 1, sha256: SHA_B },
    });

    const result = await configurablePlanningWorkflow({
      schemaVersion: "configurable-planning-workflow-input.v1",
      productRunId: "run_configurabletest1",
      attemptId: "att_workflow1",
      workflowRunSpecId: "wrs_configurabletest1",
    });

    expect(result.outcome).toBe("product_committed");
    expect(mocked.prepareMemoryContext).toHaveBeenCalledTimes(1);
    expect(mocked.prepareLegacyMemoryContext).not.toHaveBeenCalled();
    expect(mocked.prepareProjectContext).toHaveBeenCalledTimes(1);
    expect(mocked.prepareRulesContext).toHaveBeenCalledTimes(1);
    expect(mocked.generatePlan).toHaveBeenCalledTimes(2);
    for (const [call] of mocked.generatePlan.mock.calls) {
      expect(call).toMatchObject({
        planningMemorySelectionRef: {
          planningMemorySelectionId: "pmsl_configurable1",
          revision: 1,
          sha256: SHA_A,
        },
        planningProjectContextRef: {
          planningProjectContextId: "pcx_configurable1",
          revision: 1,
          sha256: SHA_A,
        },
        ruleSelectionRef: {
          ruleSelectionId: "rsl_configurable1",
          revision: 1,
          sha256: SHA_B,
        },
      });
    }
    expect(
      mocked.recordNode.mock.calls
        .map(([call]) => call)
        .some((call) => call.definitionNodeId === "planning.memory"),
    ).toBe(false);
    expect(
      mocked.recordNode.mock.calls
        .map(([call]) => call)
        .some(
          (call) =>
            call.definitionNodeId === "planning.project" ||
            call.definitionNodeId === "planning.rules",
        ),
    ).toBe(false);
    expect(mocked.commitRunFailure).not.toHaveBeenCalled();
  });

  it("已选择Project却无法冻结时不伪造Node终态并以稳定Product Run失败关闭", async () => {
    const runSpec = runSpecFixture() as {
      resourceResolutions: Array<Record<string, unknown>>;
    };
    runSpec.resourceResolutions = runSpec.resourceResolutions.map((resolution) =>
      resolution["definitionNodeId"] === "planning.project"
        ? {
            definitionNodeId: "planning.project",
            resourceKind: "project",
            resourceId: "prj_stale1",
            expectedRevision: 2,
            expectedSha256: SHA_A,
            resolution: "included",
          }
        : resolution,
    );
    mocked.loadRunSpec.mockResolvedValue(runSpec);
    mocked.prepareProjectContext.mockRejectedValueOnce(new Error("resource_stale"));

    const result = await configurablePlanningWorkflow({
      schemaVersion: "configurable-planning-workflow-input.v1",
      productRunId: "run_configurabletest1",
      attemptId: "att_workflow1",
      workflowRunSpecId: "wrs_configurabletest1",
    });

    expect(result).toMatchObject({
      outcome: "failed",
      errorCode: "configurable_planning.project_context_unavailable",
    });
    expect(
      mocked.recordNode.mock.calls
        .map(([call]) => call)
        .some((call) => call.definitionNodeId === "planning.project"),
    ).toBe(false);
    expect(mocked.generatePlan).not.toHaveBeenCalled();
    expect(mocked.commitRunFailure).toHaveBeenCalledTimes(1);
  });

  it("第5轮仍要求修订时按冻结loop上限失败，不调用Executor", async () => {
    mocked.loadDecision.mockReset().mockResolvedValue({
      decisionId: "dec_revisionlimit1",
      kind: "request_revision",
    });
    mocked.createHook.mockImplementation(() => {
      const signal = Promise.resolve({ decisionId: "dec_revisionlimit1" });
      return {
        getConflict: async () => null,
        then: signal.then.bind(signal),
        [Symbol.dispose]: () => undefined,
      };
    });

    const result = await configurablePlanningWorkflow({
      schemaVersion: "configurable-planning-workflow-input.v1",
      productRunId: "run_configurabletest1",
      attemptId: "att_workflow1",
      workflowRunSpecId: "wrs_configurabletest1",
    });

    expect(result).toMatchObject({
      outcome: "failed",
      errorCode: "plan_revision_limit_reached",
    });
    expect(mocked.generatePlan).toHaveBeenCalledTimes(5);
    expect(mocked.claimDecisionHook).toHaveBeenCalledTimes(5);
    expect(mocked.executePersist).not.toHaveBeenCalled();
    expect(mocked.commitRunFailure).toHaveBeenCalledTimes(1);
  });
});
