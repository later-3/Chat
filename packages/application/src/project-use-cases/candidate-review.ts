import {
  type CommandId,
  type PrincipalId,
  type Project,
  type ProjectAction,
  type ProjectCandidate,
  type ProjectCandidateDecisionPayload,
  type ProjectCandidateDto,
  type ProjectDecision,
  type ProjectEvidence,
  type ProjectIntakeProposal,
  type ProjectMethodSnapshot,
  type ProjectObservation,
  type ProjectParticipant,
  type ProjectResource,
  type ProjectStage,
  type ProjectWorkspaceDto,
  type ProjectWork,
} from "@chat/contracts";
import {
  compileProjectIntakeProposal,
  compileProjectMethodSnapshotPolicies,
  computeProjectCandidateSha256,
  computeProjectMethodSnapshotSha256,
  computeProjectObservationSha256,
  hashCanonical,
} from "@chat/domain";
import { type ApplicationDeps, type ProjectIdFactory } from "../deps.js";
import { ApplicationError, forbidden, notFound, revisionConflict } from "../errors.js";
import {
  requireProjectRoots,
  requireProjectIds,
  emitProjectTrace,
  projectTraceId,
  projectSpanId,
  toCandidateDto,
  projectWorkspace,
} from "./shared.js";

export async function prepareProjectCandidateForReview(
  deps: ApplicationDeps,
  input: {
    readonly commandId: CommandId;
    readonly projectCandidateId: string;
    readonly expectedRevision: number;
  },
): Promise<{ candidate: ProjectCandidateDto }> {
  const understandingPort = deps.projectIntakeUnderstanding;
  if (understandingPort === undefined) {
    throw new ApplicationError({
      code: "internal_error",
      httpStatus: 503,
      message: "建项理解Adapter未配置",
    });
  }
  const startedAt = performance.now();
  const before = await deps.store.read({ kind: "committedSnapshot" });
  const candidate = before.snapshot.entities.projectCandidates[input.projectCandidateId];
  if (candidate === undefined) throw notFound("建项方案不存在");
  if (
    candidate.candidateKind !== "intake" ||
    candidate.status !== "queued" ||
    candidate.revision !== input.expectedRevision
  ) {
    throw revisionConflict("建项方案状态或revision已经变化");
  }
  const message = before.snapshot.entities.messages[candidate.sourceMessageId];
  if (message === undefined) throw notFound("建项来源消息不存在");
  const root = requireProjectRoots(deps)
    .list()
    .find((item) => item.rootId === candidate.rootId);
  if (root === undefined) throw notFound("Project Root不存在");
  const model = understandingPort.describe();
  const inputManifestSha256 = hashCanonical("project-understanding-input-manifest.v1", {
    sourceMessageId: message.messageId,
    sourceMessageSha256: hashCanonical("message-content.v1", message.content),
    rootId: candidate.rootId,
    resourceDisplayNameSha256: hashCanonical("project-resource-display.v1", root.displayName),
    promptTemplateVersion: model.promptTemplateVersion,
    modelProfileVersion: model.profileVersion,
  });
  emitProjectTrace(deps, {
    level: "info",
    eventName: "project.understanding.started",
    outcome: "unknown",
    traceId: projectTraceId(candidate.projectCandidateId),
    spanId: projectSpanId(candidate.projectCandidateId, input.commandId, "understanding"),
    projectCandidateId: candidate.projectCandidateId,
    candidateRevision: candidate.revision,
    providerName: model.providerName,
    modelId: model.modelId,
    endpointHost: model.endpointHost,
    promptTemplateVersion: model.promptTemplateVersion,
    modelProfileVersion: model.profileVersion,
    inputManifestSha256: inputManifestSha256 as never,
  });
  let understood;
  let observation;
  try {
    [understood, observation] = await Promise.all([
      understandingPort.understand({
        text: message.content.text,
        resourceDisplayName: root.displayName,
      }),
      requireProjectRoots(deps).observe(candidate.rootId),
    ]);
  } catch (error) {
    const failureCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/u.test(error.code)
        ? error.code
        : "project.understanding_failed";
    emitProjectTrace(deps, {
      level: "warn",
      eventName: "project.understanding.failed",
      outcome: "failure",
      traceId: projectTraceId(candidate.projectCandidateId),
      spanId: projectSpanId(candidate.projectCandidateId, input.commandId, "understanding-failed"),
      projectCandidateId: candidate.projectCandidateId,
      candidateRevision: candidate.revision,
      providerName: model.providerName,
      modelId: model.modelId,
      endpointHost: model.endpointHost,
      promptTemplateVersion: model.promptTemplateVersion,
      modelProfileVersion: model.profileVersion,
      inputManifestSha256: inputManifestSha256 as never,
      error: {
        code: failureCode,
        type: "ProjectUnderstandingError",
      },
      durationMs: Math.round(performance.now() - startedAt),
    });
    const failureSha256 = hashCanonical("command.fail-project-candidate.v1", {
      projectCandidateId: candidate.projectCandidateId,
      expectedRevision: input.expectedRevision,
      failureCode,
    });
    await deps.store.transact({
      commandId: input.commandId,
      commandType: "FailProjectCandidateForReview",
      requestSha256: failureSha256,
      mutate: (draft) => {
        const current = draft.entities.projectCandidates[candidate.projectCandidateId];
        if (current === undefined) throw notFound("建项方案不存在");
        if (current.candidateKind === "intake" && current.status === "failed") {
          return { resultRefs: { projectCandidateId: current.projectCandidateId } };
        }
        if (
          current.candidateKind !== "intake" ||
          current.status !== "queued" ||
          current.revision !== input.expectedRevision
        ) {
          throw revisionConflict("建项失败状态提交时Candidate已经变化");
        }
        draft.entities.projectCandidates[current.projectCandidateId] = {
          ...current,
          status: "failed",
          failureCode,
          failedByCommandId: input.commandId,
          revision: current.revision + 1,
          updatedAt: deps.now(),
        };
        return { resultRefs: { projectCandidateId: current.projectCandidateId } };
      },
    });
    const problemCode =
      failureCode === "provider.auth_failed"
        ? "provider_auth_failed"
        : failureCode === "provider.rate_limited"
          ? "provider_rate_limited"
          : failureCode === "provider.timeout"
            ? "provider_timeout"
            : failureCode === "provider.stream_interrupted"
              ? "provider_stream_interrupted"
              : failureCode === "model_candidate_invalid"
                ? "model_candidate_invalid"
                : "internal_error";
    throw new ApplicationError({
      code: problemCode,
      httpStatus: problemCode === "provider_auth_failed" ? 401 : 502,
      message: "Project理解节点失败，Candidate已记录失败状态",
      retryable: false,
      recoveryAction: problemCode === "provider_auth_failed" ? "reauthenticate" : "none",
    });
  }
  const understanding = understood.understanding;
  emitProjectTrace(deps, {
    level: "info",
    eventName: "project.understanding.completed",
    outcome: "success",
    traceId: projectTraceId(candidate.projectCandidateId),
    spanId: projectSpanId(candidate.projectCandidateId, input.commandId, "understanding-completed"),
    projectCandidateId: candidate.projectCandidateId,
    candidateRevision: candidate.revision,
    providerName: model.providerName,
    modelId: model.modelId,
    endpointHost: model.endpointHost,
    promptTemplateVersion: model.promptTemplateVersion,
    modelProfileVersion: model.profileVersion,
    inputManifestSha256: inputManifestSha256 as never,
    ...(understood.evidence.providerRequestId !== undefined
      ? { providerRequestId: understood.evidence.providerRequestId }
      : {}),
    ...(understood.evidence.tokenUsage !== undefined
      ? { tokenUsage: understood.evidence.tokenUsage }
      : {}),
    durationMs: understood.evidence.durationMs,
  });
  const proposal = compileProjectIntakeProposal({ understanding, observation: observation.data });
  const observationSha256 = computeProjectObservationSha256(observation.data);
  const candidateSha256 = computeProjectCandidateSha256({
    proposal,
    observationSha256,
    sourceMessageId: candidate.sourceMessageId,
    rootId: candidate.rootId,
    enabledAdapters: observation.descriptor.enabledAdapters,
  });
  const now = deps.now();
  const requestSha256 = hashCanonical("command.prepare-project-candidate.v1", {
    projectCandidateId: candidate.projectCandidateId,
    expectedRevision: input.expectedRevision,
    candidateSha256,
  });
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "PrepareProjectCandidateForReview",
    requestSha256,
    mutate: (draft) => {
      const current = draft.entities.projectCandidates[candidate.projectCandidateId];
      if (
        current === undefined ||
        current.candidateKind !== "intake" ||
        current.status !== "queued"
      )
        throw revisionConflict("建项方案已变化");
      if (current.revision !== input.expectedRevision)
        throw revisionConflict("建项方案revision冲突");
      draft.entities.projectCandidates[current.projectCandidateId] = {
        ...current,
        status: "under_review",
        understanding,
        proposal,
        resourceDisplayName: observation.descriptor.displayName,
        enabledAdapters: [...observation.descriptor.enabledAdapters],
        observationData: observation.data,
        observationSha256: observationSha256 as never,
        candidateSha256: candidateSha256 as never,
        revision: current.revision + 1,
        updatedAt: now,
      };
      return { resultRefs: { projectCandidateId: current.projectCandidateId } };
    },
  });
  const after = await deps.store.read({ kind: "committedSnapshot" });
  const published =
    after.snapshot.entities.projectCandidates[result.resultRefs.projectCandidateId ?? ""];
  if (published === undefined) throw notFound("建项方案不存在");
  if (
    !result.replayed &&
    published.candidateKind === "intake" &&
    published.status === "under_review"
  ) {
    emitProjectTrace(deps, {
      level: "info",
      eventName: "project.intake.candidate_published",
      outcome: "success",
      traceId: projectTraceId(published.projectCandidateId),
      spanId: projectSpanId(published.projectCandidateId, input.commandId),
      projectCandidateId: published.projectCandidateId,
      candidateRevision: published.revision,
      candidateSha256: published.candidateSha256,
      observationSha256: published.observationSha256,
      durationMs: Math.round(performance.now() - startedAt),
    });
  }
  return { candidate: toCandidateDto(published) };
}

