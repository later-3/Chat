import type {
  ProductSnapshot,
  SupervisedAgentAttemptV3,
  SupervisedPlanningEpochV3,
  SupervisedStepIdentityV3,
} from "@chat/contracts";
import {
  computeSupervisedAgentAttemptSha256V3,
  computeSupervisedAgentOutcomeObservationSha256V3,
  computeSupervisedAssistantVisibleTextSha256V3,
  computeSupervisedCapabilityManifestSha256V3,
  computeSupervisedCarryForwardSha256V3,
  computeSupervisedExecutionResultSha256V3,
  computeSupervisedExecutionStepResultSha256V3,
  computeSupervisedPlannerVerdictSha256V3,
  computeSupervisedPlanningEpochSha256V3,
  computeSupervisedStepCandidateSha256V3,
  computeSupervisedStepCriterionSha256V3,
  computeSupervisedStepEvidenceSha256V3,
  computeSupervisedStepHumanDecisionSha256V3,
  computeSupervisedStepReviewRequestSha256V3,
  computeSupervisedStepStateSha256V3,
  assertSupervisedStepStateTransitionV3,
} from "@chat/domain";
import type { Fail } from "./shared.js";

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stepLineageKey(identity: SupervisedStepIdentityV3): string {
  return [
    identity.productRunId,
    identity.planningEpochRef.planningEpochId,
    identity.planningEpochRef.sha256,
    identity.executionContractRef.executionContractId,
    identity.executionContractRef.sha256,
    identity.stepId,
  ].join("\u0000");
}

function epochRef(epoch: SupervisedPlanningEpochV3) {
  return {
    planningEpochId: epoch.planningEpochId,
    epochNumber: epoch.epochNumber,
    revision: epoch.revision,
    sha256: epoch.sha256,
  };
}

function contractRef(contract: ProductSnapshot["entities"]["executionContracts"][string]) {
  return {
    executionContractId: contract.executionContractId,
    revision: contract.revision,
    sha256: contract.sha256,
  };
}

function attemptRef(attempt: SupervisedAgentAttemptV3) {
  return {
    attemptId: attempt.attemptId,
    role: attempt.role,
    agentRound: attempt.agentRound,
    revision: attempt.revision,
    inputManifestSha256: attempt.inputManifestSha256,
    sha256: attempt.sha256,
  };
}

function stateRef(state: ProductSnapshot["entities"]["supervisedStepStates"][string]) {
  return {
    supervisedStepStateId: state.supervisedStepStateId,
    revision: state.revision,
    stepRevision: state.stepIdentity.stepRevision,
    sha256: state.sha256,
  };
}

function candidateRef(candidate: ProductSnapshot["entities"]["supervisedStepCandidates"][string]) {
  return {
    candidateId: candidate.candidateId,
    revision: candidate.revision,
    sha256: candidate.sha256,
  };
}

function verdictRef(verdict: ProductSnapshot["entities"]["supervisedPlannerVerdicts"][string]) {
  return {
    verdictId: verdict.verdictId,
    revision: verdict.revision,
    sha256: verdict.sha256,
    kind: verdict.kind,
  };
}

function decisionRef(
  decision: ProductSnapshot["entities"]["supervisedStepHumanDecisions"][string],
) {
  return {
    decisionId: decision.decisionId,
    revision: decision.revision,
    sha256: decision.sha256,
  };
}

function evidenceRef(evidence: ProductSnapshot["entities"]["supervisedStepEvidence"][string]) {
  return {
    evidenceId: evidence.evidenceId,
    revision: evidence.revision,
    sha256: evidence.sha256,
  };
}

function reviewRef(review: ProductSnapshot["entities"]["supervisedStepReviewRequests"][string]) {
  return {
    reviewRequestId: review.reviewRequestId,
    reviewKind: review.reviewKind,
    revision: review.revision,
    sha256: review.sha256,
  };
}

function observationRef(
  observation: ProductSnapshot["entities"]["supervisedAgentOutcomeObservations"][string],
) {
  return {
    observationId: observation.observationId,
    revision: observation.revision,
    sha256: observation.sha256,
  };
}

function carryRef(carry: ProductSnapshot["entities"]["supervisedCarryForwards"][string]) {
  return {
    carryForwardId: carry.carryForwardId,
    stepId: carry.stepId,
    revision: carry.revision,
    sha256: carry.sha256,
  };
}

function assertEntityHash(
  label: string,
  id: string,
  actual: string,
  expected: string,
  fail: Fail,
): void {
  if (actual !== expected) fail(`${label} ${id} Hash不一致`);
}

function resolveStepIdentity(
  snapshot: ProductSnapshot,
  identity: SupervisedStepIdentityV3,
  label: string,
  fail: Fail,
) {
  const run = snapshot.entities.runs[identity.productRunId];
  const epoch =
    snapshot.entities.supervisedPlanningEpochs[identity.planningEpochRef.planningEpochId];
  const contract =
    snapshot.entities.executionContracts[identity.executionContractRef.executionContractId];
  const step = contract?.steps.find((candidate) => candidate.stepId === identity.stepId);
  if (
    run?.runKind !== "planning" ||
    epoch === undefined ||
    epoch.productRunId !== identity.productRunId ||
    !same(identity.planningEpochRef, epochRef(epoch)) ||
    contract === undefined ||
    contract.productRunId !== identity.productRunId ||
    !same(identity.executionContractRef, contractRef(contract)) ||
    !same(epoch.executionContractRef, contractRef(contract)) ||
    step === undefined ||
    identity.stepRevision > epoch.limits.maxExecutorRoundsPerStep
  ) {
    fail(`${label} 的Run/Epoch/Contract/Step身份不一致`);
  }
  return { run, epoch, contract, step: step! };
}

