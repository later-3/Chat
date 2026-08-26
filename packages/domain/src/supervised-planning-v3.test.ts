import { describe, expect, it } from "vitest";
import {
  assertSupervisedStepStateTransitionV3,
  computeSupervisedStepStateSha256V3,
  type SupervisedStepStateV3Shape,
} from "./supervised-planning-v3.js";

const NOW = "2026-08-26T08:00:00.000Z";
const SHA = (character: string) => character.repeat(64);

function state(
  overrides: Partial<SupervisedStepStateV3Shape> & Pick<SupervisedStepStateV3Shape, "status">,
): SupervisedStepStateV3Shape {
  const { status, ...rest } = overrides;
  const value: SupervisedStepStateV3Shape = {
    supervisedStepStateId: "sss_state1",
    status,
    stepIdentity: {
      productRunId: "run_supervised1",
      planningEpochRef: {
        planningEpochId: "spe_epoch1",
        epochNumber: 1,
        revision: 1,
        sha256: SHA("1"),
      },
      executionContractRef: {
        executionContractId: "exc_contract1",
        revision: 1,
        sha256: SHA("2"),
      },
      stepId: "draft",
      stepRevision: 1,
    },
    productRunRevisionBaseline: 3,
    limits: {
      maxExecutorRoundsPerStep: 3,
      maxReviewerRoundsPerStep: 3,
      maxPlanRevisions: 2,
    },
    successCriteriaRefs: [{ criterionIndex: 0, sha256: SHA("3") }],
    dependencyStepIds: [],
    remainingStepIds: ["draft"],
    executorRound: 1,
    reviewerRound: 0,
    revision: 1,
    updatedAt: NOW,
    ...rest,
  };
  return { ...value, sha256: computeSupervisedStepStateSha256V3(value) };
}

function nextState(
  from: SupervisedStepStateV3Shape,
  overrides: Partial<SupervisedStepStateV3Shape> & Pick<SupervisedStepStateV3Shape, "status">,
): SupervisedStepStateV3Shape {
  return state({
    supervisedStepStateId: `${from.supervisedStepStateId}next`,
    previousStateRef: {
      supervisedStepStateId: from.supervisedStepStateId,
      revision: from.revision,
      stepRevision: from.stepIdentity.stepRevision,
      sha256: from.sha256!,
    },
    stepIdentity: from.stepIdentity,
    productRunRevisionBaseline: from.productRunRevisionBaseline,
    limits: from.limits,
    successCriteriaRefs: from.successCriteriaRefs,
    dependencyStepIds: from.dependencyStepIds,
    remainingStepIds: from.remainingStepIds,
    executorRound: from.executorRound,
    reviewerRound: from.reviewerRound,
    revision: from.revision + 1,
    updatedAt: "2026-08-26T08:00:01.000Z",
    ...overrides,
  });
}

describe("监督Step v3状态机", () => {
  it("同一Executor unknown只能由产品决定开启下一Step Revision", () => {
    const unknown = state({
      status: "outcome_unknown",
      attemptRef: { role: "executor" },
    });
    const retry = nextState(unknown, {
      status: "executor_ready",
      stepIdentity: { ...unknown.stepIdentity, stepRevision: 2 },
      executorRound: 2,
      lastDecisionRef: { decisionId: "sdc_retry1", revision: 1, sha256: SHA("4") },
    });
    expect(() => assertSupervisedStepStateTransitionV3(unknown, retry)).not.toThrow();

    const reviewerUnknown = state({
      status: "outcome_unknown",
      attemptRef: { role: "reviewer" },
      reviewerRound: 1,
    });
    const invalidReviewerRetry = nextState(reviewerUnknown, {
      status: "executor_ready",
      stepIdentity: { ...reviewerUnknown.stepIdentity, stepRevision: 2 },
      executorRound: 2,
      reviewerRound: 0,
      lastDecisionRef: { decisionId: "sdc_retry2", revision: 1, sha256: SHA("5") },
    });
    expect(() =>
      assertSupervisedStepStateTransitionV3(reviewerUnknown, invalidReviewerRetry),
    ).toThrow(/同一Agent角色/u);
  });

  it.each([
    [
      "Run",
      (identity: SupervisedStepStateV3Shape["stepIdentity"]) => ({
        ...identity,
        productRunId: "run_other",
      }),
    ],
    [
      "Epoch",
      (identity: SupervisedStepStateV3Shape["stepIdentity"]) => ({
        ...identity,
        planningEpochRef: {
          ...(identity.planningEpochRef as Record<string, unknown>),
          planningEpochId: "spe_other",
        },
      }),
    ],
    [
      "Contract",
      (identity: SupervisedStepStateV3Shape["stepIdentity"]) => ({
        ...identity,
        executionContractRef: {
          ...(identity.executionContractRef as Record<string, unknown>),
          executionContractId: "exc_other",
        },
      }),
    ],
    [
      "Step",
      (identity: SupervisedStepStateV3Shape["stepIdentity"]) => ({
        ...identity,
        stepId: "other-step",
      }),
    ],
  ] as const)("拒绝跨%s推进", (_label, mutateIdentity) => {
    const from = state({ status: "executor_running" });
    const toIdentity = mutateIdentity(from.stepIdentity);
    const to = nextState(from, {
      status: "outcome_unknown",
      stepIdentity: toIdentity,
      attemptRef: { role: "executor" },
    });
    expect(() => assertSupervisedStepStateTransitionV3(from, to)).toThrow(/冻结/u);
  });

  it("拒绝重算Hash后仍不匹配的状态", () => {
    const from = state({ status: "executor_running" });
    const to = {
      ...nextState(from, {
        status: "outcome_unknown",
        attemptRef: { role: "executor" },
      }),
      sha256: SHA("f"),
    };
    expect(() => assertSupervisedStepStateTransitionV3(from, to)).toThrow(/Hash/u);
  });
});