export async function decideProjectCandidate(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectCandidateId: string;
    readonly expectedRevision: number;
    readonly payload: ProjectCandidateDecisionPayload;
  },
): Promise<{ candidate: ProjectCandidateDto; project?: ProjectWorkspaceDto }> {
  const now = deps.now();
  const projectIds = requireProjectIds(deps);
  const projectId = projectIds.project();
  const methodId = projectIds.methodSnapshot();
  const stageId = projectIds.stage();
  const resourceId = projectIds.resource();
  const participantId = projectIds.participant();
  const observationId = projectIds.observation();
  const evidenceId = projectIds.evidence();
  const decisionId = projectIds.decision();
  const outboxId = deps.ids.outbox();
  const workAndActions = Array.from({ length: 12 }, () => ({
    workId: projectIds.work(),
    actionId: projectIds.action(),
  }));
  const requestSha256 = hashCanonical("command.decide-project-candidate.v1", {
    principalId: input.principalId,
    projectCandidateId: input.projectCandidateId,
    expectedRevision: input.expectedRevision,
    payload: input.payload,
  });
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "DecideProjectCandidate",
    requestSha256,
    mutate: (draft) => {
      const current = draft.entities.projectCandidates[input.projectCandidateId];
      if (current === undefined) throw notFound("建项方案不存在");
      if (current.candidateKind !== "intake") throw revisionConflict("Candidate类型不是建项方案");
      if (current.requestedByPrincipalId !== input.principalId)
        throw forbidden("无权决定该建项方案");
      if (current.status !== "under_review") throw revisionConflict("建项方案当前不可决定");
      if (current.revision !== input.expectedRevision)
        throw revisionConflict("建项方案revision冲突");
      if (current.candidateSha256 !== input.payload.candidateSha256) {
        throw revisionConflict("建项方案Hash已变化");
      }
      if (input.payload.kind === "revise") {
        const candidateSha256 = computeProjectCandidateSha256({
          proposal: input.payload.proposal,
          observationSha256: current.observationSha256,
          sourceMessageId: current.sourceMessageId,
          rootId: current.rootId,
          enabledAdapters: current.enabledAdapters,
        });
        draft.entities.projectCandidates[current.projectCandidateId] = {
          ...current,
          proposal: input.payload.proposal,
          candidateSha256: candidateSha256 as never,
          revision: current.revision + 1,
          updatedAt: now,
        };
        return { resultRefs: { projectCandidateId: current.projectCandidateId } };
      }
      const nextCandidateRevision = current.revision + 1;
      if (input.payload.kind === "reject") {
        draft.entities.projectCandidates[current.projectCandidateId] = {
          ...current,
          status: "rejected",
          ...(input.payload.reason !== undefined ? { rejectionReason: input.payload.reason } : {}),
          decidedByCommandId: input.commandId,
          revision: nextCandidateRevision,
          updatedAt: now,
        };
        draft.outbox[outboxId] = projectResumeOutbox({
          outboxId,
          candidateId: current.projectCandidateId,
          candidateRevision: nextCandidateRevision,
          now,
        });
        return { resultRefs: { projectCandidateId: current.projectCandidateId } };
      }
      createProjectFacts({
        draft,
        now,
        commandId: input.commandId,
        candidate: current,
        proposal: current.proposal,
        ids: {
          projectId,
          methodId,
          stageId,
          resourceId,
          participantId,
          observationId,
          evidenceId,
          decisionId,
          workAndActions,
        },
      });
      draft.entities.projectCandidates[current.projectCandidateId] = {
        ...current,
        status: "confirmed",
        confirmedProjectId: projectId,
        decidedByCommandId: input.commandId,
        revision: nextCandidateRevision,
        updatedAt: now,
      };
      draft.outbox[outboxId] = projectResumeOutbox({
        outboxId,
        candidateId: current.projectCandidateId,
        candidateRevision: nextCandidateRevision,
        now,
      });
      return { resultRefs: { projectCandidateId: current.projectCandidateId, projectId } };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const decided = snapshot.entities.projectCandidates[result.resultRefs.projectCandidateId ?? ""];
  if (decided === undefined) throw notFound("建项方案不存在");
  const confirmedProjectId = result.resultRefs.projectId;
  if (
    !result.replayed &&
    input.payload.kind === "confirm" &&
    decided.candidateKind === "intake" &&
    decided.status === "confirmed"
  ) {
    emitProjectTrace(deps, {
      level: "info",
      eventName: "project.intake.confirmed",
      outcome: "success",
      traceId: projectTraceId(decided.projectCandidateId),
      spanId: projectSpanId(decided.projectCandidateId, input.commandId),
      projectCandidateId: decided.projectCandidateId,
      candidateRevision: decided.revision,
      candidateSha256: decided.candidateSha256,
      projectId: decided.confirmedProjectId,
      projectRevision: 1,
      commandId: input.commandId,
    });
  } else if (
    !result.replayed &&
    input.payload.kind === "reject" &&
    decided.candidateKind === "intake" &&
    decided.status === "rejected"
  ) {
    emitProjectTrace(deps, {
      level: "info",
      eventName: "project.intake.rejected",
      outcome: "rejected",
      traceId: projectTraceId(decided.projectCandidateId),
      spanId: projectSpanId(decided.projectCandidateId, input.commandId),
      projectCandidateId: decided.projectCandidateId,
      candidateRevision: decided.revision,
      candidateSha256: input.payload.candidateSha256,
      commandId: input.commandId,
    });
  }
  return {
    candidate: toCandidateDto(decided),
    ...(confirmedProjectId !== undefined
      ? { project: projectWorkspace(snapshot, confirmedProjectId, input.principalId) }
      : {}),
  };
}

function projectResumeOutbox(input: {
  outboxId: string;
  candidateId: string;
  candidateRevision: number;
  now: string;
}) {
  return {
    schemaVersion: "outbox-entry.v1" as const,
    outboxId: input.outboxId as never,
    kind: "project_intake_resume" as const,
    status: "pending" as const,
    projectCandidateId: input.candidateId as never,
    expectedCandidateRevision: input.candidateRevision,
    dispatchAttempts: 0,
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function createProjectFacts(input: {
  draft: Parameters<Parameters<ApplicationDeps["store"]["transact"]>[0]["mutate"]>[0];
  now: string;
  commandId: CommandId;
  candidate: Extract<ProjectCandidate, { candidateKind: "intake"; status: "under_review" }>;
  proposal: ProjectIntakeProposal;
  ids: {
    projectId: ReturnType<ProjectIdFactory["project"]>;
    methodId: ReturnType<ProjectIdFactory["methodSnapshot"]>;
    stageId: ReturnType<ProjectIdFactory["stage"]>;
    resourceId: ReturnType<ProjectIdFactory["resource"]>;
    participantId: ReturnType<ProjectIdFactory["participant"]>;
    observationId: ReturnType<ProjectIdFactory["observation"]>;
    evidenceId: ReturnType<ProjectIdFactory["evidence"]>;
    decisionId: ReturnType<ProjectIdFactory["decision"]>;
    workAndActions: readonly {
      workId: ReturnType<ProjectIdFactory["work"]>;
      actionId: ReturnType<ProjectIdFactory["action"]>;
    }[];
  };
}): void {
  const { draft, candidate, ids, now, proposal } = input;
  const project: Project = {
    schemaVersion: "project.v2",
    projectId: ids.projectId,
    ownerPrincipalId: candidate.requestedByPrincipalId,
    name: proposal.name,
    summary: proposal.summary,
    goal: proposal.goal,
    scopeIn: proposal.scopeIn,
    scopeOut: proposal.scopeOut,
    successCriteria: proposal.successCriteria,
    status: "active",
    methodSnapshotId: ids.methodId,
    currentStageId: ids.stageId,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  const methodPolicies = compileProjectMethodSnapshotPolicies(proposal.method.profileId);
  const method: ProjectMethodSnapshot = {
    schemaVersion: "project-method-snapshot.v2",
    projectMethodSnapshotId: ids.methodId,
    projectId: ids.projectId,
    profileId: proposal.method.profileId,
    rationale: proposal.method.rationale,
    policies: methodPolicies,
    source: "project_intake",
    sha256: computeProjectMethodSnapshotSha256({
      profileId: proposal.method.profileId,
      rationale: proposal.method.rationale,
      policies: methodPolicies,
      source: "project_intake",
    }) as never,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  const stage: ProjectStage = {
    schemaVersion: "project-stage.v2",
    projectStageId: ids.stageId,
    projectId: ids.projectId,
    methodSnapshotId: ids.methodId,
    key: "initial",
    name: proposal.initialStage.name,
    goal: proposal.initialStage.goal,
    successCriteria: proposal.successCriteria.slice(0, 20),
    status: "active",
    sequence: 1,
    startedAt: now,
    completionEvidenceIds: [],
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  const participant: ProjectParticipant = {
    schemaVersion: "project-participant.v1",
    projectParticipantId: ids.participantId,
    projectId: ids.projectId,
    kind: "human",
    principalId: candidate.requestedByPrincipalId,
    displayName: "项目所有者",
    role: "owner",
    status: "active",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  const resource: ProjectResource = {
    schemaVersion: "project-resource.v1",
    projectResourceId: ids.resourceId,
    projectId: ids.projectId,
    rootId: candidate.rootId,
    displayName: candidate.resourceDisplayName,
    kind: "workspace",
    enabledAdapters: candidate.enabledAdapters,
    status: "active",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  const observation: ProjectObservation = {
    schemaVersion: "project-observation.v1",
    projectObservationId: ids.observationId,
    projectId: ids.projectId,
    resourceId: ids.resourceId,
    adapterKinds: resource.enabledAdapters,
    data: candidate.observationData,
    sha256: candidate.observationSha256,
    observedAt: now,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  const evidence: ProjectEvidence = {
    schemaVersion: "project-evidence.v1",
    projectEvidenceId: ids.evidenceId,
    projectId: ids.projectId,
    resourceId: ids.resourceId,
    kind: "resource_observation",
    label: "建项资源观察",
    revisionRef: candidate.observationData.git.headSha,
    sha256: candidate.observationSha256,
    observedAt: now,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  const decision: ProjectDecision = {
    schemaVersion: "project-decision.v1",
    projectDecisionId: ids.decisionId,
    projectId: ids.projectId,
    question: "是否按已审核方案建立项目？",
    options: ["建立", "不建立"],
    choice: "建立",
    rationale: proposal.method.rationale,
    decidedByParticipantId: ids.participantId,
    boundProjectRevision: 1,
    status: "active",
    commandId: input.commandId,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  draft.entities.projects[ids.projectId] = project;
  draft.entities.projectMethodSnapshots[ids.methodId] = method;
  draft.entities.projectStages[ids.stageId] = stage;
  draft.entities.projectParticipants[ids.participantId] = participant;
  draft.entities.projectResources[ids.resourceId] = resource;
  draft.entities.projectObservations[ids.observationId] = observation;
  draft.entities.projectEvidence[ids.evidenceId] = evidence;
  draft.entities.projectDecisions[ids.decisionId] = decision;
  for (const [index, workProposal] of proposal.initialWork.entries()) {
    const allocated = ids.workAndActions[index];
    if (allocated === undefined) throw new Error("Project Work ID分配不足");
    const work: ProjectWork = {
      schemaVersion: "project-work.v1",
      projectWorkId: allocated.workId,
      projectId: ids.projectId,
      stageId: ids.stageId,
      title: workProposal.title,
      objective: workProposal.objective,
      acceptanceCriteria: workProposal.acceptanceCriteria,
      dependsOn: [],
      ownerParticipantId: ids.participantId,
      status: "approved",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    const action: ProjectAction = {
      schemaVersion: "project-action.v1",
      projectActionId: allocated.actionId,
      projectId: ids.projectId,
      workId: allocated.workId,
      title: workProposal.firstAction,
      ownerParticipantId: ids.participantId,
      status: "todo",
      completedEvidenceIds: [],
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    draft.entities.projectWorks[work.projectWorkId] = work;
    draft.entities.projectActions[action.projectActionId] = action;
  }
}

export async function getProjectCandidate(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId; readonly projectCandidateId: string },
): Promise<{ candidate: ProjectCandidateDto }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const candidate = snapshot.entities.projectCandidates[input.projectCandidateId];
  if (candidate === undefined) throw notFound("建项方案不存在");
  if (candidate.requestedByPrincipalId !== input.principalId) throw forbidden("无权查看该建项方案");
  return { candidate: toCandidateDto(candidate) };
}

/** 浏览器定位只是缓存；服务端按Session恢复唯一未决建项Candidate。 */
export async function getCurrentProjectCandidate(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId; readonly sessionId: string },
): Promise<{ candidate: ProjectCandidateDto | null }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const session = snapshot.entities.sessions[input.sessionId];
  if (session === undefined) throw notFound("Session不存在");
  if (session.ownerPrincipalId !== input.principalId) throw forbidden("无权查看该Session");
  const candidate = Object.values(snapshot.entities.projectCandidates)
    .filter(
      (item) =>
        item.sessionId === session.sessionId &&
        (item.status === "queued" || item.status === "under_review"),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return { candidate: candidate === undefined ? null : toCandidateDto(candidate) };
}