function resolveAttemptRef(
  snapshot: ProductSnapshot,
  ref: ReturnType<typeof attemptRef>,
  identity: SupervisedStepIdentityV3,
  label: string,
  fail: Fail,
): SupervisedAgentAttemptV3 {
  const attempt = snapshot.entities.supervisedAgentAttempts[ref.attemptId];
  if (
    attempt === undefined ||
    !same(ref, attemptRef(attempt)) ||
    !same(attempt.stepIdentity, identity)
  ) {
    fail(`${label} 的Agent Attempt引用悬空或身份漂移`);
  }
  return attempt!;
}

function assertEvidenceRefs(
  snapshot: ProductSnapshot,
  refs: readonly ReturnType<typeof evidenceRef>[],
  identity: SupervisedStepIdentityV3,
  label: string,
  fail: Fail,
): void {
  for (const ref of refs) {
    const evidence = snapshot.entities.supervisedStepEvidence[ref.evidenceId];
    if (
      evidence === undefined ||
      !same(ref, evidenceRef(evidence)) ||
      !same(evidence.stepIdentity, identity)
    ) {
      fail(`${label} 的Evidence引用悬空或跨Step`);
    }
  }
}

function assertEpochRoleBindings(
  snapshot: ProductSnapshot,
  epoch: SupervisedPlanningEpochV3,
  fail: Fail,
): void {
  const run = snapshot.entities.runs[epoch.productRunId];
  const session = run === undefined ? undefined : snapshot.entities.sessions[run.sessionId];
  for (const binding of epoch.roleBindings) {
    const version = snapshot.entities.agentVersions[binding.agentVersionRef.agentVersionId];
    const assembly =
      snapshot.entities.promptAssemblies[binding.promptAssemblyRoleRef.promptAssemblyId];
    const roleAssembly =
      assembly?.schemaVersion === "prompt-assembly.v5"
        ? assembly.roleAssemblies.find((candidate) => candidate.role === binding.role)
        : undefined;
    const expectedVersionRefs = roleAssembly?.tools.capabilities.map((capability) => ({
      localName: capability.localName,
      capabilityId: capability.ref.capabilityId,
      descriptorSha256: capability.ref.descriptorSha256,
    }));
    if (
      version?.schemaVersion !== "agent-version.v2" ||
      version.sha256 !== binding.agentVersionRef.sha256 ||
      version.ownerPrincipalId !== session?.ownerPrincipalId ||
      assembly?.schemaVersion !== "prompt-assembly.v5" ||
      assembly.productRunId !== epoch.productRunId ||
      assembly.sha256 !== binding.promptAssemblyRoleRef.promptAssemblySha256 ||
      roleAssembly === undefined ||
      roleAssembly.sha256 !== binding.promptAssemblyRoleRef.roleAssemblySha256 ||
      roleAssembly.agentVersionRef.agentVersionId !== version.agentVersionId ||
      roleAssembly.agentVersionRef.sha256 !== version.sha256 ||
      roleAssembly.tools.capabilityManifestSha256 !== binding.capabilityManifestSha256 ||
      !same(roleAssembly.tools.names, version.enabledToolNames) ||
      !same(expectedVersionRefs, version.enabledCapabilityRefs) ||
      !same(roleAssembly.tools.resources, version.resources) ||
      (version.scope.kind === "workspace" && version.scope.rootId !== assembly.workspaceRootId)
    ) {
      fail(`Planning Epoch ${epoch.planningEpochId} 的${binding.role}治理链绑定非法`);
    }
  }
}

/**
 * 监督执行事实在Product Store open与每次事务提交前共用同一关系门。这里不读取Pi
 * Journal；只验证Application已经采用的安全引用，完整Runtime证据仍由阶段2的窄Verifier证明。
 */
