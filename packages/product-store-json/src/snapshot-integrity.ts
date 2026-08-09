import { EXECUTION_CAPABILITY_MARKDOWN_COMPOSE, type ProductSnapshot } from "@chat/contracts";
import { computePlanSha256, StoreCorruptedError } from "@chat/application";
import {
  assertSingleOpenApproval,
  assertSinglePlanUnderReview,
  computeExecutionInputManifestSha256,
  computeContextPackageSha256,
  computeMemoryBackendDescriptorSha256,
  computeMemoryImportBackendDescriptorSha256,
  computeMemoryImportRequestSha256,
  computeMemoryImportSemanticDedupeSha256,
  computeMemoryQueryResultSha256,
  computeMemoryResultSnapshotSha256,
  computeRunContextRequestSha256,
  estimateMemorySectionTokens,
  hashCanonical,
  resolveMemoryImportContent,
  validateExecutionCandidate,
  assertProjectWorkGraph,
  computeProjectCandidateSha256,
  computeProjectManagementCandidateSha256,
  computeProjectMethodSnapshotSha256,
  computeProjectObservationSha256,
} from "@chat/domain";

/**
 * 完整快照的关系与生命周期校验。
 *
 * Zod负责单对象形状；这里负责Map键、跨对象引用、Hash、状态组合及双向关系。
 * open与transact都调用同一入口，任何不一致都失败关闭，绝不猜测修复。
 * 只有本入口公开；内部按产品对象拆分，避免调用方误把“通过局部校验”当作完整快照有效。
 */
export function assertSnapshotIntegrity(snapshot: ProductSnapshot): void {
  const { entities } = snapshot;
  const fail = (detail: string): never => {
    throw new StoreCorruptedError(`快照完整性校验失败:${detail}`);
  };

  assertMapKeys(snapshot, fail);
  assertSessionsAndMessages(snapshot, fail);
  assertAttempts(snapshot, fail);
  assertRuns(snapshot, fail);
  assertPlansAndReviews(snapshot, fail);
  assertLongTermContext(snapshot, fail);
  assertMemoryImports(snapshot, fail);
  assertProjects(snapshot, fail);
  assertExecution(snapshot, fail);
  assertReceiptsAndOutbox(snapshot, fail);

  for (const runId of Object.keys(entities.runs)) {
    try {
      assertSinglePlanUnderReview(
        Object.values(entities.plans).filter((plan) => plan.productRunId === runId),
      );
      assertSingleOpenApproval(
        Object.values(entities.approvalRequests).filter(
          (approval) => approval.productRunId === runId,
        ),
      );
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}

type Fail = (detail: string) => never;

function assertMapKeys(snapshot: ProductSnapshot, fail: Fail): void {
  const collections = [
    ["session", snapshot.entities.sessions, "sessionId"],
    ["message", snapshot.entities.messages, "messageId"],
    ["run", snapshot.entities.runs, "productRunId"],
    ["attempt", snapshot.entities.attempts, "attemptId"],
    ["plan", snapshot.entities.plans, "planRevisionId"],
    ["revisionInput", snapshot.entities.revisionInputs, "revisionInputId"],
    ["approval", snapshot.entities.approvalRequests, "approvalRequestId"],
    ["decision", snapshot.entities.decisions, "decisionId"],
    ["contract", snapshot.entities.executionContracts, "executionContractId"],
    ["candidate", snapshot.entities.executionCandidates, "executionCandidateId"],
    ["validation", snapshot.entities.validationResults, "validationResultId"],
    ["artifact", snapshot.entities.artifacts, "artifactId"],
    ["contextRequest", snapshot.entities.contextRequests, "contextRequestId"],
    ["memoryQuery", snapshot.entities.memoryQueries, "memoryQueryId"],
    ["memorySnapshot", snapshot.entities.memoryResultSnapshots, "memoryResultSnapshotId"],
    ["memoryAdoption", snapshot.entities.memoryAdoptions, "memoryAdoptionId"],
    ["contextPackage", snapshot.entities.contextPackages, "contextPackageId"],
    ["memoryImportIntent", snapshot.entities.memoryImportIntents, "memoryImportIntentId"],
    ["memoryImportResult", snapshot.entities.memoryImportResults, "memoryImportResultId"],
    ["project", snapshot.entities.projects, "projectId"],
    ["projectMethod", snapshot.entities.projectMethodSnapshots, "projectMethodSnapshotId"],
    ["projectStage", snapshot.entities.projectStages, "projectStageId"],
    ["projectResource", snapshot.entities.projectResources, "projectResourceId"],
    ["projectParticipant", snapshot.entities.projectParticipants, "projectParticipantId"],
    ["projectWork", snapshot.entities.projectWorks, "projectWorkId"],
    ["projectAction", snapshot.entities.projectActions, "projectActionId"],
    ["projectContribution", snapshot.entities.projectContributions, "projectContributionId"],
    ["projectEvidence", snapshot.entities.projectEvidence, "projectEvidenceId"],
    ["projectDecision", snapshot.entities.projectDecisions, "projectDecisionId"],
    ["projectObservation", snapshot.entities.projectObservations, "projectObservationId"],
    ["projectCandidate", snapshot.entities.projectCandidates, "projectCandidateId"],
    ["receipt", snapshot.commandReceipts, "commandId"],
    ["outbox", snapshot.outbox, "outboxId"],
  ] as const;
  for (const [label, collection, idField] of collections) {
    for (const [key, entity] of Object.entries(collection)) {
      if ((entity as unknown as Record<string, string>)[idField] !== key) {
        fail(`${label} Map键${key}与${idField}不一致`);
      }
    }
  }
}

function assertProjects(snapshot: ProductSnapshot, fail: Fail): void {
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
      }) !== method.sha256
    ) {
      fail(`projectMethod ${method.projectMethodSnapshotId} Hash不一致`);
    }
  }
  for (const stage of Object.values(entities.projectStages)) {
    if (entities.projects[stage.projectId] === undefined)
      fail(`projectStage ${stage.projectStageId} 悬空Project`);
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
  }
}

