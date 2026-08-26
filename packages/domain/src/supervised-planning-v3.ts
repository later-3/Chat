import { canonicalJsonStringify, hashCanonical, sha256Hex } from "./canonical-hash.js";

type WithSha256 = object & { readonly sha256?: string | undefined };

export type SupervisedStepStatusV3 =
  | "executor_ready"
  | "executor_running"
  | "waiting_candidate_review"
  | "reviewer_ready"
  | "reviewer_running"
  | "waiting_verdict_review"
  | "step_passed"
  | "replan_required"
  | "blocked"
  | "failed"
  | "outcome_unknown";

export interface SupervisedStepStateV3Shape extends WithSha256 {
  readonly supervisedStepStateId: string;
  readonly previousStateRef?:
    | {
        readonly supervisedStepStateId: string;
        readonly revision: number;
        readonly stepRevision: number;
        readonly sha256: string;
      }
    | undefined;
  readonly status: SupervisedStepStatusV3;
  readonly stepIdentity: {
    readonly productRunId: string;
    readonly planningEpochRef: unknown;
    readonly executionContractRef: unknown;
    readonly stepId: string;
    readonly stepRevision: number;
  };
  readonly productRunRevisionBaseline: number;
  readonly limits: unknown;
  readonly successCriteriaRefs: unknown;
  readonly dependencyStepIds: unknown;
  readonly remainingStepIds: unknown;
  readonly executorRound: number;
  readonly reviewerRound: number;
  readonly lastDecisionRef?: unknown;
  readonly attemptRef?: { readonly role: "executor" | "reviewer" } | undefined;
  readonly failure?: { readonly role: "executor" | "reviewer" } | undefined;
  readonly verdictRef?: unknown;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface SupervisedAgentAttemptV3Shape extends WithSha256 {
  readonly attemptId: string;
  readonly outcome: "running" | "success" | "failure" | "outcome_unknown";
  readonly assistantVisibleTextSha256?: string | undefined;
  readonly errorCode?: string | undefined;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SupervisedStepReviewRequestV3Shape extends WithSha256 {
  readonly reviewRequestId: string;
  readonly decisionState:
    | { readonly status: "open" }
    | { readonly status: "decided"; readonly decisionId: string }
    | { readonly status: "expired"; readonly reasonCode: string; readonly expiredAt: string };
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function hashWithoutSha256(domain: string, input: WithSha256): string {
  const { sha256: _sha256, ...value } = input;
  void _sha256;
  return hashCanonical(domain, value);
}

export function computeSupervisedCapabilityManifestSha256V3(
  input: WithSha256 & { readonly capabilities: readonly unknown[] },
): string {
  return hashCanonical("supervised-capability-manifest.v3", {
    capabilities: input.capabilities,
  });
}

export function computeSupervisedPlanningEpochSha256V3(input: WithSha256): string {
  return hashWithoutSha256("supervised-planning-epoch.v3", input);
}

export function computeSupervisedCarryForwardSha256V3(input: WithSha256): string {
  return hashWithoutSha256("supervised-carry-forward.v3", input);
}

export function computeSupervisedAgentAttemptSha256V3(input: WithSha256): string {
  return hashWithoutSha256("supervised-agent-attempt.v3", input);
}

export function computeSupervisedStepEvidenceSha256V3(input: WithSha256): string {
  return hashWithoutSha256("supervised-step-evidence.v3", input);
}

export function computeSupervisedStepCriterionSha256V3(input: {
  readonly stepIdentity: unknown;
  readonly criterionIndex: number;
  readonly text: string;
}): string {
  return hashCanonical("supervised-step-criterion.v3", input);
}

export function computeSupervisedStepCandidateSha256V3(input: WithSha256): string {
  return hashWithoutSha256("supervised-step-candidate.v3", input);
}

/** 与Pi `full-operation.v3`的visibleTextSha256算法逐字一致。 */
export function computeSupervisedAssistantVisibleTextSha256V3(text: string): string {
  return sha256Hex(canonicalJsonStringify(text));
}

export function computeSupervisedPlannerVerdictSha256V3(input: WithSha256): string {
  return hashWithoutSha256("supervised-reviewer-verdict.v3", input);
}

export function computeSupervisedStepReviewRequestSha256V3(
  input: WithSha256 & {
    readonly decisionState: unknown;
    readonly revision: number;
    readonly updatedAt: string;
  },
): string {
  const {
    sha256: _sha256,
    decisionState: _decisionState,
    revision: _revision,
    updatedAt: _updatedAt,
    ...immutableRequest
  } = input;
  void _sha256;
  void _decisionState;
  void _revision;
  void _updatedAt;
  return hashCanonical("supervised-step-review-request.v3", immutableRequest);
}

export function computeSupervisedStepHumanDecisionSha256V3(input: WithSha256): string {
  return hashWithoutSha256("supervised-step-human-decision.v3", input);
}

export function computeSupervisedStepStateSha256V3(input: WithSha256): string {
  return hashWithoutSha256("supervised-step-state.v3", input);
}

export function computeSupervisedAgentOutcomeObservationSha256V3(input: WithSha256): string {
  return hashWithoutSha256("supervised-agent-outcome-observation.v3", input);
}

export function computeSupervisedExecutionResultSha256V3(input: WithSha256): string {
  return hashWithoutSha256("supervised-execution-result.v3", input);
}

export function computeSupervisedExecutionStepResultSha256V3(input: WithSha256): string {
  return hashWithoutSha256("supervised-execution-step-result.v3", input);
}

function same(value: unknown, expected: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(expected);
}

const allowedStepTransitions = new Map<SupervisedStepStatusV3, ReadonlySet<string>>([
  ["executor_ready", new Set(["executor_running"])],
  ["executor_running", new Set(["waiting_candidate_review", "failed", "outcome_unknown"])],
  ["waiting_candidate_review", new Set(["reviewer_ready", "executor_ready", "blocked"])],
  ["reviewer_ready", new Set(["reviewer_running"])],
  ["reviewer_running", new Set(["waiting_verdict_review", "failed", "outcome_unknown"])],
  [
    "waiting_verdict_review",
    new Set(["step_passed", "executor_ready", "reviewer_ready", "replan_required", "blocked"]),
  ],
  ["outcome_unknown", new Set(["executor_ready", "reviewer_ready", "blocked"])],
  ["step_passed", new Set()],
  ["replan_required", new Set()],
  ["blocked", new Set()],
  ["failed", new Set()],
]);

/**
 * Application后续只能通过这张状态机推进Step。这里不决定Workflow Hook，也不授权Tool；
 * Product Review决定只解释Candidate/Verdict/unknown，Tool Review仍由ToolExecution状态机拥有。
 */
export function assertSupervisedStepStateTransitionV3(
  from: SupervisedStepStateV3Shape,
  to: SupervisedStepStateV3Shape,
): void {
  if (!allowedStepTransitions.get(from.status)?.has(to.status)) {
    throw new Error(`非法监督Step状态转换:${from.status}->${to.status}`);
  }
  if (
    from.supervisedStepStateId === to.supervisedStepStateId ||
    !same(to.previousStateRef, {
      supervisedStepStateId: from.supervisedStepStateId,
      revision: from.revision,
      stepRevision: from.stepIdentity.stepRevision,
      sha256: from.sha256,
    }) ||
    !same(from.stepIdentity.productRunId, to.stepIdentity.productRunId) ||
    !same(from.stepIdentity.planningEpochRef, to.stepIdentity.planningEpochRef) ||
    !same(from.stepIdentity.executionContractRef, to.stepIdentity.executionContractRef) ||
    from.stepIdentity.stepId !== to.stepIdentity.stepId ||
    from.productRunRevisionBaseline !== to.productRunRevisionBaseline ||
    !same(from.limits, to.limits) ||
    !same(from.successCriteriaRefs, to.successCriteriaRefs) ||
    !same(from.dependencyStepIds, to.dependencyStepIds) ||
    !same(from.remainingStepIds, to.remainingStepIds)
  ) {
    throw new Error("监督Step状态转换改变了冻结Run/Epoch/Contract/Step输入");
  }
  if (to.revision !== from.revision + 1 || to.updatedAt < from.updatedAt) {
    throw new Error("监督Step状态转换revision或时间不单调");
  }
  if (
    from.status === "outcome_unknown" &&
    ((from.attemptRef?.role === "executor" &&
      to.status !== "executor_ready" &&
      to.status !== "blocked") ||
      (from.attemptRef?.role === "reviewer" &&
        to.status !== "reviewer_ready" &&
        to.status !== "blocked"))
  ) {
    throw new Error("outcome_unknown只能重试发生未知结果的同一Agent角色");
  }
  if (to.status === "executor_ready") {
    const retry = from.status !== "outcome_unknown" || from.attemptRef?.role === "executor";
    if (
      !retry ||
      to.executorRound !== from.executorRound + 1 ||
      to.stepIdentity.stepRevision !== from.stepIdentity.stepRevision + 1 ||
      to.reviewerRound !== 0 ||
      to.lastDecisionRef === undefined
    ) {
      throw new Error("Executor重试必须由产品决定开启下一Step Revision");
    }
  } else if (
    to.stepIdentity.stepRevision !== from.stepIdentity.stepRevision ||
    to.executorRound !== from.executorRound
  ) {
    throw new Error("非Executor重试不能改变Step Revision");
  }
  if (to.status === "reviewer_ready" && to.lastDecisionRef === undefined) {
    throw new Error("Reviewer启动前必须已有Candidate产品审核决定");
  }
  if (
    (to.status === "step_passed" || to.status === "replan_required" || to.status === "blocked") &&
    to.lastDecisionRef === undefined
  ) {
    throw new Error("监督Step产品终态必须绑定最后人工决定");
  }
  if (computeSupervisedStepStateSha256V3(to) !== to.sha256) {
    throw new Error("监督Step状态Hash不一致");
  }
}

function immutableAttemptProjection(input: SupervisedAgentAttemptV3Shape): object {
  const {
    outcome: _outcome,
    assistantVisibleTextSha256: _visibleText,
    errorCode: _errorCode,
    sha256: _sha256,
    revision: _revision,
    updatedAt: _updatedAt,
    ...immutable
  } = input;
  void _outcome;
  void _visibleText;
  void _errorCode;
  void _sha256;
  void _revision;
  void _updatedAt;
  return immutable;
}

/** Agent Attempt只允许从running单调收敛到一个终态，身份与输入不可改写。 */
export function assertSupervisedAgentAttemptTransitionV3(
  from: SupervisedAgentAttemptV3Shape,
  to: SupervisedAgentAttemptV3Shape,
): void {
  if (from.outcome !== "running" || to.outcome === "running") {
    throw new Error("监督Agent Attempt终态不可逆或重复覆盖");
  }
  if (
    !same(immutableAttemptProjection(from), immutableAttemptProjection(to)) ||
    to.revision !== from.revision + 1 ||
    to.updatedAt < from.updatedAt ||
    computeSupervisedAgentAttemptSha256V3(to) !== to.sha256
  ) {
    throw new Error("监督Agent Attempt收敛改变了冻结身份、输入或Hash");
  }
}

function immutableReviewProjection(input: SupervisedStepReviewRequestV3Shape): object {
  const {
    decisionState: _decisionState,
    sha256: _sha256,
    revision: _revision,
    updatedAt: _updatedAt,
    ...immutable
  } = input;
  void _decisionState;
  void _sha256;
  void _revision;
  void _updatedAt;
  return immutable;
}

/** Product Review只允许open一次性收敛；它与Tool Review状态机没有共享身份或动作。 */
export function assertSupervisedStepReviewRequestTransitionV3(
  from: SupervisedStepReviewRequestV3Shape,
  to: SupervisedStepReviewRequestV3Shape,
): void {
  if (from.decisionState.status !== "open" || to.decisionState.status === "open") {
    throw new Error("监督Product Review终态不可逆或重复覆盖");
  }
  if (
    !same(immutableReviewProjection(from), immutableReviewProjection(to)) ||
    to.revision !== from.revision + 1 ||
    to.updatedAt < from.updatedAt ||
    computeSupervisedStepReviewRequestSha256V3(to) !== to.sha256
  ) {
    throw new Error("监督Product Review收敛改变了冻结Subject、身份或Hash");
  }
}