export function assertSupervisedPlanningV3(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const epochNumbers = new Set<string>();
  const statesByStep = new Map<
    string,
    ProductSnapshot["entities"]["supervisedStepStates"][string][]
  >();
  const stateChildCounts = new Map<string, number>();
  const referencedStateIds = new Set(
    Object.values(entities.supervisedStepStates).flatMap((state) =>
      state.previousStateRef === undefined ? [] : [state.previousStateRef.supervisedStepStateId],
    ),
  );
  const leafStateIds = new Set(
    Object.values(entities.supervisedStepStates)
      .filter((state) => !referencedStateIds.has(state.supervisedStepStateId))
      .map((state) => state.supervisedStepStateId),
  );
  const attemptRounds = new Set<string>();
  const candidateAttemptIds = new Set<string>();
  const verdictAttemptIds = new Set<string>();
  const evidenceToolResults = new Set<string>();
  const resultRuns = new Set<string>();

  for (const epoch of Object.values(entities.supervisedPlanningEpochs)) {
    assertEntityHash(
      "Planning Epoch",
      epoch.planningEpochId,
      epoch.sha256,
      computeSupervisedPlanningEpochSha256V3(epoch),
      fail,
    );
    const run = entities.runs[epoch.productRunId];
    const plan = Object.values(entities.plans).find(
      (candidate) =>
        candidate.productRunId === epoch.productRunId &&
        candidate.planId === epoch.approvedPlanRef.planId &&
        candidate.planRevision === epoch.approvedPlanRef.planRevision &&
        candidate.sha256 === epoch.approvedPlanRef.sha256,
    );
    const contract = entities.executionContracts[epoch.executionContractRef.executionContractId];
    const epochNumberKey = `${epoch.productRunId}:${String(epoch.epochNumber)}`;
    if (epochNumbers.has(epochNumberKey)) {
      fail(`Planning Run ${epoch.productRunId} 的Epoch Number ${String(epoch.epochNumber)}重复`);
    }
    epochNumbers.add(epochNumberKey);
    if (
      run?.runKind !== "planning" ||
      run.revision < epoch.productRunRevisionBaseline ||
      plan?.status !== "approved" ||
      contract === undefined ||
      contract.productRunId !== epoch.productRunId ||
      contract.approvedPlanId !== epoch.approvedPlanRef.planId ||
      contract.approvedPlanRevision !== epoch.approvedPlanRef.planRevision ||
      contract.approvedPlanSha256 !== epoch.approvedPlanRef.sha256 ||
      !same(epoch.executionContractRef, contractRef(contract))
    ) {
      fail(`Planning Epoch ${epoch.planningEpochId} 的Run/Plan/Contract绑定非法`);
    }
    assertEpochRoleBindings(snapshot, epoch, fail);
    if (epoch.lineage !== undefined) {
      const previous =
        entities.supervisedPlanningEpochs[epoch.lineage.supersedesEpochRef.planningEpochId];
      const triggerState =
        entities.supervisedStepStates[epoch.lineage.triggerStateRef.supervisedStepStateId];
      const triggerVerdict =
        entities.supervisedPlannerVerdicts[epoch.lineage.triggerVerdictRef.verdictId];
      const triggerDecision =
        entities.supervisedStepHumanDecisions[epoch.lineage.triggerDecisionRef.decisionId];
      if (
        previous === undefined ||
        previous.productRunId !== epoch.productRunId ||
        previous.epochNumber + 1 !== epoch.epochNumber ||
        !same(epoch.lineage.supersedesEpochRef, epochRef(previous)) ||
        triggerState?.status !== "replan_required" ||
        triggerState.stepIdentity.productRunId !== epoch.productRunId ||
        triggerState.stepIdentity.planningEpochRef.planningEpochId !== previous.planningEpochId ||
        !same(epoch.lineage.triggerStateRef, stateRef(triggerState)) ||
        triggerVerdict?.kind !== "replan_remaining" ||
        !same(triggerVerdict.stepIdentity, triggerState.stepIdentity) ||
        !same(epoch.lineage.triggerVerdictRef, verdictRef(triggerVerdict)) ||
        triggerDecision?.reviewKind !== "reviewer_verdict" ||
        triggerDecision.action.kind !== "accept_verdict" ||
        !same(triggerDecision.stepIdentity, triggerState.stepIdentity) ||
        !same(epoch.lineage.triggerDecisionRef, decisionRef(triggerDecision))
      ) {
        fail(`Planning Epoch ${epoch.planningEpochId} 的重规划血缘非法`);
      }
    }
    for (const ref of epoch.carryForwardRefs) {
      const carry = entities.supervisedCarryForwards[ref.carryForwardId];
      if (
        carry === undefined ||
        !same(ref, carryRef(carry)) ||
        carry.productRunId !== epoch.productRunId ||
        carry.targetPlanningEpochId !== epoch.planningEpochId ||
        carry.targetEpochNumber !== epoch.epochNumber
      ) {
        fail(`Planning Epoch ${epoch.planningEpochId} 的Carry Forward引用非法`);
      }
    }
  }

  for (const state of Object.values(entities.supervisedStepStates)) {
    assertEntityHash(
      "Supervised Step State",
      state.supervisedStepStateId,
      state.sha256,
      computeSupervisedStepStateSha256V3(state),
      fail,
    );
    const { run, epoch, contract, step } = resolveStepIdentity(
      snapshot,
      state.stepIdentity,
      `Step State ${state.supervisedStepStateId}`,
      fail,
    );
    const key = stepLineageKey(state.stepIdentity);
    const states = statesByStep.get(key) ?? [];
    states.push(state);
    statesByStep.set(key, states);
    if (state.previousStateRef !== undefined) {
      const previous = entities.supervisedStepStates[state.previousStateRef.supervisedStepStateId];
      const childCount =
        (stateChildCounts.get(state.previousStateRef.supervisedStepStateId) ?? 0) + 1;
      stateChildCounts.set(state.previousStateRef.supervisedStepStateId, childCount);
      if (
        previous === undefined ||
        !same(state.previousStateRef, stateRef(previous)) ||
        childCount > 1
      ) {
        fail(`Step State ${state.supervisedStepStateId} 前态悬空或产生分叉`);
      }
      try {
        assertSupervisedStepStateTransitionV3(previous!, state);
      } catch (error) {
        fail(
          `Step State ${state.supervisedStepStateId} 非法转换：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (
      run.revision < state.productRunRevisionBaseline ||
      !same(state.limits, epoch.limits) ||
      state.successCriteriaRefs.length !== step.successCriteria.length ||
      state.successCriteriaRefs.some(
        (ref, index) =>
          ref.criterionIndex !== index ||
          ref.sha256 !==
            computeSupervisedStepCriterionSha256V3({
              stepIdentity: state.stepIdentity,
              criterionIndex: index,
              text: step.successCriteria[index]!,
            }),
      ) ||
      !same(state.dependencyStepIds, step.dependsOn)
    ) {
      fail(`Step State ${state.supervisedStepStateId} 的冻结输入或成功标准非法`);
    }
    if (state.status === "executor_running" || state.status === "reviewer_running") {
      const attempt = resolveAttemptRef(
        snapshot,
        state.attemptRef,
        state.stepIdentity,
        `Step State ${state.supervisedStepStateId}`,
        fail,
      );
      if (
        attempt.outcome !== "running" ||
        state.previousStateRef === undefined ||
        attempt.supervisedStepStateId !== state.previousStateRef.supervisedStepStateId
      ) {
        fail(`运行中Step未绑定从精确前态启动的running Agent Attempt`);
      }
    }
    if (
      state.status === "waiting_candidate_review" ||
      state.status === "reviewer_ready" ||
      state.status === "reviewer_running" ||
      state.status === "waiting_verdict_review" ||
      state.status === "step_passed"
    ) {
      const candidate = entities.supervisedStepCandidates[state.candidateRef.candidateId];
      if (
        candidate === undefined ||
        !same(state.candidateRef, candidateRef(candidate)) ||
        !same(candidate.stepIdentity, state.stepIdentity)
      ) {
        fail(`Step State ${state.supervisedStepStateId} Candidate悬空`);
      }
      assertEvidenceRefs(
        snapshot,
        state.evidenceRefs,
        state.stepIdentity,
        `Step State ${state.supervisedStepStateId}`,
        fail,
      );
    }
    if (state.status === "waiting_verdict_review" || state.status === "step_passed") {
      const verdict = entities.supervisedPlannerVerdicts[state.verdictRef.verdictId];
      if (
        verdict === undefined ||
        !same(state.verdictRef, verdictRef(verdict)) ||
        !same(verdict.stepIdentity, state.stepIdentity)
      ) {
        fail(`Step State ${state.supervisedStepStateId} Verdict悬空`);
      }
    }
    if (
      state.status === "waiting_candidate_review" ||
      state.status === "waiting_verdict_review" ||
      state.status === "outcome_unknown"
    ) {
      const review = entities.supervisedStepReviewRequests[state.reviewRequestRef.reviewRequestId];
      const isLeaf = leafStateIds.has(state.supervisedStepStateId);
      const expectedReviewRef =
        review === undefined
          ? undefined
          : isLeaf || review.decisionState.status === "open"
            ? reviewRef(review)
            : reviewRef({ ...review, revision: review.revision - 1 });
      if (
        review === undefined ||
        (isLeaf
          ? review.decisionState.status !== "open"
          : review.decisionState.status === "open") ||
        !same(state.reviewRequestRef, expectedReviewRef) ||
        !same(review.stepIdentity, state.stepIdentity)
      ) {
        fail(`Step State ${state.supervisedStepStateId} 当前Product Review悬空或已关闭`);
      }
    }
    if (state.status === "outcome_unknown") {
      const attempt = resolveAttemptRef(
        snapshot,
        state.attemptRef,
        state.stepIdentity,
        `Step State ${state.supervisedStepStateId}`,
        fail,
      );
      const observation =
        entities.supervisedAgentOutcomeObservations[state.outcomeObservationRef.observationId];
      if (
        attempt.outcome !== "outcome_unknown" ||
        observation === undefined ||
        !same(state.outcomeObservationRef, observationRef(observation)) ||
        !same(observation.stepIdentity, state.stepIdentity)
      ) {
        fail(`Step State ${state.supervisedStepStateId} unknown事实不完整`);
      }
    }
  }

  for (const epoch of Object.values(entities.supervisedPlanningEpochs)) {
    const contract = entities.executionContracts[epoch.executionContractRef.executionContractId];
    if (contract === undefined) continue;
    const carriedStepIds = new Set(epoch.carryForwardRefs.map((ref) => ref.stepId));
    for (const step of contract.steps) {
      const key = stepLineageKey({
        productRunId: epoch.productRunId,
        planningEpochRef: epochRef(epoch),
        executionContractRef: contractRef(contract),
        stepId: step.stepId,
        stepRevision: 1,
      });
      const states = statesByStep.get(key) ?? [];
      if (carriedStepIds.has(step.stepId)) {
        if (states.length !== 0) {
          fail(
            `Planning Epoch ${epoch.planningEpochId} 的Carry Step ${step.stepId} 不能重复创建State`,
          );
        }
        continue;
      }
      const roots = states.filter((state) => state.previousStateRef === undefined);
      const leaves = states.filter((state) => leafStateIds.has(state.supervisedStepStateId));
      if (roots.length !== 1 || leaves.length !== 1) {
        fail(`Planning Epoch ${epoch.planningEpochId} 的Step ${step.stepId} 状态链不完整`);
      }
    }
  }

  for (const attempt of Object.values(entities.supervisedAgentAttempts)) {
    assertEntityHash(
      "Supervised Agent Attempt",
      attempt.attemptId,
      attempt.sha256,
      computeSupervisedAgentAttemptSha256V3(attempt),
      fail,
    );
    const { run, epoch } = resolveStepIdentity(
      snapshot,
      attempt.stepIdentity,
      `Agent Attempt ${attempt.attemptId}`,
      fail,
    );
    const state = entities.supervisedStepStates[attempt.supervisedStepStateId];
    const binding = epoch.roleBindings.find((candidate) => candidate.role === attempt.role);
    const version = entities.agentVersions[attempt.agentVersionRef.agentVersionId];
    const assembly = entities.promptAssemblies[attempt.promptAssemblyRoleRef.promptAssemblyId];
    const roleAssembly =
      assembly?.schemaVersion === "prompt-assembly.v5"
        ? assembly.roleAssemblies.find((candidate) => candidate.role === attempt.role)
        : undefined;
    const roundKey = `${stepLineageKey(attempt.stepIdentity)}:${attempt.role}:${String(attempt.agentRound)}`;
    if (attemptRounds.has(roundKey)) {
      fail(`Agent Attempt ${attempt.attemptId} 重复占用同一Step角色轮次`);
    }
    attemptRounds.add(roundKey);
    const expectedSourceStatus = attempt.role === "executor" ? "executor_ready" : "reviewer_ready";
    if (
      entities.attempts[attempt.attemptId] !== undefined ||
      state === undefined ||
      !same(state.stepIdentity, attempt.stepIdentity) ||
      state.status !== expectedSourceStatus ||
      state.revision !== attempt.inputStateRevision ||
      !same(state.lastDecisionRef, attempt.triggerDecisionRef) ||
      run.revision < attempt.inputProductRunRevision ||
      binding === undefined ||
      !same(binding.agentVersionRef, attempt.agentVersionRef) ||
      !same(binding.promptAssemblyRoleRef, attempt.promptAssemblyRoleRef) ||
      binding.capabilityManifestSha256 !== attempt.capabilityManifest.sha256 ||
      version?.sha256 !== attempt.agentVersionRef.sha256 ||
      assembly?.schemaVersion !== "prompt-assembly.v5" ||
      roleAssembly === undefined ||
      assembly.sha256 !== attempt.promptAssemblyRoleRef.promptAssemblySha256 ||
      roleAssembly.sha256 !== attempt.promptAssemblyRoleRef.roleAssemblySha256 ||
      roleAssembly.tools.capabilityManifestSha256 !== attempt.capabilityManifest.sha256 ||
      !same(roleAssembly.tools.capabilities, attempt.capabilityManifest.capabilities) ||
      computeSupervisedCapabilityManifestSha256V3(attempt.capabilityManifest) !==
        attempt.capabilityManifest.sha256 ||
      (attempt.role === "executor" && attempt.agentRound !== attempt.stepIdentity.stepRevision) ||
      (attempt.role === "executor" && attempt.agentRound > epoch.limits.maxExecutorRoundsPerStep) ||
      (attempt.role === "reviewer" && attempt.agentRound > epoch.limits.maxReviewerRoundsPerStep)
    ) {
      fail(`Agent Attempt ${attempt.attemptId} 的State/Version/Assembly/Capability绑定非法`);
    }
  }

  for (const evidence of Object.values(entities.supervisedStepEvidence)) {
    assertEntityHash(
      "Supervised Evidence",
      evidence.evidenceId,
      evidence.sha256,
      computeSupervisedStepEvidenceSha256V3(evidence),
      fail,
    );
    const { step } = resolveStepIdentity(
      snapshot,
      evidence.stepIdentity,
      `Evidence ${evidence.evidenceId}`,
      fail,
    );
    const attempt = resolveAttemptRef(
      snapshot,
      evidence.attemptRef,
      evidence.stepIdentity,
      `Evidence ${evidence.evidenceId}`,
      fail,
    );
    const capability = attempt.capabilityManifest.capabilities.find(
      (candidate) =>
        candidate.localName === evidence.source.localName &&
        same(candidate.ref, evidence.source.capabilityRef),
    );
    const evidenceToolKey = `${attempt.attemptId}:${evidence.source.toolCallId}`;
    if (evidenceToolResults.has(evidenceToolKey)) {
      fail(`Evidence ${evidence.evidenceId} 重复提升同一Tool Result`);
    }
    evidenceToolResults.add(evidenceToolKey);
    if (
      attempt.outcome !== "success" ||
      capability === undefined ||
      evidence.criterionRefs.some(
        (ref) =>
          step.successCriteria[ref.criterionIndex] === undefined ||
          ref.sha256 !==
            computeSupervisedStepCriterionSha256V3({
              stepIdentity: evidence.stepIdentity,
              criterionIndex: ref.criterionIndex,
              text: step.successCriteria[ref.criterionIndex]!,
            }),
      )
    ) {
      fail(`Evidence ${evidence.evidenceId} 不是该Attempt/Capability/成功标准的派生事实`);
    }
    if (evidence.source.productToolResultRef !== undefined) {
      fail(`Evidence ${evidence.evidenceId} 不能在ToolExecution v2落地前引用Product Result`);
    }
    if (capability.effect !== "read") {
      fail(`高影响Evidence ${evidence.evidenceId} 必须等待ToolExecution v2产品闭环`);
    }
  }

  for (const candidate of Object.values(entities.supervisedStepCandidates)) {
    assertEntityHash(
      "Supervised Candidate",
      candidate.candidateId,
      candidate.sha256,
      computeSupervisedStepCandidateSha256V3(candidate),
      fail,
    );
    resolveStepIdentity(
      snapshot,
      candidate.stepIdentity,
      `Candidate ${candidate.candidateId}`,
      fail,
    );
    const attempt = resolveAttemptRef(
      snapshot,
      candidate.executorAttemptRef,
      candidate.stepIdentity,
      `Candidate ${candidate.candidateId}`,
      fail,
    );
    assertEvidenceRefs(
      snapshot,
      candidate.evidenceRefs,
      candidate.stepIdentity,
      `Candidate ${candidate.candidateId}`,
      fail,
    );
    if (candidateAttemptIds.has(candidate.executorAttemptRef.attemptId)) {
      fail(`Executor Attempt ${candidate.executorAttemptRef.attemptId} 产生多个Candidate`);
    }
    candidateAttemptIds.add(candidate.executorAttemptRef.attemptId);
    if (
      attempt.role !== "executor" ||
      attempt.outcome !== "success" ||
      attempt.assistantVisibleTextSha256 !== candidate.assistantVisibleTextSha256 ||
      candidate.assistantVisibleTextSha256 !==
        computeSupervisedAssistantVisibleTextSha256V3(candidate.output.text)
    ) {
      fail(`Candidate ${candidate.candidateId} 未绑定成功Executor可见输出`);
    }
  }

  for (const verdict of Object.values(entities.supervisedPlannerVerdicts)) {
    assertEntityHash(
      "Supervised Reviewer Verdict",
      verdict.verdictId,
      verdict.sha256,
      computeSupervisedPlannerVerdictSha256V3(verdict),
      fail,
    );
    const { step } = resolveStepIdentity(
      snapshot,
      verdict.stepIdentity,
      `Verdict ${verdict.verdictId}`,
      fail,
    );
    const candidate = entities.supervisedStepCandidates[verdict.candidateRef.candidateId];
    const attempt = resolveAttemptRef(
      snapshot,
      verdict.reviewerAttemptRef,
      verdict.stepIdentity,
      `Verdict ${verdict.verdictId}`,
      fail,
    );
    assertEvidenceRefs(
      snapshot,
      verdict.reviewedEvidenceRefs,
      verdict.stepIdentity,
      `Verdict ${verdict.verdictId}`,
      fail,
    );
    if (verdictAttemptIds.has(verdict.reviewerAttemptRef.attemptId)) {
      fail(`Reviewer Attempt ${verdict.reviewerAttemptRef.attemptId} 产生多个Verdict`);
    }
    verdictAttemptIds.add(verdict.reviewerAttemptRef.attemptId);
    if (
      candidate === undefined ||
      !same(verdict.candidateRef, candidateRef(candidate)) ||
      !same(candidate.stepIdentity, verdict.stepIdentity) ||
      !same(verdict.reviewedEvidenceRefs, candidate.evidenceRefs) ||
      attempt.role !== "reviewer" ||
      attempt.outcome !== "success" ||
      attempt.assistantVisibleTextSha256 !== verdict.assistantVisibleTextSha256 ||
      verdict.assistantVisibleTextSha256 !==
        computeSupervisedAssistantVisibleTextSha256V3(verdict.assistantVisibleText) ||
      (verdict.kind === "pass" &&
        (verdict.verifiedCriteria.length !== step.successCriteria.length ||
          verdict.verifiedCriteria.some(
            (ref, index) =>
              ref.criterionIndex !== index ||
              ref.sha256 !==
                computeSupervisedStepCriterionSha256V3({
                  stepIdentity: verdict.stepIdentity,
                  criterionIndex: index,
                  text: step.successCriteria[index]!,
                }),
          )))
    ) {
      fail(`Verdict ${verdict.verdictId} 的Candidate/Reviewer/Evidence绑定非法`);
    }
  }

  for (const review of Object.values(entities.supervisedStepReviewRequests)) {
    assertEntityHash(
      "Supervised Product Review",
      review.reviewRequestId,
      review.sha256,
      computeSupervisedStepReviewRequestSha256V3(review),
      fail,
    );
    resolveStepIdentity(snapshot, review.stepIdentity, `Review ${review.reviewRequestId}`, fail);
    if (review.reviewKind === "executor_candidate" || review.reviewKind === "reviewer_verdict") {
      const candidate = entities.supervisedStepCandidates[review.candidateRef.candidateId];
      if (
        candidate === undefined ||
        !same(review.candidateRef, candidateRef(candidate)) ||
        !same(candidate.stepIdentity, review.stepIdentity)
      ) {
        fail(`Review ${review.reviewRequestId} Candidate悬空`);
      }
      if (review.reviewKind === "reviewer_verdict") {
        const verdict = entities.supervisedPlannerVerdicts[review.verdictRef.verdictId];
        if (
          verdict === undefined ||
          !same(review.verdictRef, verdictRef(verdict)) ||
          !same(verdict.stepIdentity, review.stepIdentity) ||
          !same(verdict.candidateRef, review.candidateRef)
        ) {
          fail(`Review ${review.reviewRequestId} Verdict悬空`);
        }
      }
    } else {
      const state = entities.supervisedStepStates[review.stateRef.supervisedStepStateId];
      const attempt = resolveAttemptRef(
        snapshot,
        review.attemptRef,
        review.stepIdentity,
        `Review ${review.reviewRequestId}`,
        fail,
      );
      const observation =
        entities.supervisedAgentOutcomeObservations[review.outcomeObservationRef.observationId];
      if (
        review.agentRole !== attempt.role ||
        state?.status !== "outcome_unknown" ||
        !same(review.stateRef, stateRef(state)) ||
        observation === undefined ||
        !same(review.outcomeObservationRef, observationRef(observation)) ||
        !same(observation.stepIdentity, review.stepIdentity) ||
        !same(observation.attemptRef, review.attemptRef)
      ) {
        fail(`Review ${review.reviewRequestId} outcome_unknown绑定非法`);
      }
    }
    if (review.decisionState.status === "decided") {
      const decision = entities.supervisedStepHumanDecisions[review.decisionState.decisionId];
      if (
        decision === undefined ||
        decision.reviewKind !== review.reviewKind ||
        decision.reviewRequestRef.reviewRequestId !== review.reviewRequestId
      ) {
        fail(`Review ${review.reviewRequestId} 的Product Decision悬空`);
      }
    }
  }

  for (const decision of Object.values(entities.supervisedStepHumanDecisions)) {
    assertEntityHash(
      "Supervised Product Decision",
      decision.decisionId,
      decision.sha256,
      computeSupervisedStepHumanDecisionSha256V3(decision),
      fail,
    );
    const { run } = resolveStepIdentity(
      snapshot,
      decision.stepIdentity,
      `Decision ${decision.decisionId}`,
      fail,
    );
    const session = entities.sessions[run.sessionId];
    const review = entities.supervisedStepReviewRequests[decision.reviewRequestRef.reviewRequestId];
    const subjectMatches =
      review !== undefined &&
      (decision.reviewKind === "executor_candidate"
        ? review.reviewKind === "executor_candidate" &&
          same(decision.candidateRef, review.candidateRef)
        : decision.reviewKind === "reviewer_verdict"
          ? review.reviewKind === "reviewer_verdict" &&
            same(decision.candidateRef, review.candidateRef) &&
            same(decision.verdictRef, review.verdictRef)
          : review.reviewKind === "outcome_unknown" &&
            decision.agentRole === review.agentRole &&
            same(decision.stateRef, review.stateRef) &&
            same(decision.attemptRef, review.attemptRef) &&
            same(decision.outcomeObservationRef, review.outcomeObservationRef));
    if (
      decision.decisionBoundary !== "product_review" ||
      decision.principalId !== session?.ownerPrincipalId ||
      review === undefined ||
      review.decisionBoundary !== "product_review" ||
      review.decisionState.status !== "decided" ||
      review.decisionState.decisionId !== decision.decisionId ||
      !same(decision.reviewRequestRef, reviewRef({ ...review, revision: review.revision - 1 })) ||
      !same(decision.stepIdentity, review.stepIdentity) ||
      !subjectMatches
    ) {
      fail(`Decision ${decision.decisionId} 的Review/Principal/CAS绑定非法`);
    }
  }

  for (const observation of Object.values(entities.supervisedAgentOutcomeObservations)) {
    assertEntityHash(
      "Supervised Outcome Observation",
      observation.observationId,
      observation.sha256,
      computeSupervisedAgentOutcomeObservationSha256V3(observation),
      fail,
    );
    resolveStepIdentity(
      snapshot,
      observation.stepIdentity,
      `Observation ${observation.observationId}`,
      fail,
    );
    const attempt = resolveAttemptRef(
      snapshot,
      observation.attemptRef,
      observation.stepIdentity,
      `Observation ${observation.observationId}`,
      fail,
    );
    if (attempt.outcome !== "outcome_unknown" || attempt.errorCode !== observation.errorCode) {
      fail(`Observation ${observation.observationId} 未绑定unknown Attempt`);
    }
  }

  for (const carry of Object.values(entities.supervisedCarryForwards)) {
    assertEntityHash(
      "Supervised Carry Forward",
      carry.carryForwardId,
      carry.sha256,
      computeSupervisedCarryForwardSha256V3(carry),
      fail,
    );
    const sourceEpoch =
      entities.supervisedPlanningEpochs[carry.sourcePlanningEpochRef.planningEpochId];
    const targetEpoch = entities.supervisedPlanningEpochs[carry.targetPlanningEpochId];
    const sourceState = entities.supervisedStepStates[carry.sourceStateRef.supervisedStepStateId];
    const candidate = entities.supervisedStepCandidates[carry.candidateRef.candidateId];
    const verdict = entities.supervisedPlannerVerdicts[carry.passVerdictRef.verdictId];
    const decision = entities.supervisedStepHumanDecisions[carry.acceptanceDecisionRef.decisionId];
    const prior =
      carry.priorCarryForwardRef === undefined
        ? undefined
        : entities.supervisedCarryForwards[carry.priorCarryForwardRef.carryForwardId];
    if (
      sourceEpoch === undefined ||
      sourceEpoch.productRunId !== carry.productRunId ||
      !same(carry.sourcePlanningEpochRef, epochRef(sourceEpoch)) ||
      targetEpoch?.productRunId !== carry.productRunId ||
      targetEpoch.epochNumber !== carry.targetEpochNumber ||
      sourceState?.status !== "step_passed" ||
      sourceState.stepIdentity.productRunId !== carry.productRunId ||
      sourceState.stepIdentity.planningEpochRef.planningEpochId !== sourceEpoch.planningEpochId ||
      sourceState.stepIdentity.stepId !== carry.stepId ||
      !same(carry.sourceStateRef, stateRef(sourceState)) ||
      candidate === undefined ||
      !same(carry.candidateRef, candidateRef(candidate)) ||
      verdict?.kind !== "pass" ||
      !same(carry.passVerdictRef, verdictRef(verdict)) ||
      decision?.reviewKind !== "reviewer_verdict" ||
      decision.action.kind !== "accept_verdict" ||
      !same(candidate?.stepIdentity, sourceState.stepIdentity) ||
      !same(verdict?.stepIdentity, sourceState.stepIdentity) ||
      !same(decision?.stepIdentity, sourceState.stepIdentity) ||
      !same(carry.acceptanceDecisionRef, decisionRef(decision)) ||
      (carry.priorCarryForwardRef !== undefined &&
        (prior === undefined || !same(carry.priorCarryForwardRef, carryRef(prior))))
    ) {
      fail(`Carry Forward ${carry.carryForwardId} 的跨纪元通过链非法`);
    }
  }

  for (const result of Object.values(entities.supervisedExecutionResults)) {
    assertEntityHash(
      "Supervised Execution Result",
      result.supervisedExecutionResultId,
      result.sha256,
      computeSupervisedExecutionResultSha256V3(result),
      fail,
    );
    const run = entities.runs[result.productRunId];
    const terminalEpoch =
      entities.supervisedPlanningEpochs[result.terminalPlanningEpochRef.planningEpochId];
    if (resultRuns.has(result.productRunId)) {
      fail(`Planning Run ${result.productRunId} 存在多个监督Execution Result`);
    }
    resultRuns.add(result.productRunId);
    if (
      run?.runKind !== "planning" ||
      run.status !== "succeeded" ||
      run.phase !== "completed" ||
      terminalEpoch === undefined ||
      terminalEpoch.productRunId !== result.productRunId ||
      !same(result.terminalPlanningEpochRef, epochRef(terminalEpoch)) ||
      !same(result.terminalPlanningEpochRef, result.planningEpochRefs.at(-1))
    ) {
      fail(`Execution Result ${result.supervisedExecutionResultId} Run/Epoch非法`);
    }
    for (const ref of result.planningEpochRefs) {
      const epoch = entities.supervisedPlanningEpochs[ref.planningEpochId];
      if (epoch?.productRunId !== result.productRunId || !same(ref, epochRef(epoch))) {
        fail(`Execution Result ${result.supervisedExecutionResultId} Epoch链悬空`);
      }
    }
    for (const stepResult of result.orderedStepResults) {
      resolveStepIdentity(
        snapshot,
        stepResult.stepIdentity,
        `Execution Result ${result.supervisedExecutionResultId}`,
        fail,
      );
      const state = entities.supervisedStepStates[stepResult.stateRef.supervisedStepStateId];
      const candidate = entities.supervisedStepCandidates[stepResult.candidateRef.candidateId];
      const verdict = entities.supervisedPlannerVerdicts[stepResult.passVerdictRef.verdictId];
      const decision =
        entities.supervisedStepHumanDecisions[stepResult.acceptanceDecisionRef.decisionId];
      if (
        stepResult.sha256 !== computeSupervisedExecutionStepResultSha256V3(stepResult) ||
        stepResult.stepIdentity.productRunId !== result.productRunId ||
        state?.status !== "step_passed" ||
        !same(stepResult.stateRef, stateRef(state)) ||
        candidate === undefined ||
        !same(stepResult.candidateRef, candidateRef(candidate)) ||
        verdict?.kind !== "pass" ||
        !same(stepResult.passVerdictRef, verdictRef(verdict)) ||
        decision?.reviewKind !== "reviewer_verdict" ||
        decision.action.kind !== "accept_verdict" ||
        !same(candidate?.stepIdentity, stepResult.stepIdentity) ||
        !same(verdict?.stepIdentity, stepResult.stepIdentity) ||
        !same(decision?.stepIdentity, stepResult.stepIdentity) ||
        !same(stepResult.acceptanceDecisionRef, decisionRef(decision))
      ) {
        fail(`Execution Result ${result.supervisedExecutionResultId} Step通过链非法`);
      }
      assertEvidenceRefs(
        snapshot,
        stepResult.evidenceRefs,
        stepResult.stepIdentity,
        `Execution Result ${result.supervisedExecutionResultId}`,
        fail,
      );
      if (stepResult.carryForwardRef !== undefined) {
        const carry = entities.supervisedCarryForwards[stepResult.carryForwardRef.carryForwardId];
        if (
          carry === undefined ||
          !same(stepResult.carryForwardRef, carryRef(carry)) ||
          carry.productRunId !== result.productRunId ||
          carry.stepId !== stepResult.stepIdentity.stepId
        ) {
          fail(`Execution Result ${result.supervisedExecutionResultId} Carry引用悬空`);
        }
      }
    }
  }
}