function assertMemoryImports(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const resultCountByIntent = new Map<string, number>();
  const liveDedupe = new Set<string>();

  for (const intent of Object.values(entities.memoryImportIntents)) {
    const message = entities.messages[intent.sourceSelection.sourceMessageId];
    const session = message === undefined ? undefined : entities.sessions[message.sessionId];
    if (
      message === undefined ||
      session === undefined ||
      session.ownerPrincipalId !== intent.requestedByPrincipalId
    ) {
      fail(`memoryImportIntent ${intent.memoryImportIntentId} 来源Message/Principal不一致`);
    }
    if (
      intent.operationId !== intent.memoryImportIntentId ||
      intent.backendDescriptor.backendId !== intent.backendId ||
      !intent.backendDescriptor.configured ||
      intent.memoryLayer !== intent.backendDescriptor.capabilities.layers[0] ||
      intent.updatedAt !== intent.createdAt
    ) {
      fail(`memoryImportIntent ${intent.memoryImportIntentId} 冻结字段不一致`);
    }
    if (
      new Set(intent.tags).size !== intent.tags.length ||
      JSON.stringify([...intent.tags].sort()) !== JSON.stringify(intent.tags)
    ) {
      fail(`memoryImportIntent ${intent.memoryImportIntentId} 标签未规范化`);
    }
    try {
      const content = resolveMemoryImportContent({
        message,
        selection: intent.sourceSelection,
        maxContentChars: intent.backendDescriptor.capabilities.maxContentChars,
      });
      if (
        computeMemoryImportBackendDescriptorSha256(intent.backendDescriptor) !==
        intent.backendDescriptorSha256
      ) {
        fail(`memoryImportIntent ${intent.memoryImportIntentId} Backend Hash不一致`);
      }
      if (
        computeMemoryImportRequestSha256(
          intent.backendDescriptor.kind === "tencent_memorycore"
            ? {
                kind: "tencent_conversation_capture",
                content,
                layer: "L0",
                turnId: message.messageId,
              }
            : {
                content,
                layer: "L2",
                title: intent.title,
                tags: intent.tags,
                turnId: message.messageId,
              },
        ) !== intent.requestSha256
      ) {
        fail(`memoryImportIntent ${intent.memoryImportIntentId} Request Hash不一致`);
      }
      if (
        computeMemoryImportSemanticDedupeSha256({
          requestedByPrincipalId: intent.requestedByPrincipalId,
          sourceSelection: intent.sourceSelection,
          backendId: intent.backendId,
          title: intent.title,
          tags: intent.tags,
        }) !== intent.semanticDedupeSha256
      ) {
        fail(`memoryImportIntent ${intent.memoryImportIntentId} Semantic Hash不一致`);
      }
    } catch (error) {
      fail(
        `memoryImportIntent ${intent.memoryImportIntentId} 内容证据无效:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  for (const result of Object.values(entities.memoryImportResults)) {
    const intent = entities.memoryImportIntents[result.memoryImportIntentId];
    if (intent === undefined) {
      fail(`memoryImportResult ${result.memoryImportResultId} 悬空Intent`);
    }
    resultCountByIntent.set(
      result.memoryImportIntentId,
      (resultCountByIntent.get(result.memoryImportIntentId) ?? 0) + 1,
    );
    if (Date.parse(result.updatedAt) < Date.parse(result.createdAt)) {
      fail(`memoryImportResult ${result.memoryImportResultId} 时间线倒置`);
    }
    if (
      (result.status === "queued" &&
        (result.dispatchAttempts !== 0 || result.reconcileAttempts !== 0)) ||
      (result.status === "dispatching" &&
        (result.dispatchAttempts < 1 || result.dispatchStartedAt !== result.updatedAt)) ||
      (result.status === "accepted" &&
        (result.dispatchAttempts < 1 ||
          Date.parse(result.acceptedAt) > Date.parse(result.updatedAt))) ||
      (result.status === "materialized" &&
        (result.dispatchAttempts < 1 ||
          result.reconcileAttempts < 1 ||
          result.materializedAt !== result.updatedAt ||
          Date.parse(result.acceptedAt) > Date.parse(result.materializedAt))) ||
      (result.status === "failed" && result.failedAt !== result.updatedAt) ||
      (result.status === "outcome_unknown" &&
        (Date.parse(result.unknownSince) > Date.parse(result.updatedAt) ||
          (result.lastReconciledAt !== undefined && result.lastReconciledAt !== result.updatedAt)))
    ) {
      fail(`memoryImportResult ${result.memoryImportResultId} 状态时间或计数不一致`);
    }
    if (result.status !== "failed") {
      if (liveDedupe.has(intent.semanticDedupeSha256)) {
        fail(`memoryImportIntent semanticDedupeSha256重复`);
      }
      liveDedupe.add(intent.semanticDedupeSha256);
    }
  }

  for (const intent of Object.values(entities.memoryImportIntents)) {
    if ((resultCountByIntent.get(intent.memoryImportIntentId) ?? 0) !== 1) {
      fail(`memoryImportIntent ${intent.memoryImportIntentId} 必须恰有一个Result`);
    }
  }
}

function assertSessionsAndMessages(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  for (const session of Object.values(entities.sessions)) {
    const messages = Object.values(entities.messages)
      .filter((message) => message.sessionId === session.sessionId)
      .sort((a, b) => a.sessionSequence - b.sessionSequence);
    const sequences = new Set(messages.map((message) => message.sessionSequence));
    if (sequences.size !== messages.length) fail(`session ${session.sessionId} Message序号重复`);
    const maximum = messages.at(-1)?.sessionSequence ?? 0;
    if (maximum !== session.lastMessageSequence) {
      fail(`session ${session.sessionId} lastMessageSequence与消息不一致`);
    }
    for (let index = 0; index < messages.length; index += 1) {
      if (messages[index]?.sessionSequence !== index + 1) {
        fail(`session ${session.sessionId} Message序号不连续`);
      }
    }
  }

  for (const message of Object.values(entities.messages)) {
    if (entities.sessions[message.sessionId] === undefined) {
      fail(`message ${message.messageId} 悬空sessionId`);
    }
    if (message.role === "user" && message.sourceRunId !== undefined) {
      fail(`user message ${message.messageId} 不允许sourceRunId`);
    }
    if (message.role === "assistant" && message.sourceRunId === undefined) {
      fail(`assistant message ${message.messageId} 缺少sourceRunId`);
    }
    if (message.sourceRunId !== undefined) {
      const run = entities.runs[message.sourceRunId];
      if (run === undefined) fail(`message ${message.messageId} 悬空sourceRunId`);
      if (run.sessionId !== message.sessionId)
        fail(`message ${message.messageId} 与Run不属于同一Session`);
    }
  }
}

function assertAttempts(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  for (const attempt of Object.values(entities.attempts)) {
    const run = entities.runs[attempt.productRunId];
    if (run === undefined) fail(`attempt ${attempt.attemptId} 悬空productRunId`);
    if (attempt.outcome === "failure" && attempt.errorCode === undefined) {
      fail(`attempt ${attempt.attemptId} failure缺少errorCode`);
    }
    if (attempt.outcome !== "failure" && attempt.errorCode !== undefined) {
      fail(`attempt ${attempt.attemptId} 非failure不允许errorCode`);
    }

    const versionEvidence = [
      attempt.inputManifestSha256,
      attempt.promptTemplateVersion,
      attempt.modelConfigVersion,
    ];
    if (attempt.kind === "planning") {
      if (
        attempt.planRevision === undefined ||
        attempt.inputRunRevision === undefined ||
        attempt.sourceMessageSha256 === undefined ||
        versionEvidence.some((value) => value === undefined)
      ) {
        fail(`planning attempt ${attempt.attemptId} 缺少输入与版本证据`);
      }
      if (attempt.stepId !== undefined) fail(`planning attempt ${attempt.attemptId} 不允许stepId`);
      if (run.sourceMessageId === undefined)
        fail(`planning attempt ${attempt.attemptId} 缺少源消息`);
      const source = entities.messages[run.sourceMessageId];
      if (source === undefined) fail(`planning attempt ${attempt.attemptId} 源消息不存在`);
      const sourceHash = hashCanonical("message.v1", {
        messageId: source.messageId,
        sessionId: source.sessionId,
        sessionSequence: source.sessionSequence,
        role: source.role,
        content: source.content,
      });
      if (sourceHash !== attempt.sourceMessageSha256) {
        fail(`planning attempt ${attempt.attemptId} sourceMessageSha256不一致`);
      }
      const prior =
        attempt.priorPlanRevisionId === undefined
          ? undefined
          : entities.plans[attempt.priorPlanRevisionId];
      const revisionInput =
        attempt.revisionInputId === undefined
          ? undefined
          : entities.revisionInputs[attempt.revisionInputId];
      const contextPackage =
        attempt.contextPackageId === undefined
          ? undefined
          : entities.contextPackages[attempt.contextPackageId];
      if (attempt.priorPlanRevisionId !== undefined && prior === undefined) {
        fail(`planning attempt ${attempt.attemptId} 悬空priorPlanRevisionId`);
      }
      if (attempt.revisionInputId !== undefined && revisionInput === undefined) {
        fail(`planning attempt ${attempt.attemptId} 悬空revisionInputId`);
      }
      if (
        (attempt.contextPackageId === undefined) !==
        (attempt.contextPackageSha256 === undefined)
      ) {
        fail(`planning attempt ${attempt.attemptId} ContextPackage证据不成对`);
      }
      if (
        attempt.contextPackageId !== undefined &&
        (contextPackage === undefined ||
          contextPackage.productRunId !== attempt.productRunId ||
          contextPackage.sha256 !== attempt.contextPackageSha256)
      ) {
        fail(`planning attempt ${attempt.attemptId} ContextPackage引用不一致`);
      }
      if ((attempt.planRevision ?? 1) > 1 && (prior === undefined || revisionInput === undefined)) {
        fail(`planning attempt ${attempt.attemptId} 修订轮缺少上一版Plan或Revision Input`);
      }
      const manifest = hashCanonical(
        contextPackage === undefined ? "planning-input-manifest.v1" : "planning-input-manifest.v2",
        {
          productRunId: attempt.productRunId,
          planRevision: attempt.planRevision,
          sourceMessageRef: { messageId: source.messageId, sha256: sourceHash },
          ...(prior !== undefined
            ? {
                priorPlanRef: {
                  planRevisionId: prior.planRevisionId,
                  planId: prior.planId,
                  planRevision: prior.planRevision,
                  sha256: prior.sha256,
                },
              }
            : {}),
          ...(revisionInput !== undefined
            ? { revisionInputRef: { revisionInputId: revisionInput.revisionInputId } }
            : {}),
          ...(contextPackage !== undefined
            ? {
                contextPackageRef: {
                  contextPackageId: contextPackage.contextPackageId,
                  revision: contextPackage.revision,
                  sha256: contextPackage.sha256,
                },
              }
            : {}),
          promptTemplateVersion: attempt.promptTemplateVersion,
          modelConfigVersion: attempt.modelConfigVersion,
        },
      );
      if (manifest !== attempt.inputManifestSha256) {
        fail(`planning attempt ${attempt.attemptId} inputManifestSha256不一致`);
      }
    } else if (attempt.kind === "execution") {
      if (attempt.stepId === undefined || versionEvidence.some((value) => value === undefined)) {
        fail(`execution attempt ${attempt.attemptId} 缺少stepId或输入版本证据`);
      }
      if (
        attempt.planRevision !== undefined ||
        attempt.inputRunRevision !== undefined ||
        attempt.sourceMessageSha256 !== undefined ||
        attempt.priorPlanRevisionId !== undefined ||
        attempt.revisionInputId !== undefined ||
        attempt.contextPackageId !== undefined ||
        attempt.contextPackageSha256 !== undefined
      ) {
        fail(`execution attempt ${attempt.attemptId} 不允许planning输入证据`);
      }
    } else if (
      attempt.stepId !== undefined ||
      attempt.planRevision !== undefined ||
      attempt.inputRunRevision !== undefined ||
      attempt.sourceMessageSha256 !== undefined ||
      attempt.priorPlanRevisionId !== undefined ||
      attempt.revisionInputId !== undefined ||
      attempt.contextPackageId !== undefined ||
      attempt.contextPackageSha256 !== undefined ||
      versionEvidence.some((value) => value !== undefined)
    ) {
      fail(`workflow attempt ${attempt.attemptId} 不允许节点输入证据`);
    }
  }
}

function assertLongTermContext(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const indexes = indexLongTermContext(entities);

  assertContextRequests(entities, indexes, fail);
  assertMemoryQueries(entities, indexes, fail);
  assertMemorySnapshots(entities, fail);
  assertContextPackages(entities, fail);
  assertMemoryAdoptions(entities, indexes, fail);
  assertLongTermContextCardinalityAndReuse(entities, indexes, fail);
}

type SnapshotEntities = ProductSnapshot["entities"];
type ContextRequestEntity = SnapshotEntities["contextRequests"][string];
type MemoryQueryEntity = SnapshotEntities["memoryQueries"][string];
type CompletedMemoryQueryEntity = Extract<MemoryQueryEntity, { status: "completed" }>;
type MemorySnapshotEntity = SnapshotEntities["memoryResultSnapshots"][string];
type MemoryAdoptionEntity = SnapshotEntities["memoryAdoptions"][string];
type PlanningAttemptEntity = SnapshotEntities["attempts"][string];

interface LongTermContextIndexes {
  readonly requestCountByRun: ReadonlyMap<string, number>;
  readonly requestByRun: ReadonlyMap<string, ContextRequestEntity>;
  readonly queryCountByRequest: ReadonlyMap<string, number>;
  readonly packageCountByQuery: ReadonlyMap<string, number>;
  readonly adoptionsByPackage: ReadonlyMap<string, readonly MemoryAdoptionEntity[]>;
  readonly packageItemCountBySnapshot: ReadonlyMap<string, number>;
  readonly adoptionCountBySnapshot: ReadonlyMap<string, number>;
  readonly planningAttemptsByRun: ReadonlyMap<string, readonly PlanningAttemptEntity[]>;
}

/** 多个基数不变量共享同一批索引，避免在完整性校验中反复扫描整张对象图。 */
function indexLongTermContext(entities: SnapshotEntities): LongTermContextIndexes {
  const requestCountByRun = new Map<string, number>();
  const requestByRun = new Map<string, ContextRequestEntity>();
  for (const request of Object.values(entities.contextRequests)) {
    requestCountByRun.set(
      request.productRunId,
      (requestCountByRun.get(request.productRunId) ?? 0) + 1,
    );
    if (!requestByRun.has(request.productRunId)) requestByRun.set(request.productRunId, request);
  }

  const queryCountByRequest = new Map<string, number>();
  for (const query of Object.values(entities.memoryQueries)) {
    queryCountByRequest.set(
      query.contextRequestId,
      (queryCountByRequest.get(query.contextRequestId) ?? 0) + 1,
    );
  }

  const packageCountByQuery = new Map<string, number>();
  const packageItemCountBySnapshot = new Map<string, number>();
  for (const contextPackage of Object.values(entities.contextPackages)) {
    packageCountByQuery.set(
      contextPackage.memoryQueryId,
      (packageCountByQuery.get(contextPackage.memoryQueryId) ?? 0) + 1,
    );
    for (const item of contextPackage.items) {
      packageItemCountBySnapshot.set(
        item.memoryResultSnapshotId,
        (packageItemCountBySnapshot.get(item.memoryResultSnapshotId) ?? 0) + 1,
      );
    }
  }

  const adoptionsByPackage = new Map<string, MemoryAdoptionEntity[]>();
  const adoptionCountBySnapshot = new Map<string, number>();
  for (const adoption of Object.values(entities.memoryAdoptions)) {
    const packageAdoptions = adoptionsByPackage.get(adoption.contextPackageId) ?? [];
    packageAdoptions.push(adoption);
    adoptionsByPackage.set(adoption.contextPackageId, packageAdoptions);
    adoptionCountBySnapshot.set(
      adoption.memoryResultSnapshotId,
      (adoptionCountBySnapshot.get(adoption.memoryResultSnapshotId) ?? 0) + 1,
    );
  }

  const planningAttemptsByRun = new Map<string, PlanningAttemptEntity[]>();
  for (const attempt of Object.values(entities.attempts)) {
    if (attempt.kind !== "planning") continue;
    const attempts = planningAttemptsByRun.get(attempt.productRunId) ?? [];
    attempts.push(attempt);
    planningAttemptsByRun.set(attempt.productRunId, attempts);
  }

  return {
    requestCountByRun,
    requestByRun,
    queryCountByRequest,
    packageCountByQuery,
    adoptionsByPackage,
    packageItemCountBySnapshot,
    adoptionCountBySnapshot,
    planningAttemptsByRun,
  };
}

function assertContextRequests(
  entities: SnapshotEntities,
  indexes: LongTermContextIndexes,
  fail: Fail,
): void {
  for (const request of Object.values(entities.contextRequests)) {
    if (request.updatedAt !== request.createdAt) {
      fail(`contextRequest ${request.contextRequestId} 不可变时间戳不一致`);
    }
    if (
      request.memory !== undefined &&
      (new Set(request.memory.tags).size !== request.memory.tags.length ||
        new Set(request.memory.layers).size !== request.memory.layers.length)
    ) {
      fail(`contextRequest ${request.contextRequestId} Memory选择包含重复项`);
    }
    const run = entities.runs[request.productRunId];
    const message = entities.messages[request.sourceMessageId];
    const session = run === undefined ? undefined : entities.sessions[run.sessionId];
    if (run === undefined) {
      fail(`contextRequest ${request.contextRequestId} 悬空productRunId`);
    }
    if (
      message === undefined ||
      message.messageId !== run.sourceMessageId ||
      message.role !== "user" ||
      session === undefined ||
      session.ownerPrincipalId !== request.requestedByPrincipalId
    ) {
      fail(`contextRequest ${request.contextRequestId} 与Message/Principal不一致`);
    }
    const sourceMessageSha256 = hashCanonical("message.v1", {
      messageId: message.messageId,
      sessionId: message.sessionId,
      sessionSequence: message.sessionSequence,
      role: message.role,
      content: message.content,
    });
    if (sourceMessageSha256 !== request.sourceMessageSha256) {
      fail(`contextRequest ${request.contextRequestId} sourceMessageSha256不一致`);
    }
    const requestSha256 = computeRunContextRequestSha256({
      productRunId: request.productRunId,
      requestedByPrincipalId: request.requestedByPrincipalId,
      sourceMessageId: request.sourceMessageId,
      sourceMessageSha256: request.sourceMessageSha256,
      ...(request.memory !== undefined ? { memory: request.memory } : {}),
    });
    if (requestSha256 !== request.sha256) {
      fail(`contextRequest ${request.contextRequestId} Hash不一致`);
    }
  }
  for (const run of Object.values(entities.runs)) {
    if ((indexes.requestCountByRun.get(run.productRunId) ?? 0) !== 1) {
      fail(`run ${run.productRunId} 必须恰有一个ContextRequest`);
    }
  }
}

function assertMemoryQueries(
  entities: SnapshotEntities,
  indexes: LongTermContextIndexes,
  fail: Fail,
): void {
  for (const query of Object.values(entities.memoryQueries)) {
    const request = entities.contextRequests[query.contextRequestId];
    if (
      request === undefined ||
      request.memory === undefined ||
      request.productRunId !== query.productRunId ||
      request.memory.backendId !== query.backendId ||
      request.memory.requirement !== query.requirement ||
      JSON.stringify(request.memory.tags) !== JSON.stringify(query.tags) ||
      JSON.stringify(request.memory.layers) !== JSON.stringify(query.layers) ||
      request.memory.limit !== query.limit ||
      request.memory.contextBudget !== query.contextBudget
    ) {
      fail(`memoryQuery ${query.memoryQueryId} 与ContextRequest不一致`);
    }
    const run = entities.runs[query.productRunId];
    const message = run === undefined ? undefined : entities.messages[run.sourceMessageId];
    if (message === undefined) fail(`memoryQuery ${query.memoryQueryId} 源消息不存在`);
    const sourceHash = hashCanonical("message.v1", {
      messageId: message.messageId,
      sessionId: message.sessionId,
      sessionSequence: message.sessionSequence,
      role: message.role,
      content: message.content,
    });
    if (sourceHash !== query.sourceMessageSha256) {
      fail(`memoryQuery ${query.memoryQueryId} sourceMessageSha256不一致`);
    }
    if (query.planRevision !== 1) {
      fail(`memoryQuery ${query.memoryQueryId} 必须在首版规划前冻结`);
    }
    if (
      query.backendDescriptor.backendId !== query.backendId ||
      computeMemoryBackendDescriptorSha256(query.backendDescriptor) !==
        query.backendDescriptorSha256
    ) {
      fail(`memoryQuery ${query.memoryQueryId} 后端描述证据不一致`);
    }
    const capabilityLayers = new Set(query.backendDescriptor.capabilities.layers);
    if (
      capabilityLayers.size !== query.backendDescriptor.capabilities.layers.length ||
      query.layers.some((layer) => !capabilityLayers.has(layer)) ||
      query.limit > query.backendDescriptor.capabilities.maxLimit ||
      query.contextBudget > query.backendDescriptor.capabilities.maxContextBudget
    ) {
      fail(`memoryQuery ${query.memoryQueryId} 查询选择超出后端能力`);
    }
    if (
      new Set(query.tags).size !== query.tags.length ||
      new Set(query.layers).size !== query.layers.length
    ) {
      fail(`memoryQuery ${query.memoryQueryId} 查询条件包含重复项`);
    }
    if (
      query.startedAt !== query.createdAt ||
      Date.parse(query.createdAt) < Date.parse(request.createdAt) ||
      (query.status === "pending" && query.updatedAt !== query.createdAt) ||
      (query.status !== "pending" &&
        (Date.parse(query.completedAt) < Date.parse(query.startedAt) ||
          query.updatedAt !== query.completedAt))
    ) {
      fail(`memoryQuery ${query.memoryQueryId} 时间线倒置`);
    }
    if (query.status === "completed" && query.hitCount < query.adoptedCount) {
      fail(`memoryQuery ${query.memoryQueryId} hitCount小于adoptedCount`);
    }
  }
  for (const request of Object.values(entities.contextRequests)) {
    const queryCount = indexes.queryCountByRequest.get(request.contextRequestId) ?? 0;
    if (queryCount > 1 || (request.memory === undefined && queryCount !== 0)) {
      fail(`contextRequest ${request.contextRequestId} 与Memory Query数量不一致`);
    }
  }
}

function assertMemorySnapshots(entities: SnapshotEntities, fail: Fail): void {
  for (const memorySnapshot of Object.values(entities.memoryResultSnapshots)) {
    const query = entities.memoryQueries[memorySnapshot.memoryQueryId];
    if (
      query === undefined ||
      query.status !== "completed" ||
      query.backendId !== memorySnapshot.backendId
    ) {
      fail(`memorySnapshot ${memorySnapshot.memoryResultSnapshotId} 与Query不一致`);
    }
    if (
      memorySnapshot.updatedAt !== memorySnapshot.createdAt ||
      memorySnapshot.createdAt !== query.completedAt
    ) {
      fail(`memorySnapshot ${memorySnapshot.memoryResultSnapshotId} 时间线不一致`);
    }
    if (
      new Set(memorySnapshot.externalObjectIds).size !== memorySnapshot.externalObjectIds.length ||
      new Set(memorySnapshot.tags).size !== memorySnapshot.tags.length
    ) {
      fail(`memorySnapshot ${memorySnapshot.memoryResultSnapshotId} 包含重复来源或标签`);
    }
    if (estimateMemorySectionTokens(memorySnapshot) !== memorySnapshot.tokenEstimate) {
      fail(`memorySnapshot ${memorySnapshot.memoryResultSnapshotId} Token估算不一致`);
    }
    const expected = computeMemoryResultSnapshotSha256({
      backendId: memorySnapshot.backendId,
      externalObjectIds: memorySnapshot.externalObjectIds,
      title: memorySnapshot.title,
      kind: memorySnapshot.kind,
      memoryLayer: memorySnapshot.memoryLayer,
      content: memorySnapshot.content,
      tags: memorySnapshot.tags,
      ...(memorySnapshot.score !== undefined ? { score: memorySnapshot.score } : {}),
      ...(memorySnapshot.tokenEstimate !== undefined
        ? { tokenEstimate: memorySnapshot.tokenEstimate }
        : {}),
      ...(memorySnapshot.sourceUpdatedAt !== undefined
        ? { sourceUpdatedAt: memorySnapshot.sourceUpdatedAt }
        : {}),
    });
    if (expected !== memorySnapshot.sha256) {
      fail(`memorySnapshot ${memorySnapshot.memoryResultSnapshotId} Hash不一致`);
    }
  }
}

function assertContextPackages(entities: SnapshotEntities, fail: Fail): void {
  for (const contextPackage of Object.values(entities.contextPackages)) {
    const request = entities.contextRequests[contextPackage.contextRequestId];
    const query = entities.memoryQueries[contextPackage.memoryQueryId];
    if (
      request === undefined ||
      query === undefined ||
      request.productRunId !== contextPackage.productRunId ||
      query.productRunId !== contextPackage.productRunId ||
      query.contextRequestId !== contextPackage.contextRequestId ||
      query.status === "pending" ||
      contextPackage.assembledForPlanRevision !== query.planRevision
    ) {
      fail(`contextPackage ${contextPackage.contextPackageId} 血缘不一致`);
    }
    if (
      contextPackage.updatedAt !== contextPackage.createdAt ||
      contextPackage.createdAt !== query.completedAt
    ) {
      fail(`contextPackage ${contextPackage.contextPackageId} 时间线不一致`);
    }
    const seenSnapshots = new Set<string>();
    for (const item of contextPackage.items) {
      const memorySnapshot = entities.memoryResultSnapshots[item.memoryResultSnapshotId];
      if (
        memorySnapshot === undefined ||
        memorySnapshot.memoryQueryId !== query.memoryQueryId ||
        memorySnapshot.revision !== item.revision ||
        memorySnapshot.sha256 !== item.sha256 ||
        seenSnapshots.has(item.memoryResultSnapshotId)
      ) {
        fail(`contextPackage ${contextPackage.contextPackageId} item引用不一致`);
      }
      seenSnapshots.add(item.memoryResultSnapshotId);
    }
    if (query.status === "completed") {
      assertCompletedContextPackage(contextPackage, query, entities, fail);
    } else if (
      query.requirement !== "optional" ||
      contextPackage.items.length !== 0 ||
      contextPackage.exclusions.length !== 1 ||
      contextPackage.exclusions[0]?.backendId !== query.backendId ||
      contextPackage.exclusions[0]?.reasonCode !== query.errorCode
    ) {
      fail(`contextPackage ${contextPackage.contextPackageId} optional失败投影不一致`);
    }
    const expected = computeContextPackageSha256({
      contextRequestId: contextPackage.contextRequestId,
      productRunId: contextPackage.productRunId,
      assembledForPlanRevision: contextPackage.assembledForPlanRevision,
      purpose: contextPackage.purpose,
      memoryQueryId: contextPackage.memoryQueryId,
      items: contextPackage.items,
      exclusions: contextPackage.exclusions,
    });
    if (expected !== contextPackage.sha256) {
      fail(`contextPackage ${contextPackage.contextPackageId} Hash不一致`);
    }
  }
}

/** 完成态Query必须能从冻结Snapshot逐字重算结果证据，不能信任外部服务摘要。 */
function assertCompletedContextPackage(
  contextPackage: SnapshotEntities["contextPackages"][string],
  query: CompletedMemoryQueryEntity,
  entities: SnapshotEntities,
  fail: Fail,
): void {
  if (
    contextPackage.exclusions.length !== 0 ||
    query.adoptedCount !== contextPackage.items.length ||
    contextPackage.items.length > query.limit
  ) {
    fail(`contextPackage ${contextPackage.contextPackageId} 完成结果数量不一致`);
  }
  const snapshots = contextPackage.items.map(
    (item) => entities.memoryResultSnapshots[item.memoryResultSnapshotId],
  );
  if (snapshots.some((snapshot) => snapshot === undefined)) {
    fail(`contextPackage ${contextPackage.contextPackageId} 缺少Memory Snapshot`);
  }
  const presentSnapshots = snapshots.filter(
    (snapshot): snapshot is MemorySnapshotEntity => snapshot !== undefined,
  );
  const tokenEstimate = presentSnapshots.reduce(
    (total, snapshot) => total + estimateMemorySectionTokens(snapshot),
    0,
  );
  if (tokenEstimate > query.tokenEstimate || query.tokenEstimate > query.contextBudget) {
    fail(`contextPackage ${contextPackage.contextPackageId} 超预算或Token估算不一致`);
  }
  const resultSetSha256 = computeMemoryQueryResultSha256({
    externalQueryId: query.externalQueryId,
    hitCount: query.hitCount,
    tokenEstimate: query.tokenEstimate,
    sections: presentSnapshots.map((snapshot) => ({
      externalObjectIds: snapshot.externalObjectIds,
      title: snapshot.title,
      kind: snapshot.kind,
      memoryLayer: snapshot.memoryLayer,
      content: snapshot.content,
      tags: snapshot.tags,
      ...(snapshot.score !== undefined ? { score: snapshot.score } : {}),
      tokenEstimate: snapshot.tokenEstimate,
      ...(snapshot.sourceUpdatedAt !== undefined
        ? { sourceUpdatedAt: snapshot.sourceUpdatedAt }
        : {}),
    })),
  });
  if (resultSetSha256 !== query.resultSetSha256) {
    fail(`memoryQuery ${query.memoryQueryId} resultSetSha256不一致`);
  }
  const sourceCount = new Set(
    presentSnapshots.flatMap((memorySnapshot) => memorySnapshot.externalObjectIds),
  ).size;
  if (sourceCount > query.hitCount) {
    fail(`memoryQuery ${query.memoryQueryId} hitCount小于结果来源数量`);
  }
}

function assertMemoryAdoptions(
  entities: SnapshotEntities,
  indexes: LongTermContextIndexes,
  fail: Fail,
): void {
  for (const adoption of Object.values(entities.memoryAdoptions)) {
    const contextPackage = entities.contextPackages[adoption.contextPackageId];
    const memorySnapshot = entities.memoryResultSnapshots[adoption.memoryResultSnapshotId];
    if (
      contextPackage === undefined ||
      memorySnapshot === undefined ||
      contextPackage.productRunId !== adoption.productRunId ||
      !contextPackage.items.some(
        (item) => item.memoryResultSnapshotId === adoption.memoryResultSnapshotId,
      ) ||
      memorySnapshot.memoryQueryId !== contextPackage.memoryQueryId
    ) {
      fail(`memoryAdoption ${adoption.memoryAdoptionId} 绑定不一致`);
    }
    if (
      adoption.updatedAt !== adoption.createdAt ||
      adoption.createdAt !== contextPackage.createdAt ||
      adoption.createdAt !== memorySnapshot.createdAt
    ) {
      fail(`memoryAdoption ${adoption.memoryAdoptionId} 时间线不一致`);
    }
  }
  for (const contextPackage of Object.values(entities.contextPackages)) {
    const adoptions = indexes.adoptionsByPackage.get(contextPackage.contextPackageId) ?? [];
    const adoptedIds = new Set(adoptions.map((adoption) => adoption.memoryResultSnapshotId));
    if (
      adoptions.length !== contextPackage.items.length ||
      adoptedIds.size !== contextPackage.items.length ||
      contextPackage.items.some((item) => !adoptedIds.has(item.memoryResultSnapshotId))
    ) {
      fail(`contextPackage ${contextPackage.contextPackageId} 与Adoption不是一一对应`);
    }
  }
}

function assertLongTermContextCardinalityAndReuse(
  entities: SnapshotEntities,
  indexes: LongTermContextIndexes,
  fail: Fail,
): void {
  for (const memorySnapshot of Object.values(entities.memoryResultSnapshots)) {
    const itemCount = indexes.packageItemCountBySnapshot.get(memorySnapshot.memoryResultSnapshotId);
    const adoptionCount = indexes.adoptionCountBySnapshot.get(
      memorySnapshot.memoryResultSnapshotId,
    );
    if (itemCount !== 1 || adoptionCount !== 1) {
      fail(`memorySnapshot ${memorySnapshot.memoryResultSnapshotId} 必须恰好被采用一次`);
    }
  }

  for (const query of Object.values(entities.memoryQueries)) {
    const expectedPackages =
      query.status === "completed" ||
      (query.status === "failed" && query.requirement === "optional")
        ? 1
        : 0;
    if ((indexes.packageCountByQuery.get(query.memoryQueryId) ?? 0) !== expectedPackages) {
      fail(`memoryQuery ${query.memoryQueryId} 与ContextPackage数量不一致`);
    }
  }

  for (const run of Object.values(entities.runs)) {
    const request = indexes.requestByRun.get(run.productRunId);
    const planningAttempts = indexes.planningAttemptsByRun.get(run.productRunId) ?? [];
    if (
      request?.memory !== undefined &&
      planningAttempts.some((attempt) => attempt.contextPackageId === undefined)
    ) {
      fail(`run ${run.productRunId} 有ContextRequest但Planning Attempt缺少ContextPackage`);
    }
    const packageIds = new Set(
      planningAttempts.flatMap((attempt) =>
        attempt.contextPackageId === undefined ? [] : [attempt.contextPackageId],
      ),
    );
    if (packageIds.size > 1) {
      fail(`run ${run.productRunId} M1修订轮未复用同一ContextPackage`);
    }
  }
}

function assertRuns(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const legal = new Set([
    "pending/queued",
    "running/planning",
    "running/executing",
    "running/validating",
    "waiting_human/plan_review",
    "succeeded/completed",
    "failed/queued",
    "failed/planning",
    "failed/plan_review",
    "failed/executing",
    "failed/validating",
    "cancelled/queued",
    "cancelled/planning",
    "cancelled/executing",
    "cancelled/rejected",
    "outcome_unknown/queued",
    "outcome_unknown/planning",
    "outcome_unknown/executing",
    "outcome_unknown/validating",
  ]);
  for (const run of Object.values(entities.runs)) {
    if (!legal.has(`${run.status}/${run.phase}`)) fail(`run ${run.productRunId} 生命周期组合非法`);
    const session = entities.sessions[run.sessionId];
    const source = entities.messages[run.sourceMessageId];
    if (session === undefined) fail(`run ${run.productRunId} 悬空sessionId`);
    if (source === undefined) fail(`run ${run.productRunId} 悬空sourceMessageId`);
    if (source.sessionId !== run.sessionId || source.role !== "user") {
      fail(`run ${run.productRunId} 源消息必须是同Session的User Message`);
    }
    const currentFields = [run.currentPlanId, run.currentPlanRevision];
    if (currentFields.filter((value) => value !== undefined).length === 1) {
      fail(`run ${run.productRunId} currentPlan引用不完整`);
    }
    const currentPlan = Object.values(entities.plans).find(
      (plan) =>
        plan.planId === run.currentPlanId &&
        plan.planRevision === run.currentPlanRevision &&
        plan.productRunId === run.productRunId,
    );
    if (run.currentPlanId !== undefined && currentPlan === undefined) {
      fail(`run ${run.productRunId} 悬空currentPlan引用`);
    }
    const currentApproval =
      run.currentApprovalRequestId === undefined
        ? undefined
        : entities.approvalRequests[run.currentApprovalRequestId];
    if (run.currentApprovalRequestId !== undefined && currentApproval === undefined) {
      fail(`run ${run.productRunId} 悬空currentApprovalRequestId`);
    }
    if (run.status === "waiting_human") {
      if (currentPlan?.status !== "under_review" || currentApproval?.status !== "open") {
        fail(`run ${run.productRunId} waiting_human缺少当前Plan/Approval`);
      }
      if (
        currentApproval.planId !== currentPlan.planId ||
        currentApproval.planRevision !== currentPlan.planRevision ||
        currentApproval.planSha256 !== currentPlan.sha256
      ) {
        fail(`run ${run.productRunId} 当前Approval与Plan不一致`);
      }
    } else if (run.currentApprovalRequestId !== undefined) {
      fail(`run ${run.productRunId} 非waiting_human仍保留活动Approval引用`);
    }
    if (
      (run.phase === "executing" || run.phase === "validating" || run.status === "succeeded") &&
      currentPlan?.status !== "approved"
    ) {
      fail(`run ${run.productRunId} 执行/验证/成功阶段缺少Approved Plan`);
    }
    const final =
      run.finalMessageId === undefined ? undefined : entities.messages[run.finalMessageId];
    if (run.status === "succeeded") {
      if (
        final === undefined ||
        final.role !== "assistant" ||
        final.sourceRunId !== run.productRunId
      ) {
        fail(`run ${run.productRunId} succeeded缺少绑定的Assistant Message`);
      }
      const contracts = Object.values(entities.executionContracts).filter(
        (contract) => contract.productRunId === run.productRunId,
      );
      const candidates = Object.values(entities.executionCandidates).filter(
        (candidate) => candidate.productRunId === run.productRunId,
      );
      if (contracts.length !== 1 || candidates.length !== 1) {
        fail(`run ${run.productRunId} succeeded必须恰有一个Contract与Candidate`);
      }
      const contract = contracts[0];
      const candidate = candidates[0];
      const passValidations = Object.values(entities.validationResults).filter(
        (validation) =>
          validation.productRunId === run.productRunId &&
          validation.executionContractId === contract?.executionContractId &&
          validation.executionCandidateId === candidate?.executionCandidateId &&
          validation.outcome === "pass",
      );
      if (passValidations.length !== 1) {
        fail(`run ${run.productRunId} succeeded缺少唯一pass Validation`);
      }
      const expectedMarkdown = candidate?.finalOutput.sections
        .map((section) => `## ${section.heading}\n\n${section.body}`)
        .join("\n\n");
      if (final.content.text !== expectedMarkdown) {
        fail(`run ${run.productRunId} Assistant Message不是已验证Candidate的确定性渲染`);
      }
    } else if (run.finalMessageId !== undefined) {
      fail(`run ${run.productRunId} 非succeeded不允许finalMessageId`);
    }
    if (run.status === "failed" || run.status === "outcome_unknown") {
      if (run.failure === undefined) fail(`run ${run.productRunId} 失败终态缺少failure`);
    } else if (run.failure !== undefined) {
      fail(`run ${run.productRunId} 非失败终态不允许failure`);
    }
    const workflowAttempts = Object.values(entities.attempts).filter(
      (attempt) => attempt.productRunId === run.productRunId && attempt.kind === "workflow",
    );
    if (workflowAttempts.length !== 1) fail(`run ${run.productRunId} 必须恰有一个workflow Attempt`);
  }
}

function assertPlansAndReviews(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const grouped = new Map<string, (typeof entities.plans)[string][]>();
  for (const plan of Object.values(entities.plans)) {
    const run = entities.runs[plan.productRunId];
    if (run === undefined) fail(`plan ${plan.planRevisionId} 悬空productRunId`);
    const attempt = entities.attempts[plan.planningAttemptId];
    if (
      attempt === undefined ||
      attempt.productRunId !== plan.productRunId ||
      attempt.kind !== "planning" ||
      attempt.planRevision !== plan.planRevision ||
      attempt.outcome !== "success"
    ) {
      fail(`plan ${plan.planRevisionId} 与planning Attempt不一致`);
    }
    const recomputed = computePlanSha256({
      planId: plan.planId,
      productRunId: plan.productRunId,
      planRevision: plan.planRevision,
      content: plan.content,
    });
    if (recomputed !== plan.sha256) fail(`plan ${plan.planRevisionId} Hash不一致`);
    const plans = grouped.get(plan.productRunId) ?? [];
    plans.push(plan);
    grouped.set(plan.productRunId, plans);
  }
  for (const [runId, plans] of grouped) {
    plans.sort((a, b) => a.planRevision - b.planRevision);
    const planIds = new Set(plans.map((plan) => plan.planId));
    if (planIds.size !== 1) fail(`run ${runId} 的Plan revision使用了多个planId`);
    for (let index = 0; index < plans.length; index += 1) {
      if (plans[index]?.planRevision !== index + 1) fail(`run ${runId} 的Plan revision不连续`);
    }
  }

  for (const revisionInput of Object.values(entities.revisionInputs)) {
    const plan = Object.values(entities.plans).find(
      (candidate) =>
        candidate.planId === revisionInput.planId &&
        candidate.planRevision === revisionInput.planRevision,
    );
    if (plan === undefined || plan.productRunId !== revisionInput.productRunId) {
      fail(`revisionInput ${revisionInput.revisionInputId} 与Plan/Run不一致`);
    }
  }

  for (const approval of Object.values(entities.approvalRequests)) {
    const plan = Object.values(entities.plans).find(
      (candidate) =>
        candidate.planId === approval.planId && candidate.planRevision === approval.planRevision,
    );
    if (
      plan === undefined ||
      plan.productRunId !== approval.productRunId ||
      plan.sha256 !== approval.planSha256
    ) {
      fail(`approval ${approval.approvalRequestId} 与Plan/Run/Hash不一致`);
    }
    if (Date.parse(approval.expiresAt) <= Date.parse(approval.createdAt)) {
      fail(`approval ${approval.approvalRequestId} expiresAt无效`);
    }
    if (approval.status === "open") {
      if (approval.decidedByDecisionId !== undefined || approval.expiredAt !== undefined) {
        fail(`approval ${approval.approvalRequestId} open状态字段冲突`);
      }
    } else if (approval.status === "decided") {
      if (approval.decidedByDecisionId === undefined || approval.expiredAt !== undefined) {
        fail(`approval ${approval.approvalRequestId} decided状态字段不完整`);
      }
    } else if (approval.expiredAt === undefined || approval.decidedByDecisionId !== undefined) {
      fail(`approval ${approval.approvalRequestId} expired状态字段不完整`);
    }
  }

  for (const decision of Object.values(entities.decisions)) {
    const approval = entities.approvalRequests[decision.approvalRequestId];
    if (
      approval === undefined ||
      approval.productRunId !== decision.productRunId ||
      approval.planId !== decision.planId ||
      approval.planRevision !== decision.planRevision ||
      approval.planSha256 !== decision.planSha256 ||
      approval.status !== "decided" ||
      approval.decidedByDecisionId !== decision.decisionId
    ) {
      fail(`decision ${decision.decisionId} 与Approval绑定不完整`);
    }
    if (decision.kind === "request_revision") {
      const revisionInput =
        decision.revisionInputId === undefined
          ? undefined
          : entities.revisionInputs[decision.revisionInputId];
      if (
        revisionInput === undefined ||
        revisionInput.productRunId !== decision.productRunId ||
        revisionInput.planId !== decision.planId ||
        revisionInput.planRevision !== decision.planRevision ||
        decision.reason !== undefined
      ) {
        fail(`decision ${decision.decisionId} request_revision字段不一致`);
      }
    } else if (decision.revisionInputId !== undefined) {
      fail(`decision ${decision.decisionId} 非request_revision不允许revisionInputId`);
    }
    if (decision.kind !== "reject" && decision.reason !== undefined) {
      fail(`decision ${decision.decisionId} 非reject不允许reason`);
    }
  }
}

function assertExecution(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  for (const contract of Object.values(entities.executionContracts)) {
    const decision = entities.decisions[contract.approvalDecisionId];
    const plan = Object.values(entities.plans).find(
      (candidate) =>
        candidate.planId === contract.approvedPlanId &&
        candidate.planRevision === contract.approvedPlanRevision,
    );
    if (
      decision === undefined ||
      decision.kind !== "approve" ||
      decision.productRunId !== contract.productRunId ||
      plan === undefined ||
      plan.productRunId !== contract.productRunId ||
      plan.status !== "approved" ||
      plan.sha256 !== contract.approvedPlanSha256 ||
      decision.planSha256 !== contract.approvedPlanSha256
    ) {
      fail(`contract ${contract.executionContractId} 与Approved Plan/Decision不一致`);
    }
    const expectedSteps = plan.content.steps.map((step) => ({
      stepId: step.stepId,
      title: step.title,
      purpose: step.purpose,
      dependsOn: step.dependsOn,
      inputRefs: step.inputRefs,
      expectedOutput: step.expectedOutput,
      successCriteria: step.successCriteria,
      capabilityRefs: step.requestedCapabilities,
    }));
    if (JSON.stringify(contract.steps) !== JSON.stringify(expectedSteps)) {
      fail(`contract ${contract.executionContractId} steps与Approved Plan不一致`);
    }
    if (
      JSON.stringify(contract.completionCriteria) !==
      JSON.stringify(plan.content.completionCriteria)
    ) {
      fail(`contract ${contract.executionContractId} completionCriteria不一致`);
    }
    const expectedCapabilities = [
      ...new Set(plan.content.steps.flatMap((step) => step.requestedCapabilities)),
    ];
    if (
      JSON.stringify(contract.capabilityRefs) !== JSON.stringify(expectedCapabilities) ||
      contract.capabilityRefs.some(
        (capability) => capability !== EXECUTION_CAPABILITY_MARKDOWN_COMPOSE,
      )
    ) {
      fail(`contract ${contract.executionContractId} Capability扩大或不一致`);
    }
    const hash = hashCanonical("execution-contract.v1", {
      productRunId: contract.productRunId,
      approvedPlanId: contract.approvedPlanId,
      approvedPlanRevision: contract.approvedPlanRevision,
      approvedPlanSha256: contract.approvedPlanSha256,
      approvalDecisionId: contract.approvalDecisionId,
      steps: contract.steps,
      completionCriteria: contract.completionCriteria,
      capabilityRefs: contract.capabilityRefs,
      limits: contract.limits,
    });
    if (hash !== contract.sha256) fail(`contract ${contract.executionContractId} Hash不一致`);
  }

  for (const candidate of Object.values(entities.executionCandidates)) {
    const contract = entities.executionContracts[candidate.executionContractId];
    if (contract === undefined || contract.productRunId !== candidate.productRunId) {
      fail(`candidate ${candidate.executionCandidateId} 与Contract不一致`);
    }
    if (candidate.stepResults.length !== contract.steps.length) {
      fail(`candidate ${candidate.executionCandidateId} 步骤数与Contract不一致`);
    }
    const priorResults = new Map<string, (typeof candidate.stepResults)[number]>();
    for (let index = 0; index < candidate.stepResults.length; index += 1) {
      const stepResult = candidate.stepResults[index];
      const contractStep = contract.steps[index];
      if (
        stepResult === undefined ||
        contractStep === undefined ||
        stepResult.stepId !== contractStep.stepId
      ) {
        fail(`candidate ${candidate.executionCandidateId} 步骤顺序与Contract不一致`);
      }
      const attempt = entities.attempts[stepResult.executionAttemptId];
      if (
        attempt === undefined ||
        attempt.productRunId !== candidate.productRunId ||
        attempt.kind !== "execution" ||
        attempt.stepId !== stepResult.stepId ||
        attempt.outcome !== "success" ||
        attempt.inputManifestSha256 !== stepResult.inputManifestSha256 ||
        attempt.promptTemplateVersion === undefined ||
        attempt.modelConfigVersion === undefined
      ) {
        fail(`candidate ${candidate.executionCandidateId} 步骤Attempt血缘不一致`);
      }
      if (
        stepResult.dependencyRefs.length !== contractStep.dependsOn.length ||
        stepResult.dependencyRefs.some((ref, dependencyIndex) => {
          const prior = priorResults.get(ref.stepId);
          return (
            contractStep.dependsOn[dependencyIndex] !== ref.stepId ||
            prior === undefined ||
            prior.executionAttemptId !== ref.executionAttemptId ||
            prior.sha256 !== ref.sha256
          );
        })
      ) {
        fail(`candidate ${candidate.executionCandidateId} 步骤依赖血缘不一致`);
      }
      const inputManifestSha256 = computeExecutionInputManifestSha256({
        executionContractId: contract.executionContractId,
        approvedPlanSha256: contract.approvedPlanSha256,
        stepId: stepResult.stepId,
        inputRefs: contractStep.inputRefs,
        dependencyRefs: stepResult.dependencyRefs,
        promptTemplateVersion: attempt.promptTemplateVersion,
        modelConfigVersion: attempt.modelConfigVersion,
      });
      if (inputManifestSha256 !== stepResult.inputManifestSha256) {
        fail(`candidate ${candidate.executionCandidateId} 步骤输入Manifest不一致`);
      }
      const stepHash = hashCanonical("execution-step-result.v1", {
        stepId: stepResult.stepId,
        executionAttemptId: stepResult.executionAttemptId,
        inputManifestSha256: stepResult.inputManifestSha256,
        dependencyRefs: stepResult.dependencyRefs,
        output: stepResult.output,
        sections: stepResult.sections,
        successCriteriaEvidence: stepResult.successCriteriaEvidence,
        criteriaEvidence: stepResult.criteriaEvidence,
        warnings: stepResult.warnings,
      });
      if (stepHash !== stepResult.sha256) {
        fail(`candidate ${candidate.executionCandidateId} 步骤结果Hash不一致`);
      }
      priorResults.set(stepResult.stepId, stepResult);
    }
    const hash = hashCanonical("execution-candidate.v1", {
      executionContractId: candidate.executionContractId,
      stepResults: candidate.stepResults,
      finalOutput: candidate.finalOutput,
      completionCriteriaEvidence: candidate.completionCriteriaEvidence,
      warnings: candidate.warnings,
    });
    if (hash !== candidate.sha256) fail(`candidate ${candidate.executionCandidateId} Hash不一致`);
    if (
      JSON.stringify(candidate.finalOutput.sections) !==
        JSON.stringify(candidate.stepResults.flatMap((step) => step.sections)) ||
      JSON.stringify(candidate.completionCriteriaEvidence) !==
        JSON.stringify(candidate.stepResults.flatMap((step) => step.criteriaEvidence)) ||
      JSON.stringify(candidate.warnings) !==
        JSON.stringify(candidate.stepResults.flatMap((step) => step.warnings))
    ) {
      fail(`candidate ${candidate.executionCandidateId} 汇总字段不是步骤结果的确定性投影`);
    }
  }

  for (const validation of Object.values(entities.validationResults)) {
    const contract = entities.executionContracts[validation.executionContractId];
    const candidate = entities.executionCandidates[validation.executionCandidateId];
    if (
      contract === undefined ||
      candidate === undefined ||
      contract.productRunId !== validation.productRunId ||
      candidate.productRunId !== validation.productRunId ||
      candidate.executionContractId !== validation.executionContractId
    ) {
      fail(`validation ${validation.validationResultId} 与Contract/Candidate/Run不一致`);
    }
    if ((validation.outcome === "pass") !== (validation.failures.length === 0)) {
      fail(`validation ${validation.validationResultId} outcome与failures不一致`);
    }
    const expectedFailures = validateExecutionCandidate(
      {
        executionContractId: contract.executionContractId,
        approvedPlanId: contract.approvedPlanId,
        approvedPlanRevision: contract.approvedPlanRevision,
        approvedPlanSha256: contract.approvedPlanSha256,
        steps: contract.steps,
        completionCriteria: contract.completionCriteria,
      },
      {
        executionContractId: candidate.executionContractId,
        stepResults: candidate.stepResults,
        finalOutputSections: candidate.finalOutput.sections,
        completionCriteriaEvidence: candidate.completionCriteriaEvidence,
      },
    );
    if (JSON.stringify(validation.failures) !== JSON.stringify(expectedFailures)) {
      fail(`validation ${validation.validationResultId} 不是服务端确定性验证结果`);
    }
  }

  for (const artifact of Object.values(entities.artifacts)) {
    if (entities.runs[artifact.productRunId] === undefined) {
      fail(`artifact ${artifact.artifactId} 悬空productRunId`);
    }
    const hash = hashCanonical("artifact.v1", {
      productRunId: artifact.productRunId,
      kind: artifact.kind,
      title: artifact.title,
      content: artifact.content,
    });
    if (hash !== artifact.sha256) fail(`artifact ${artifact.artifactId} Hash不一致`);
  }
}

function assertReceiptsAndOutbox(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const receipts = Object.values(snapshot.commandReceipts);
  if (receipts.length !== snapshot.storeRevision) {
    fail("Command Receipt数量与storeRevision不一致");
  }
  const committedRevisions = new Set(receipts.map((receipt) => receipt.committedStoreRevision));
  for (let revision = 1; revision <= snapshot.storeRevision; revision += 1) {
    if (!committedRevisions.has(revision)) fail(`缺少store revision ${String(revision)}的Receipt`);
  }
  const receiptShapes: Record<string, readonly string[]> = {
    CreateProductSession: ["sessionId"],
    SubmitUserMessage: ["messageId", "productRunId"],
    CompilePlanningInput: ["attemptId", "productRunId"],
    PublishPlanForReview: ["planRevisionId", "approvalRequestId", "productRunId"],
    BeginRunAttempt: ["attemptId"],
    CompleteRunAttempt: [],
    CompileExecutionContract: ["executionContractId"],
    PersistExecutionCandidate: ["executionCandidateId"],
    PersistValidationResult: ["validationResultId"],
    CommitExecutionResult: ["finalMessageId", "productRunId", "messageSha256"],
    CommitRejectedRun: ["productRunId"],
    ExpireApproval: ["status"],
    CommitRunFailure: ["productRunId"],
    UpdateOutboxStatus: [],
    FailOutboxAndRun: ["productRunId"],
    CommitRunOutcomeUnknown: ["productRunId"],
    SettleIncompatibleWorkflowRun: ["productRunId"],
    PreparePlanningContextNone: ["contextRequestId", "productRunId"],
    BeginMemoryContextQuery: ["memoryQueryId", "productRunId"],
    CompleteMemoryContextQuery: ["contextPackageId", "productRunId"],
    CommitOptionalMemoryQueryFailure: ["contextPackageId", "productRunId"],
    CommitRequiredMemoryQueryFailure: ["productRunId"],
    CreateMemoryImport: ["memoryImportIntentId", "memoryImportResultId"],
    MarkMemoryImportDispatching: ["memoryImportResultId"],
    CommitMemoryImportAccepted: ["memoryImportResultId"],
    CommitMemoryImportMaterialized: ["memoryImportResultId"],
    CommitMemoryImportFailed: ["memoryImportResultId"],
    CommitMemoryImportOutcomeUnknown: ["memoryImportResultId"],
    RequestMemoryImportReconciliation: ["memoryImportIntentId", "memoryImportResultId"],
    RecoverMemoryImportAfterTerminalWorkflow: [
      "outboxId",
      "memoryImportResultId",
      "recoveryOutboxId",
    ],
    BeginProjectIntake: ["projectCandidateId", "messageId"],
    BeginProjectManagementCandidate: ["projectCandidateId", "messageId"],
    DecideProjectManagementCandidate: ["projectCandidateId", "projectId"],
    PrepareProjectCandidateForReview: ["projectCandidateId"],
    FailProjectCandidateForReview: ["projectCandidateId"],
    CreateProjectAction: ["projectId", "projectActionId"],
    AssignProjectAction: ["projectId"],
    TransitionProjectAction: ["projectId"],
    SetProjectArchiveStatus: ["projectId"],
    RecordProjectDecision: ["projectId", "projectDecisionId"],
    RecordProjectContribution: ["projectId", "projectContributionId"],
    ObserveProjectResource: ["projectId", "projectObservationId"],
  };
  for (const receipt of receipts) {
    if (
      receipt.committedStoreRevision < 1 ||
      receipt.committedStoreRevision > snapshot.storeRevision
    ) {
      fail(`receipt ${receipt.commandId} committedStoreRevision越界`);
    }
    const expectedKeys =
      receipt.commandType === "SubmitPlanDecision"
        ? receipt.resultRefs["approvalExpired"] === "true"
          ? ["approvalExpired", "productRunId"]
          : ["decisionId", "productRunId"]
        : receipt.commandType === "DecideProjectCandidate"
          ? receipt.resultRefs["projectId"] === undefined
            ? ["projectCandidateId"]
            : ["projectCandidateId", "projectId"]
          : receiptShapes[receipt.commandType];
    if (expectedKeys === undefined) fail(`receipt ${receipt.commandId} commandType未知`);
    const actualKeys = Object.keys(receipt.resultRefs).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify([...expectedKeys].sort())) {
      fail(`receipt ${receipt.commandId} resultRefs与Command类型不一致`);
    }
    for (const [key, value] of Object.entries(receipt.resultRefs)) {
      const exists =
        key === "sessionId"
          ? entities.sessions[value] !== undefined
          : key === "messageId" || key === "finalMessageId"
            ? entities.messages[value] !== undefined
            : key === "productRunId"
              ? entities.runs[value] !== undefined
              : key === "attemptId"
                ? entities.attempts[value] !== undefined
                : key === "planRevisionId"
                  ? entities.plans[value] !== undefined
                  : key === "approvalRequestId"
                    ? entities.approvalRequests[value] !== undefined
                    : key === "decisionId"
                      ? entities.decisions[value] !== undefined
                      : key === "executionContractId"
                        ? entities.executionContracts[value] !== undefined
                        : key === "executionCandidateId"
                          ? entities.executionCandidates[value] !== undefined
                          : key === "validationResultId"
                            ? entities.validationResults[value] !== undefined
                            : key === "memoryQueryId"
                              ? entities.memoryQueries[value] !== undefined
                              : key === "contextRequestId"
                                ? entities.contextRequests[value] !== undefined
                                : key === "contextPackageId"
                                  ? entities.contextPackages[value] !== undefined
                                  : key === "memoryImportIntentId"
                                    ? entities.memoryImportIntents[value] !== undefined
                                    : key === "memoryImportResultId"
                                      ? entities.memoryImportResults[value] !== undefined
                                      : key === "outboxId" || key === "recoveryOutboxId"
                                        ? snapshot.outbox[value] !== undefined
                                        : key === "projectId"
                                          ? entities.projects[value] !== undefined
                                          : key === "projectCandidateId"
                                            ? entities.projectCandidates[value] !== undefined
                                            : key === "projectActionId"
                                              ? entities.projectActions[value] !== undefined
                                              : key === "projectDecisionId"
                                                ? entities.projectDecisions[value] !== undefined
                                                : key === "projectContributionId"
                                                  ? entities.projectContributions[value] !==
                                                    undefined
                                                  : key === "projectObservationId"
                                                    ? entities.projectObservations[value] !==
                                                      undefined
                                                    : key === "messageSha256"
                                                      ? /^[a-f0-9]{64}$/.test(value)
                                                      : key === "approvalExpired"
                                                        ? value === "true"
                                                        : key === "status"
                                                          ? value === "expired" ||
                                                            value === "already_decided"
                                                          : false;
      if (!exists) fail(`receipt ${receipt.commandId} 的${key}引用无效`);
    }
    if (receipt.commandType === "SubmitUserMessage") {
      const message = entities.messages[receipt.resultRefs["messageId"] ?? ""];
      const run = entities.runs[receipt.resultRefs["productRunId"] ?? ""];
      if (
        message === undefined ||
        run === undefined ||
        run.sourceMessageId !== message.messageId ||
        run.sessionId !== message.sessionId ||
        message.role !== "user"
      ) {
        fail(`receipt ${receipt.commandId} 的Message/Run绑定不一致`);
      }
    }
    if (receipt.commandType === "PublishPlanForReview") {
      const plan = entities.plans[receipt.resultRefs["planRevisionId"] ?? ""];
      const approval = entities.approvalRequests[receipt.resultRefs["approvalRequestId"] ?? ""];
      const run = entities.runs[receipt.resultRefs["productRunId"] ?? ""];
      if (
        plan === undefined ||
        approval === undefined ||
        run === undefined ||
        plan.productRunId !== run.productRunId ||
        approval.productRunId !== run.productRunId ||
        approval.planId !== plan.planId ||
        approval.planRevision !== plan.planRevision ||
        approval.planSha256 !== plan.sha256
      ) {
        fail(`receipt ${receipt.commandId} 的Plan/Approval/Run绑定不一致`);
      }
    }
    if (receipt.commandType === "SubmitPlanDecision") {
      const decision = entities.decisions[receipt.resultRefs["decisionId"] ?? ""];
      const run = entities.runs[receipt.resultRefs["productRunId"] ?? ""];
      if (
        receipt.resultRefs["approvalExpired"] !== "true" &&
        (decision === undefined || run === undefined || decision.productRunId !== run.productRunId)
      ) {
        fail(`receipt ${receipt.commandId} 的Decision/Run绑定不一致`);
      }
    }
    if (receipt.commandType === "CommitExecutionResult") {
      const message = entities.messages[receipt.resultRefs["finalMessageId"] ?? ""];
      const run = entities.runs[receipt.resultRefs["productRunId"] ?? ""];
      if (
        message === undefined ||
        run === undefined ||
        run.finalMessageId !== message.messageId ||
        message.sourceRunId !== run.productRunId
      ) {
        fail(`receipt ${receipt.commandId} 的正式Message/Run绑定不一致`);
      }
      const messageSha256 = hashCanonical("message.v1", {
        messageId: message.messageId,
        sessionId: message.sessionId,
        sessionSequence: message.sessionSequence,
        role: message.role,
        content: message.content,
      });
      if (receipt.resultRefs["messageSha256"] !== messageSha256) {
        fail(`receipt ${receipt.commandId} 的messageSha256不一致`);
      }
    }
  }
  for (const entry of Object.values(snapshot.outbox)) {
    if (entry.kind === "project_intake_start" || entry.kind === "project_intake_resume") {
      const candidate = entities.projectCandidates[entry.projectCandidateId];
      if (
        candidate === undefined ||
        candidate.candidateKind !== "intake" ||
        entry.expectedCandidateRevision > candidate.revision
      ) {
        fail(`outbox ${entry.outboxId} Project Intake绑定不完整`);
      }
      continue;
    }
    if (entry.kind === "workflow_start" || entry.kind === "workflow_resume") {
      if (entities.runs[entry.productRunId] === undefined) {
        fail(`outbox ${entry.outboxId} 悬空productRunId`);
      }
      if (entry.kind === "workflow_start") continue;
      const approval = entities.approvalRequests[entry.approvalRequestId];
      const decision = entities.decisions[entry.decisionId];
      if (
        approval === undefined ||
        decision === undefined ||
        approval.productRunId !== entry.productRunId ||
        decision.productRunId !== entry.productRunId ||
        decision.approvalRequestId !== approval.approvalRequestId
      ) {
        fail(`outbox ${entry.outboxId} workflow_resume绑定不完整`);
      }
      continue;
    }
    const intent = entities.memoryImportIntents[entry.memoryImportIntentId];
    const result = entities.memoryImportResults[entry.memoryImportResultId];
    if (
      intent === undefined ||
      result === undefined ||
      result.memoryImportIntentId !== intent.memoryImportIntentId ||
      entry.expectedResultRevision > result.revision
    ) {
      fail(`outbox ${entry.outboxId} Memory Import绑定不完整`);
    }
  }
}
