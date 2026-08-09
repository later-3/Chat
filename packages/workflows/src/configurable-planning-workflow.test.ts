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
