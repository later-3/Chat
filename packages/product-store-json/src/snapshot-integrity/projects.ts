import { type ProductSnapshot } from "@chat/contracts";
import { validateWorkflowRunSpecIntegrity } from "@chat/application/workflow-run-spec-compiler";
import {
  assertProjectWorkGraph,
  computeProjectCandidateSha256,
  computeProjectAdvancementCandidateSha256,
  computeProjectManagementCandidateSha256,
  computeProjectMethodSnapshotSha256,
  computeProjectObservationSha256,
  assertPlanningProjectContextIntegrity,
  assertPlanningMemorySelectionIntegrity,
  computePlanningProjectSourceRefSha256,
  computeWorkflowProjectResourceSha256,
  assertProjectBootstrapDecisionBinding,
  computeProjectBootstrapCandidateSha256,
} from "@chat/domain";
import type { Fail } from "./shared.js";

export function assertProjects(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  for (const project of Object.values(entities.projects)) {
    const method = entities.projectMethodSnapshots[project.methodSnapshotId];
    const stage = entities.projectStages[project.currentStageId];
    if (method?.projectId !== project.projectId || stage?.projectId !== project.projectId) {
      fail(`project ${project.projectId} Method/Stage绑定不一致`);
    }
  }
  for (const method of Object.values(entities.projectMethodSnapshots)) {
    if (entities.projects[method.projectId] === undefined)
      fail(`projectMethod ${method.projectMethodSnapshotId} 悬空Project`);
    if (
      computeProjectMethodSnapshotSha256({
        profileId: method.profileId,
        rationale: method.rationale,
        policies: method.policies,
        source: method.source,
      }) !== method.sha256
    ) {
      fail(`projectMethod ${method.projectMethodSnapshotId} Hash不一致`);
    }
  }
  for (const stage of Object.values(entities.projectStages)) {
    if (
      entities.projects[stage.projectId] === undefined ||
      entities.projectMethodSnapshots[stage.methodSnapshotId]?.projectId !== stage.projectId
    )
      fail(`projectStage ${stage.projectStageId} 悬空Project`);
    const terminal = stage.status === "completed" || stage.status === "skipped";
    const migratedLegacyStage =
      entities.projectMethodSnapshots[stage.methodSnapshotId]?.source === "migrated_v1";
    if (
      terminal !== (stage.completedAt !== undefined) ||
      (!migratedLegacyStage && terminal !== (stage.completionDecisionId !== undefined))
    ) {
      fail(`projectStage ${stage.projectStageId} 终态证据字段不一致`);
    }
    if (
      stage.completionDecisionId !== undefined &&
      entities.projectDecisions[stage.completionDecisionId]?.projectId !== stage.projectId
    ) {
      fail(`projectStage ${stage.projectStageId} Completion Decision绑定不一致`);
    }
    if (
      stage.completionEvidenceIds.some(
        (id) => entities.projectEvidence[id]?.projectId !== stage.projectId,
      )
    ) {
      fail(`projectStage ${stage.projectStageId} Completion Evidence绑定不一致`);
    }
  }
  const activeStageCounts = new Map<string, number>();
  for (const stage of Object.values(entities.projectStages)) {
    if (stage.status === "active") {
      activeStageCounts.set(stage.projectId, (activeStageCounts.get(stage.projectId) ?? 0) + 1);
    }
  }
  for (const [projectId, count] of activeStageCounts) {
    if (count > 1) fail(`project ${projectId} 存在多个active Stage`);
  }
  for (const milestone of Object.values(entities.projectMilestones)) {
    if (entities.projects[milestone.projectId] === undefined) {
      fail(`projectMilestone ${milestone.projectMilestoneId} 悬空Project`);
    }
    if (
      milestone.stageId !== undefined &&
      entities.projectStages[milestone.stageId]?.projectId !== milestone.projectId
    ) {
      fail(`projectMilestone ${milestone.projectMilestoneId} Stage绑定不一致`);
    }
    if (
      milestone.evidenceIds.some(
        (id) => entities.projectEvidence[id]?.projectId !== milestone.projectId,
      )
    ) {
      fail(`projectMilestone ${milestone.projectMilestoneId} Evidence绑定不一致`);
    }
    if (
      (milestone.status === "achieved") !== (milestone.achievedDecisionId !== undefined) ||
      (milestone.status === "achieved" && milestone.evidenceIds.length === 0) ||
      (milestone.achievedDecisionId !== undefined &&
        entities.projectDecisions[milestone.achievedDecisionId]?.projectId !== milestone.projectId)
    ) {
      fail(`projectMilestone ${milestone.projectMilestoneId} Achieved Decision不一致`);
    }
  }
  for (const update of Object.values(entities.projectUpdates)) {
    const project = entities.projects[update.projectId];
    const participant = entities.projectParticipants[update.authorParticipantId];
    const stage = entities.projectStages[update.stageId];
    const superseded =
      update.supersedesUpdateId === undefined
        ? undefined
        : entities.projectUpdates[update.supersedesUpdateId];
    if (
      project === undefined ||
      participant?.projectId !== update.projectId ||
      participant.principalId !== update.confirmedByPrincipalId ||
      participant.kind !== "human" ||
      participant.status !== "active" ||
      stage?.projectId !== update.projectId ||
      update.boundProjectRevision > project.revision ||
      update.boundStageRevision > stage.revision ||
      (update.supersedesUpdateId !== undefined && superseded === undefined) ||
      (superseded !== undefined &&
        (superseded.projectId !== update.projectId || superseded.publishedAt >= update.publishedAt))
    ) {
      fail(`projectUpdate ${update.projectUpdateId} 作者或Project绑定不一致`);
    }
    if (
      update.evidenceIds.some((id) => entities.projectEvidence[id]?.projectId !== update.projectId)
    ) {
      fail(`projectUpdate ${update.projectUpdateId} Evidence绑定不一致`);
    }
  }
  const transitionsByObject = new Map<
    string,
    (typeof entities.projectStateTransitions)[string][]
  >();
  for (const transition of Object.values(entities.projectStateTransitions)) {
    const object =
      transition.objectType === "stage"
        ? entities.projectStages[transition.objectId]
        : transition.objectType === "milestone"
          ? entities.projectMilestones[transition.objectId]
          : entities.projects[transition.objectId];
    if (
      entities.projects[transition.projectId] === undefined ||
      entities.projectParticipants[transition.actorParticipantId]?.projectId !==
        transition.projectId ||
      entities.projectDecisions[transition.decisionId]?.projectId !== transition.projectId ||
      object?.projectId !== transition.projectId ||
      object.revision < transition.afterRevision ||
      transition.afterRevision !== transition.beforeRevision + 1 ||
      transition.from === transition.to ||
      transition.evidenceIds.some(
        (id) => entities.projectEvidence[id]?.projectId !== transition.projectId,
      )
    ) {
      fail(`projectStateTransition ${transition.projectStateTransitionId} 绑定或revision无效`);
    }
    const key = `${transition.objectType}:${transition.objectId}`;
    const sequence = transitionsByObject.get(key) ?? [];
    sequence.push(transition);
    transitionsByObject.set(key, sequence);
  }
  for (const [key, transitions] of transitionsByObject) {
    transitions.sort((left, right) => left.beforeRevision - right.beforeRevision);
    for (let index = 1; index < transitions.length; index += 1) {
      const previous = transitions[index - 1];
      const current = transitions[index];
      if (
        previous === undefined ||
        current === undefined ||
        current.beforeRevision < previous.afterRevision ||
        current.from !== previous.to
      ) {
        fail(`projectStateTransition ${key} 历史链不连续`);
      }
    }
    const latest = transitions.at(-1);
    const currentObject =
      latest?.objectType === "stage"
        ? entities.projectStages[latest.objectId]
        : latest?.objectType === "milestone"
          ? entities.projectMilestones[latest.objectId]
          : latest === undefined
            ? undefined
            : entities.projects[latest.objectId];
    if (latest === undefined || currentObject?.status !== latest.to) {
      fail(`projectStateTransition ${key} 最新状态与对象不一致`);
    }
  }
  for (const resource of Object.values(entities.projectResources)) {
    if (entities.projects[resource.projectId] === undefined)
      fail(`projectResource ${resource.projectResourceId} 悬空Project`);
  }
  for (const participant of Object.values(entities.projectParticipants)) {
    const project = entities.projects[participant.projectId];
    if (project === undefined)
      fail(`projectParticipant ${participant.projectParticipantId} 悬空Project`);
    if (participant.principalId !== undefined && participant.kind !== "human") {
      fail(`projectParticipant ${participant.projectParticipantId} 非human不允许principalId`);
    }
  }
  try {
    const worksByProject = new Map<string, (typeof entities.projectWorks)[string][]>();
    for (const work of Object.values(entities.projectWorks)) {
      const group = worksByProject.get(work.projectId) ?? [];
      group.push(work);
      worksByProject.set(work.projectId, group);
    }
    for (const works of worksByProject.values()) assertProjectWorkGraph(works);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  for (const work of Object.values(entities.projectWorks)) {
    const stage = entities.projectStages[work.stageId];
    const owner = entities.projectParticipants[work.ownerParticipantId];
    if (stage?.projectId !== work.projectId || owner?.projectId !== work.projectId) {
      fail(`projectWork ${work.projectWorkId} Stage/Owner绑定不一致`);
    }
  }
  for (const action of Object.values(entities.projectActions)) {
    const work = entities.projectWorks[action.workId];
    const owner = entities.projectParticipants[action.ownerParticipantId];
    if (work?.projectId !== action.projectId || owner?.projectId !== action.projectId) {
      fail(`projectAction ${action.projectActionId} Work/Owner绑定不一致`);
    }
    if ((action.status === "blocked") !== (action.blockedReason !== undefined)) {
      fail(`projectAction ${action.projectActionId} blockedReason不一致`);
    }
    for (const evidenceId of action.completedEvidenceIds) {
      if (entities.projectEvidence[evidenceId]?.projectId !== action.projectId) {
        fail(`projectAction ${action.projectActionId} Evidence绑定不一致`);
      }
    }
  }
  for (const evidence of Object.values(entities.projectEvidence)) {
    if (entities.projects[evidence.projectId] === undefined)
      fail(`projectEvidence ${evidence.projectEvidenceId} 悬空Project`);
    if (
      evidence.resourceId !== undefined &&
      entities.projectResources[evidence.resourceId]?.projectId !== evidence.projectId
    ) {
      fail(`projectEvidence ${evidence.projectEvidenceId} Resource绑定不一致`);
    }
  }
  for (const observation of Object.values(entities.projectObservations)) {
    if (entities.projectResources[observation.resourceId]?.projectId !== observation.projectId) {
      fail(`projectObservation ${observation.projectObservationId} Resource绑定不一致`);
    }
    if (computeProjectObservationSha256(observation.data) !== observation.sha256) {
      fail(`projectObservation ${observation.projectObservationId} Hash不一致`);
    }
    if (observation.previousObservationId !== undefined) {
      const previous = entities.projectObservations[observation.previousObservationId];
      if (
        previous?.resourceId !== observation.resourceId ||
        previous.observedAt >= observation.observedAt
      ) {
        fail(`projectObservation ${observation.projectObservationId} 前序Observation无效`);
      }
    }
  }
  for (const contribution of Object.values(entities.projectContributions)) {
    if (
      entities.projectParticipants[contribution.participantId]?.projectId !== contribution.projectId
    ) {
      fail(`projectContribution ${contribution.projectContributionId} Participant绑定不一致`);
    }
    if (contribution.evidenceStatus === "verified" && contribution.evidenceIds.length === 0) {
      fail(`projectContribution ${contribution.projectContributionId} verified缺少Evidence`);
    }
    if (
      contribution.evidenceIds.some(
        (id) => entities.projectEvidence[id]?.projectId !== contribution.projectId,
      )
    ) {
      fail(`projectContribution ${contribution.projectContributionId} Evidence绑定不一致`);
    }
  }
  for (const decision of Object.values(entities.projectDecisions)) {
    const project = entities.projects[decision.projectId];
    if (
      project === undefined ||
      entities.projectParticipants[decision.decidedByParticipantId]?.projectId !==
        decision.projectId
    ) {
      fail(`projectDecision ${decision.projectDecisionId} Project/Participant绑定不一致`);
    }
    if (decision.boundProjectRevision > project.revision)
      fail(`projectDecision ${decision.projectDecisionId} 绑定未来revision`);
  }
  for (const candidate of Object.values(entities.projectCandidates)) {
    const session = entities.sessions[candidate.sessionId];
    const message = entities.messages[candidate.sourceMessageId];
    if (
      session?.ownerPrincipalId !== candidate.requestedByPrincipalId ||
      message?.sessionId !== candidate.sessionId ||
      message.role !== "user"
    ) {
      fail(`projectCandidate ${candidate.projectCandidateId} Session/Message绑定不一致`);
    }
    if (
      candidate.candidateKind === "intake" &&
      (candidate.status === "under_review" || candidate.status === "confirmed")
    ) {
      if (
        computeProjectObservationSha256(candidate.observationData) !== candidate.observationSha256
      ) {
        fail(`projectCandidate ${candidate.projectCandidateId} Observation Hash不一致`);
      }
      if (
        computeProjectCandidateSha256({
          proposal: candidate.proposal,
          observationSha256: candidate.observationSha256,
          sourceMessageId: candidate.sourceMessageId,
          rootId: candidate.rootId,
          enabledAdapters: candidate.enabledAdapters,
        }) !== candidate.candidateSha256
      ) {
        fail(`projectCandidate ${candidate.projectCandidateId} Candidate Hash不一致`);
      }
    }
    if (
      candidate.candidateKind === "intake" &&
      candidate.status === "confirmed" &&
      entities.projects[candidate.confirmedProjectId] === undefined
    ) {
      fail(`projectCandidate ${candidate.projectCandidateId} 悬空confirmedProjectId`);
    }
    if (candidate.candidateKind === "management") {
      const project = entities.projects[candidate.projectId];
      if (
        project?.ownerPrincipalId !== candidate.requestedByPrincipalId ||
        candidate.boundProjectRevision > project.revision ||
        computeProjectManagementCandidateSha256({
          projectId: candidate.projectId,
          boundProjectRevision: candidate.boundProjectRevision,
          sourceMessageId: candidate.sourceMessageId,
          proposal: candidate.proposal,
        }) !== candidate.candidateSha256
      ) {
        fail(`projectCandidate ${candidate.projectCandidateId} 管理Candidate绑定或Hash不一致`);
      }
      if (candidate.proposal.kind === "action") {
        if (
          entities.projectWorks[candidate.proposal.workId]?.projectId !== candidate.projectId ||
          entities.projectParticipants[candidate.proposal.ownerParticipantId]?.projectId !==
            candidate.projectId
        ) {
          fail(`projectCandidate ${candidate.projectCandidateId} Action引用不一致`);
        }
        if (
          candidate.status === "confirmed" &&
          entities.projectActions[candidate.committedObjectId]?.projectId !== candidate.projectId
        ) {
          fail(`projectCandidate ${candidate.projectCandidateId} committed Action缺失`);
        }
      } else if (candidate.proposal.kind === "decision") {
        if (
          entities.projectParticipants[candidate.proposal.decidedByParticipantId]?.projectId !==
          candidate.projectId
        ) {
          fail(`projectCandidate ${candidate.projectCandidateId} Decision参与者不一致`);
        }
        if (
          candidate.status === "confirmed" &&
          entities.projectDecisions[candidate.committedObjectId]?.projectId !== candidate.projectId
        ) {
          fail(`projectCandidate ${candidate.projectCandidateId} committed Decision缺失`);
        }
      } else {
        if (
          entities.projectParticipants[candidate.proposal.participantId]?.projectId !==
            candidate.projectId ||
          (candidate.proposal.workId !== undefined &&
            entities.projectWorks[candidate.proposal.workId]?.projectId !== candidate.projectId) ||
          (candidate.proposal.actionId !== undefined &&
            entities.projectActions[candidate.proposal.actionId]?.projectId !==
              candidate.projectId) ||
          candidate.proposal.evidenceIds.some(
            (id) => entities.projectEvidence[id]?.projectId !== candidate.projectId,
          )
        ) {
          fail(`projectCandidate ${candidate.projectCandidateId} Contribution引用不一致`);
        }
        if (
          candidate.status === "confirmed" &&
          entities.projectContributions[candidate.committedObjectId]?.projectId !==
            candidate.projectId
        ) {
          fail(`projectCandidate ${candidate.projectCandidateId} committed Contribution缺失`);
        }
      }
    }
    if (candidate.candidateKind === "advancement") {
      const project = entities.projects[candidate.projectId];
      const stage = entities.projectStages[candidate.boundStageId];
      const method = entities.projectMethodSnapshots[candidate.boundMethodSnapshotId];
      if (
        project?.ownerPrincipalId !== candidate.requestedByPrincipalId ||
        stage?.projectId !== candidate.projectId ||
        method?.projectId !== candidate.projectId ||
        candidate.boundProjectRevision > project.revision ||
        candidate.boundStageRevision > stage.revision ||
        candidate.boundMethodSha256 !== method.sha256
      ) {
        fail(`projectCandidate ${candidate.projectCandidateId} Advancement绑定不一致`);
      }
      if (
        candidate.status === "under_review" ||
        candidate.status === "confirmed" ||
        candidate.status === "rejected"
      ) {
        if (
          computeProjectAdvancementCandidateSha256({
            projectId: candidate.projectId,
            boundProjectRevision: candidate.boundProjectRevision,
            boundStageId: candidate.boundStageId,
            boundStageRevision: candidate.boundStageRevision,
            boundMethodSnapshotId: candidate.boundMethodSnapshotId,
            boundMethodSha256: candidate.boundMethodSha256,
            sourceMessageId: candidate.sourceMessageId,
            proposal: candidate.proposal,
          }) !== candidate.candidateSha256
        ) {
          fail(`projectCandidate ${candidate.projectCandidateId} Advancement Hash不一致`);
        }
      }
      if (candidate.status === "confirmed") {
        if (
          entities.projectStages[candidate.committedStageId]?.projectId !== candidate.projectId ||
          entities.projectUpdates[candidate.committedUpdateId]?.projectId !== candidate.projectId ||
          candidate.committedMilestoneIds.some(
            (id) => entities.projectMilestones[id]?.projectId !== candidate.projectId,
          )
        ) {
          fail(`projectCandidate ${candidate.projectCandidateId} committed Advancement缺失`);
        }
      }
    }
  }
}

export function assertProjectBootstraps(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const operationCountByCandidate = new Map<string, number>();
  const decisionCountByCandidate = new Map<string, number>();
  const bindingCountByOperation = new Map<string, number>();
  const activeBindingCountBySession = new Map<string, number>();
  const activeCandidateCountBySession = new Map<string, number>();

  for (const candidate of Object.values(entities.projectBootstrapCandidates)) {
    const session = entities.sessions[candidate.sourceProductSessionId];
    const run = entities.runs[candidate.sourceProductRunId];
    if (
      session === undefined ||
      run?.runKind !== "direct_agent" ||
      run.sessionId !== session.sessionId ||
      session.ownerPrincipalId !== candidate.ownerPrincipalId
    ) {
      fail(`projectBootstrapCandidate ${candidate.projectBootstrapCandidateId} 来源会话无效`);
    }
    if (
      computeProjectBootstrapCandidateSha256(candidate) !== candidate.sha256 ||
      new Set(candidate.proposal.initialModules).size !== candidate.proposal.initialModules.length
    ) {
      fail(`projectBootstrapCandidate ${candidate.projectBootstrapCandidateId} Hash或Module无效`);
    }
    if (candidate.status !== "rejected") {
      activeCandidateCountBySession.set(
        candidate.sourceProductSessionId,
        (activeCandidateCountBySession.get(candidate.sourceProductSessionId) ?? 0) + 1,
      );
    }
  }

  for (const decision of Object.values(entities.projectBootstrapDecisions)) {
    const candidate = entities.projectBootstrapCandidates[decision.projectBootstrapCandidateId];
    if (candidate === undefined) {
      fail(`projectBootstrapDecision ${decision.projectBootstrapDecisionId} 悬空Candidate`);
    }
    try {
      assertProjectBootstrapDecisionBinding({
        candidate: {
          ...candidate,
          status: "prepared",
          revision: decision.candidateRevision,
        },
        decision,
      });
    } catch (error) {
      fail(
        `projectBootstrapDecision ${decision.projectBootstrapDecisionId} ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    decisionCountByCandidate.set(
      decision.projectBootstrapCandidateId,
      (decisionCountByCandidate.get(decision.projectBootstrapCandidateId) ?? 0) + 1,
    );
  }

  for (const operation of Object.values(entities.projectBootstrapOperations)) {
    const candidate = entities.projectBootstrapCandidates[operation.projectBootstrapCandidateId];
    const decision = entities.projectBootstrapDecisions[operation.projectBootstrapDecisionId];
    if (
      candidate === undefined ||
      decision === undefined ||
      decision.kind !== "confirm" ||
      decision.projectBootstrapCandidateId !== candidate.projectBootstrapCandidateId ||
      operation.ownerPrincipalId !== candidate.ownerPrincipalId ||
      operation.candidateSha256 !== candidate.sha256
    ) {
      fail(`projectBootstrapOperation ${operation.projectBootstrapOperationId} 绑定无效`);
    }
    const expectedCandidateStatus =
      operation.status === "queued"
        ? "confirmed"
        : operation.status === "dispatching"
          ? "executing"
          : operation.status === "ready"
            ? "ready"
            : operation.status === "outcome_unknown"
              ? "outcome_unknown"
              : "needs_attention";
    if (candidate.status !== expectedCandidateStatus) {
      fail(
        `projectBootstrapOperation ${operation.projectBootstrapOperationId} 状态与Candidate不一致`,
      );
    }
    if (
      operation.status === "ready" &&
      (operation.workspaceStep !== "completed" ||
        operation.planeStep !== "completed" ||
        operation.bindingStep !== "completed" ||
        operation.planeProjectId === undefined)
    ) {
      fail(`projectBootstrapOperation ${operation.projectBootstrapOperationId} ready证据不完整`);
    }
    operationCountByCandidate.set(
      operation.projectBootstrapCandidateId,
      (operationCountByCandidate.get(operation.projectBootstrapCandidateId) ?? 0) + 1,
    );
  }

  for (const binding of Object.values(entities.projectWorkspaceBindings)) {
    const operation = entities.projectBootstrapOperations[binding.projectBootstrapOperationId];
    const candidate =
      operation === undefined
        ? undefined
        : entities.projectBootstrapCandidates[operation.projectBootstrapCandidateId];
    if (
      operation?.status !== "ready" ||
      candidate === undefined ||
      operation.ownerPrincipalId !== binding.ownerPrincipalId ||
      operation.planeProjectId !== binding.planeProjectId ||
      candidate.sourceProductSessionId !== binding.productSessionId ||
      candidate.proposal.planeWorkspaceSlug !== binding.planeWorkspaceSlug ||
      candidate.proposal.planeProjectIdentifier !== binding.planeProjectIdentifier ||
      candidate.proposal.workspaceRootId !== binding.workspaceRootId ||
      candidate.proposal.directoryName !== binding.directoryName
    ) {
      fail(`projectWorkspaceBinding ${binding.projectWorkspaceBindingId} 绑定无效`);
    }
    bindingCountByOperation.set(
      binding.projectBootstrapOperationId,
      (bindingCountByOperation.get(binding.projectBootstrapOperationId) ?? 0) + 1,
    );
    if (binding.status === "active") {
      activeBindingCountBySession.set(
        binding.productSessionId,
        (activeBindingCountBySession.get(binding.productSessionId) ?? 0) + 1,
      );
    }
  }

  for (const candidate of Object.values(entities.projectBootstrapCandidates)) {
    const decisionCount = decisionCountByCandidate.get(candidate.projectBootstrapCandidateId) ?? 0;
    const operationCount =
      operationCountByCandidate.get(candidate.projectBootstrapCandidateId) ?? 0;
    if (candidate.status === "prepared" && (decisionCount !== 0 || operationCount !== 0)) {
      fail(
        `projectBootstrapCandidate ${candidate.projectBootstrapCandidateId} prepared却已有下游事实`,
      );
    }
    if (candidate.status === "rejected" && (decisionCount !== 1 || operationCount !== 0)) {
      fail(`projectBootstrapCandidate ${candidate.projectBootstrapCandidateId} reject事实不完整`);
    }
    if (
      !["prepared", "rejected"].includes(candidate.status) &&
      (decisionCount !== 1 || operationCount !== 1)
    ) {
      fail(`projectBootstrapCandidate ${candidate.projectBootstrapCandidateId} 确认事实不完整`);
    }
  }
  for (const operation of Object.values(entities.projectBootstrapOperations)) {
    const count = bindingCountByOperation.get(operation.projectBootstrapOperationId) ?? 0;
    if (
      (operation.status === "ready" && count !== 1) ||
      (operation.status !== "ready" && count !== 0)
    ) {
      fail(`projectBootstrapOperation ${operation.projectBootstrapOperationId} Binding数量无效`);
    }
  }
  for (const [sessionId, count] of activeBindingCountBySession) {
    if (count !== 1) fail(`Product Session ${sessionId} 存在多个活动Project Workspace Binding`);
  }
  for (const [sessionId, count] of activeCandidateCountBySession) {
    if (count !== 1) fail(`Product Session ${sessionId} 存在多个当前Project Bootstrap Candidate`);
  }
}

export function assertPlanningProjectContexts(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const runIds = new Set<string>();
  for (const context of Object.values(entities.planningProjectContexts)) {
    try {
      assertPlanningProjectContextIntegrity(context);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    if (runIds.has(context.productRunId)) {
      fail(`planningProjectContext ${context.planningProjectContextId} Run重复`);
    }
    runIds.add(context.productRunId);
    const run = entities.runs[context.productRunId];
    const runSession = run === undefined ? undefined : entities.sessions[run.sessionId];
    const project = entities.projects[context.projectId];
    const method = entities.projectMethodSnapshots[context.methodRef.projectMethodSnapshotId];
    const stage = entities.projectStages[context.stageRef.projectStageId];
    if (
      run?.runKind !== "planning" ||
      runSession === undefined ||
      project === undefined ||
      project.ownerPrincipalId !== runSession.ownerPrincipalId ||
      method?.projectId !== project.projectId ||
      stage?.projectId !== project.projectId ||
      stage.methodSnapshotId !== method.projectMethodSnapshotId
    ) {
      fail(`planningProjectContext ${context.planningProjectContextId} Run/Project绑定不一致`);
    }
    if (
      context.methodRef.revision !== method.revision ||
      context.methodRef.sha256 !== method.sha256
    ) {
      fail(`planningProjectContext ${context.planningProjectContextId} Method证据不一致`);
    }
    const projectSource = context.sourceRefs.find(
      (ref) => ref.kind === "project" && ref.objectId === context.projectId,
    );
    if (
      projectSource?.revision !== context.projectRevision ||
      projectSource.sha256 !== context.projectSha256
    ) {
      fail(`planningProjectContext ${context.planningProjectContextId} Project证据不一致`);
    }
    for (const ref of context.sourceRefs) {
      const entity = getPlanningProjectSourceEntity(snapshot, ref.kind, ref.objectId);
      if (entity === undefined || entity.projectId !== context.projectId) {
        fail(`planningProjectContext ${context.planningProjectContextId} 来源悬空或跨Project`);
      }
      // Project聚合与Stage等对象当前没有历史表；只有仍处于同一revision时才能反查正文。
      // 后续revision不得让旧运行Context损坏，旧Context由自身snapshot+Hash继续自证。
      if (entity.revision === ref.revision) {
        const expectedSha =
          ref.kind === "method" && "sha256" in entity
            ? String(entity.sha256)
            : ref.kind === "project"
              ? computeWorkflowProjectResourceSha256(entity)
              : computePlanningProjectSourceRefSha256({ kind: ref.kind, entity });
        if (expectedSha !== ref.sha256) {
          fail(`planningProjectContext ${context.planningProjectContextId} 来源Hash不一致`);
        }
      }
    }
  }
}

function getPlanningProjectSourceEntity(
  snapshot: ProductSnapshot,
  kind: ProductSnapshot["entities"]["planningProjectContexts"][string]["sourceRefs"][number]["kind"],
  objectId: string,
):
  | ({ readonly projectId: string; readonly revision: number; readonly updatedAt: string } & object)
  | undefined {
  const entities = snapshot.entities;
  if (kind === "project") return entities.projects[objectId];
  if (kind === "method") return entities.projectMethodSnapshots[objectId];
  if (kind === "stage") return entities.projectStages[objectId];
  if (kind === "milestone") return entities.projectMilestones[objectId];
  if (kind === "update") return entities.projectUpdates[objectId];
  if (kind === "work") return entities.projectWorks[objectId];
  return entities.projectActions[objectId];
}

export function assertPlanningMemorySelections(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const identityKeys = new Set<string>();
  for (const selection of Object.values(entities.planningMemorySelections)) {
    try {
      assertPlanningMemorySelectionIntegrity(selection);
    } catch (error) {
      fail(
        `planningMemorySelection ${selection.planningMemorySelectionId} ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const identityKey = `${selection.productRunId}\0${selection.definitionNodeId}`;
    if (identityKeys.has(identityKey)) {
      fail(`planningMemorySelection ${selection.planningMemorySelectionId} Run/Node重复`);
    }
    identityKeys.add(identityKey);
    const run = entities.runs[selection.productRunId];
    const session = run === undefined ? undefined : entities.sessions[run.sessionId];
    const runSpec = entities.workflowRunSpecs[selection.workflowRunSpecId];
    const validated = runSpec === undefined ? undefined : validateWorkflowRunSpecIntegrity(runSpec);
    if (
      run?.runKind !== "planning" ||
      session === undefined ||
      run.workflowRunSpecId !== selection.workflowRunSpecId ||
      runSpec?.productRunId !== selection.productRunId ||
      runSpec.sha256 !== selection.workflowRunSpecSha256 ||
      validated === undefined ||
      !validated.success
    ) {
      fail(`planningMemorySelection ${selection.planningMemorySelectionId} Run/RunSpec绑定无效`);
    }
    const node = validated?.success
      ? validated.runSpec.nodeResolutions.find(
          (candidate) => candidate.definitionNodeId === selection.definitionNodeId,
        )
      : undefined;
    const maxItems = node?.config["maxItems"];
    if (
      node?.nodeType !== "context.memory" ||
      node.activation === "skipped" ||
      typeof maxItems !== "number" ||
      !Number.isInteger(maxItems) ||
      maxItems !== selection.maxItems
    ) {
      fail(`planningMemorySelection ${selection.planningMemorySelectionId} Node/maxItems无效`);
    }
    const included = (validated?.success ? validated.runSpec.resourceResolutions : [])
      .flatMap((resource) =>
        resource.definitionNodeId === selection.definitionNodeId &&
        resource.resourceKind === "memory" &&
        resource.resolution === "included"
          ? [
              {
                memoryResultSnapshotId: resource.resourceId,
                revision: resource.expectedRevision,
                sha256: resource.expectedSha256,
              },
            ]
          : [],
      )
      .sort((left, right) =>
        left.memoryResultSnapshotId.localeCompare(right.memoryResultSnapshotId),
      );
    if (JSON.stringify(included) !== JSON.stringify(selection.selected)) {
      fail(`planningMemorySelection ${selection.planningMemorySelectionId} 与RunSpec选择不一致`);
    }
    for (const selected of selection.selected) {
      const memory = entities.memoryResultSnapshots[selected.memoryResultSnapshotId];
      const query = memory === undefined ? undefined : entities.memoryQueries[memory.memoryQueryId];
      const sourceRun = query === undefined ? undefined : entities.runs[query.productRunId];
      const sourceOwner =
        sourceRun === undefined
          ? undefined
          : entities.sessions[sourceRun.sessionId]?.ownerPrincipalId;
      if (
        memory === undefined ||
        memory.revision !== selected.revision ||
        memory.sha256 !== selected.sha256 ||
        sourceOwner !== session?.ownerPrincipalId
      ) {
        fail(
          `planningMemorySelection ${selection.planningMemorySelectionId} Snapshot越权、悬空或Hash不一致`,
        );
      }
    }
    const nodeRun = Object.values(entities.workflowNodeRuns).find(
      (candidate) =>
        candidate.productRunId === selection.productRunId &&
        candidate.definitionNodeId === selection.definitionNodeId &&
        candidate.executionPath.length === 0 &&
        candidate.attemptNumber === 1,
    );
    const output =
      nodeRun?.outputManifestId === undefined
        ? undefined
        : entities.nodeValueManifests[nodeRun.outputManifestId];
    const transition = Object.values(entities.nodeRunTransitions).find(
      (candidate) =>
        candidate.workflowNodeRunId === nodeRun?.workflowNodeRunId &&
        candidate.relatedProductRef?.kind === "planning_memory_selection" &&
        candidate.relatedProductRef.id === selection.planningMemorySelectionId &&
        candidate.relatedProductRef.sha256 === selection.sha256,
    );
    if (
      nodeRun?.status !== "succeeded" ||
      output === undefined ||
      !output.slots.some((slot) =>
        slot.refs.some(
          (ref) =>
            ref.kind === "planning_memory_selection" &&
            ref.id === selection.planningMemorySelectionId &&
            ref.revision === selection.revision &&
            ref.sha256 === selection.sha256,
        ),
      ) ||
      transition === undefined
    ) {
      fail(`planningMemorySelection ${selection.planningMemorySelectionId} 缺少原子Node终态证据`);
    }
  }
}
