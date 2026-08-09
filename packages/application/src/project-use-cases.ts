import type {
  BeginProjectIntakePayload,
  AssignProjectActionPayload,
  CommandId,
  CreateProjectActionPayload,
  PrincipalId,
  Project,
  ProjectAction,
  ProjectCandidate,
  ProjectCandidateDecisionPayload,
  ProjectCandidateDto,
  ProjectContribution,
  ProjectDecision,
  ProjectEvidence,
  ProjectIntakeProposal,
  ProjectMethodSnapshot,
  ProjectObservation,
  ProjectParticipant,
  ProjectResource,
  ProjectRootDto,
  ProjectStage,
  ProjectSummaryDto,
  ProjectTimelineItemDto,
  ProjectWorkspaceDto,
  ProjectWork,
  RecordProjectContributionPayload,
  RecordProjectDecisionPayload,
  SetProjectArchiveStatusPayload,
  TransitionProjectActionPayload,
  TraceEventInput,
} from "@chat/contracts";
import {
  PROJECT_API_SCHEMA_VERSION,
  projectCandidateDtoSchema,
  projectSummaryDtoSchema,
  projectTimelineItemDtoSchema,
  projectWorkspaceDtoSchema,
} from "@chat/contracts";
import {
  compileProjectIntakeProposal,
  assertProjectActionTransition,
  computeProjectCandidateSha256,
  computeProjectMethodSnapshotSha256,
  computeProjectObservationSha256,
  hashCanonical,
} from "@chat/domain";
import type { ApplicationDeps, ProjectIdFactory } from "./deps.js";
import { ApplicationError, forbidden, notFound, revisionConflict } from "./errors.js";

type Snapshot = Awaited<ReturnType<ApplicationDeps["store"]["read"]>>["snapshot"];

function requireProjectRoots(deps: ApplicationDeps) {
  if (deps.projectRoots === undefined) {
    throw new ApplicationError({
      code: "internal_error",
      httpStatus: 503,
      message: "Project Resource Registry未配置",
      recoveryAction: "contact_support",
    });
  }
  return deps.projectRoots;
}

function requireProjectIds(deps: ApplicationDeps): ProjectIdFactory {
  if (deps.projectIds === undefined) {
    throw new ApplicationError({
      code: "internal_error",
      httpStatus: 500,
      message: "Project ID Factory未配置",
    });
  }
  return deps.projectIds;
}

function emitProjectTrace(deps: ApplicationDeps, event: TraceEventInput): void {
  try {
    deps.trace?.(event);
  } catch {
    // Trace故障不能把已经提交的Project事实改写成失败。
  }
}

function projectTraceId(id: string): string {
  return `tr_${id.slice(4)}`;
}

function projectSpanId(...parts: string[]): string {
  return `sp_${hashCanonical("project-trace-span.v1", parts).slice(0, 24)}`;
}

function assertProjectWritable(project: Project): void {
  if (project.status === "archived") throw revisionConflict("已归档Project不能普通写入");
}

function toCandidateDto(candidate: ProjectCandidate): ProjectCandidateDto {
  const base = {
    schemaVersion: PROJECT_API_SCHEMA_VERSION,
    projectCandidateId: candidate.projectCandidateId,
    sessionId: candidate.sessionId,
    rootId: candidate.rootId,
    revision: candidate.revision,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  } as const;
  if (candidate.status === "queued") {
    return projectCandidateDtoSchema.parse({ ...base, status: "queued", allowedActions: [] });
  }
  if (candidate.status === "under_review") {
    return projectCandidateDtoSchema.parse({
      ...base,
      status: candidate.status,
      proposal: candidate.proposal,
      resource: {
        displayName: candidate.resourceDisplayName,
        branch: candidate.observationData.git.branch,
        headSha: candidate.observationData.git.headSha,
        dirty: candidate.observationData.git.dirty,
        documentCount: candidate.observationData.documents.length,
        scriptCount: candidate.observationData.scripts.length,
      },
      candidateSha256: candidate.candidateSha256,
      allowedActions: ["revise", "confirm", "reject"],
    });
  }
  if (candidate.status === "confirmed") {
    return projectCandidateDtoSchema.parse({
      ...base,
      status: candidate.status,
      proposal: candidate.proposal,
      candidateSha256: candidate.candidateSha256,
      confirmedProjectId: candidate.confirmedProjectId,
      allowedActions: [],
    });
  }
  return projectCandidateDtoSchema.parse({
    ...base,
    status: candidate.status,
    ...(candidate.proposal !== undefined ? { proposal: candidate.proposal } : {}),
    ...(candidate.candidateSha256 !== undefined
      ? { candidateSha256: candidate.candidateSha256 }
      : {}),
    allowedActions: [],
  });
}

export async function listProjectRoots(
  deps: ApplicationDeps,
): Promise<{ roots: ProjectRootDto[] }> {
  return {
    roots: requireProjectRoots(deps)
      .list()
      .map((root) => ({
        schemaVersion: PROJECT_API_SCHEMA_VERSION,
        rootId: root.rootId,
        displayName: root.displayName,
        enabledAdapters: [...root.enabledAdapters],
      })),
  };
}

export async function beginProjectIntake(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly payload: BeginProjectIntakePayload;
  },
): Promise<{ candidate: ProjectCandidateDto }> {
  const descriptor = requireProjectRoots(deps)
    .list()
    .find((root) => root.rootId === input.payload.rootId);
  if (descriptor === undefined) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 400,
      message: "所选Project Root不存在",
    });
  }
  const now = deps.now();
  const messageId = deps.ids.message();
  const candidateId = requireProjectIds(deps).candidate();
  const outboxId = deps.ids.outbox();
  const requestSha256 = hashCanonical("command.begin-project-intake.v1", {
    principalId: input.principalId,
    payload: input.payload,
  });
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "BeginProjectIntake",
    requestSha256,
    traceContext: { productSessionId: input.payload.sessionId },
    mutate: (draft) => {
      const session = draft.entities.sessions[input.payload.sessionId];
      if (session === undefined) throw notFound("Session不存在");
      if (session.ownerPrincipalId !== input.principalId) throw forbidden("无权在该Session建项");
      if (session.status !== "active") throw revisionConflict("已归档Session不能建项");
      const active = Object.values(draft.entities.projectCandidates).some(
        (candidate) =>
          candidate.sessionId === session.sessionId &&
          (candidate.status === "queued" || candidate.status === "under_review"),
      );
      if (active) throw revisionConflict("当前Session已有未决定的建项方案");
      const sequence = session.lastMessageSequence + 1;
      draft.entities.messages[messageId] = {
        schemaVersion: "message.v1",
        messageId,
        sessionId: session.sessionId,
        sessionSequence: sequence,
        role: "user",
        content: { format: "markdown", text: input.payload.text },
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.entities.sessions[session.sessionId] = {
        ...session,
        lastMessageSequence: sequence,
        revision: session.revision + 1,
        updatedAt: now,
      };
      draft.entities.projectCandidates[candidateId] = {
        schemaVersion: "project-candidate.v1",
        projectCandidateId: candidateId,
        sessionId: session.sessionId,
        sourceMessageId: messageId,
        requestedByPrincipalId: input.principalId,
        rootId: input.payload.rootId,
        status: "queued",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.outbox[outboxId] = {
        schemaVersion: "outbox-entry.v1",
        outboxId,
        kind: "project_intake_start",
        status: "pending",
        projectCandidateId: candidateId,
        expectedCandidateRevision: 1,
        dispatchAttempts: 0,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      return { resultRefs: { projectCandidateId: candidateId, messageId } };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const candidate = snapshot.entities.projectCandidates[result.resultRefs.projectCandidateId ?? ""];
  if (candidate === undefined) throw notFound("建项方案不存在");
  if (!result.replayed) {
    emitProjectTrace(deps, {
      level: "info",
      eventName: "project.intake.started",
      outcome: "unknown",
      traceId: projectTraceId(candidate.projectCandidateId),
      spanId: projectSpanId(candidate.projectCandidateId, input.commandId),
      projectCandidateId: candidate.projectCandidateId,
      productSessionId: candidate.sessionId,
      commandId: input.commandId,
      candidateRevision: candidate.revision,
    });
  }
  return { candidate: toCandidateDto(candidate) };
}

/** Workflow耐久Step调用；模型理解和资源观察都发生在事务外。 */
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
  if (candidate.status !== "queued" || candidate.revision !== input.expectedRevision) {
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
        code:
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : "project.understanding_failed",
        type: "ProjectUnderstandingError",
      },
      durationMs: Math.round(performance.now() - startedAt),
    });
    throw error;
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
      if (current === undefined || current.status !== "queued")
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
  if (!result.replayed && published.status === "under_review") {
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
  if (!result.replayed && input.payload.kind === "confirm" && decided.status === "confirmed") {
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
  } else if (!result.replayed && input.payload.kind === "reject" && decided.status === "rejected") {
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
  candidate: Extract<ProjectCandidate, { status: "under_review" }>;
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
    schemaVersion: "project.v1",
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
  const method: ProjectMethodSnapshot = {
    schemaVersion: "project-method-snapshot.v1",
    projectMethodSnapshotId: ids.methodId,
    projectId: ids.projectId,
    ...proposal.method,
    sha256: computeProjectMethodSnapshotSha256(proposal.method) as never,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  const stage: ProjectStage = {
    schemaVersion: "project-stage.v1",
    projectStageId: ids.stageId,
    projectId: ids.projectId,
    ...proposal.initialStage,
    status: "active",
    sequence: 1,
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

function projectSummary(snapshot: Snapshot, project: Project): ProjectSummaryDto {
  const method = snapshot.entities.projectMethodSnapshots[project.methodSnapshotId];
  const stage = snapshot.entities.projectStages[project.currentStageId];
  if (method === undefined || stage === undefined) throw notFound("项目方法或阶段不存在");
  const works = Object.values(snapshot.entities.projectWorks).filter(
    (work) => work.projectId === project.projectId,
  );
  const actions = Object.values(snapshot.entities.projectActions).filter(
    (action) => action.projectId === project.projectId,
  );
  const participants = Object.values(snapshot.entities.projectParticipants).filter(
    (participant) => participant.projectId === project.projectId,
  );
  return projectSummaryDtoSchema.parse({
    schemaVersion: PROJECT_API_SCHEMA_VERSION,
    projectId: project.projectId,
    name: project.name,
    summary: project.summary,
    goal: project.goal,
    status: project.status,
    methodProfileId: method.profileId,
    stageName: stage.name,
    activeWorkCount: works.filter((work) => !["done", "cancelled"].includes(work.status)).length,
    openActionCount: actions.filter((action) => !["done", "cancelled"].includes(action.status))
      .length,
    participantCount: participants.filter((participant) => participant.status === "active").length,
    revision: project.revision,
    updatedAt: project.updatedAt,
  });
}

export async function listProjects(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId },
): Promise<{ projects: ProjectSummaryDto[] }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  return {
    projects: Object.values(snapshot.entities.projects)
      .filter((project) => project.ownerPrincipalId === input.principalId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((project) => projectSummary(snapshot, project)),
  };
}

function projectWorkspace(
  snapshot: Snapshot,
  projectId: string,
  principalId: PrincipalId,
): ProjectWorkspaceDto {
  const project = snapshot.entities.projects[projectId];
  if (project === undefined) throw notFound("Project不存在");
  if (project.ownerPrincipalId !== principalId) throw forbidden("无权查看该Project");
  const participants = Object.values(snapshot.entities.projectParticipants).filter(
    (item) => item.projectId === project.projectId,
  );
  const resources = Object.values(snapshot.entities.projectResources).filter(
    (item) => item.projectId === project.projectId,
  );
  const observations = Object.values(snapshot.entities.projectObservations).filter(
    (item) => item.projectId === project.projectId,
  );
  const actions = Object.values(snapshot.entities.projectActions).filter(
    (item) => item.projectId === project.projectId,
  );
  const works = Object.values(snapshot.entities.projectWorks).filter(
    (item) => item.projectId === project.projectId,
  );
  const decisions = Object.values(snapshot.entities.projectDecisions).filter(
    (item) => item.projectId === project.projectId,
  );
  const contributions = Object.values(snapshot.entities.projectContributions).filter(
    (item) => item.projectId === project.projectId,
  );
  return projectWorkspaceDtoSchema.parse({
    schemaVersion: PROJECT_API_SCHEMA_VERSION,
    project: projectSummary(snapshot, project),
    scopeIn: project.scopeIn,
    scopeOut: project.scopeOut,
    successCriteria: project.successCriteria,
    participants: participants.map((item) => ({
      projectParticipantId: item.projectParticipantId,
      kind: item.kind,
      displayName: item.displayName,
      role: item.role,
      status: item.status,
    })),
    resources: resources.map((item) => {
      const latest = observations
        .filter((observation) => observation.resourceId === item.projectResourceId)
        .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
      return {
        projectResourceId: item.projectResourceId,
        displayName: item.displayName,
        status: item.status,
        ...(latest !== undefined
          ? {
              latestObservationId: latest.projectObservationId,
              latestObservationAt: latest.observedAt,
            }
          : {}),
      };
    }),
    works: works.map((work) => ({
      projectWorkId: work.projectWorkId,
      title: work.title,
      objective: work.objective,
      acceptanceCriteria: work.acceptanceCriteria,
      ownerParticipantId: work.ownerParticipantId,
      status: work.status,
      revision: work.revision,
      actions: actions
        .filter((action) => action.workId === work.projectWorkId)
        .map((action) => ({
          projectActionId: action.projectActionId,
          workId: action.workId,
          title: action.title,
          ownerParticipantId: action.ownerParticipantId,
          status: action.status,
          ...(action.blockedReason !== undefined ? { blockedReason: action.blockedReason } : {}),
          ...(action.dueAt !== undefined ? { dueAt: action.dueAt } : {}),
          revision: action.revision,
        })),
    })),
    decisions: decisions
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((item) => ({
        projectDecisionId: item.projectDecisionId,
        question: item.question,
        choice: item.choice,
        rationale: item.rationale,
        decidedByParticipantId: item.decidedByParticipantId,
        status: item.status,
        createdAt: item.createdAt,
      })),
    contributions: contributions
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .map((item) => ({
        projectContributionId: item.projectContributionId,
        participantId: item.participantId,
        kind: item.kind,
        summary: item.summary,
        evidenceStatus: item.evidenceStatus,
        occurredAt: item.occurredAt,
      })),
  });
}

export async function getProjectWorkspace(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId; readonly projectId: string },
): Promise<{ project: ProjectWorkspaceDto }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  return { project: projectWorkspace(snapshot, input.projectId, input.principalId) };
}

export async function getProjectTimeline(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId; readonly projectId: string },
): Promise<{ items: ProjectTimelineItemDto[] }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const project = snapshot.entities.projects[input.projectId];
  if (project === undefined) throw notFound("Project不存在");
  if (project.ownerPrincipalId !== input.principalId) throw forbidden("无权查看该Project");
  const items: ProjectTimelineItemDto[] = [
    {
      id: project.projectId,
      kind: "project_created",
      title: "项目已建立",
      occurredAt: project.createdAt,
      objectRevision: 1,
    },
    ...Object.values(snapshot.entities.projectDecisions)
      .filter((item) => item.projectId === project.projectId)
      .map((item) => ({
        id: item.projectDecisionId,
        kind: "decision" as const,
        actorParticipantId: item.decidedByParticipantId,
        title: item.question,
        occurredAt: item.createdAt,
        objectRevision: item.revision,
      })),
    ...Object.values(snapshot.entities.projectContributions)
      .filter((item) => item.projectId === project.projectId)
      .map((item) => ({
        id: item.projectContributionId,
        kind: "contribution" as const,
        actorParticipantId: item.participantId,
        title: item.summary,
        occurredAt: item.occurredAt,
        objectRevision: item.revision,
      })),
    ...Object.values(snapshot.entities.projectObservations)
      .filter((item) => item.projectId === project.projectId)
      .map((item) => ({
        id: item.projectObservationId,
        kind: "resource_observation" as const,
        title: "资源观察已更新",
        occurredAt: item.observedAt,
        objectRevision: item.revision,
      })),
    ...Object.values(snapshot.entities.projectActions)
      .filter((item) => item.projectId === project.projectId)
      .map((item) => ({
        id: item.projectActionId,
        kind: "action" as const,
        actorParticipantId: item.ownerParticipantId,
        title: item.title,
        occurredAt: item.updatedAt,
        objectRevision: item.revision,
      })),
  ];
  return {
    items: items
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .map((item) => projectTimelineItemDtoSchema.parse(item)),
  };
}

export async function createProjectAction(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectId: string;
    readonly payload: CreateProjectActionPayload;
  },
): Promise<{ project: ProjectWorkspaceDto }> {
  const actionId = requireProjectIds(deps).action();
  const now = deps.now();
  const requestSha256 = hashCanonical("command.create-project-action.v1", input);
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "CreateProjectAction",
    requestSha256,
    mutate: (draft) => {
      const project = draft.entities.projects[input.projectId];
      if (project === undefined) throw notFound("Project不存在");
      if (project.ownerPrincipalId !== input.principalId) throw forbidden("无权修改Project");
      assertProjectWritable(project);
      const work = draft.entities.projectWorks[input.payload.workId];
      const owner = draft.entities.projectParticipants[input.payload.ownerParticipantId];
      if (
        work?.projectId !== project.projectId ||
        owner?.projectId !== project.projectId ||
        owner.status !== "active"
      ) {
        throw revisionConflict("Work或负责人不属于当前Project");
      }
      draft.entities.projectActions[actionId] = {
        schemaVersion: "project-action.v1",
        projectActionId: actionId,
        projectId: project.projectId,
        workId: work.projectWorkId,
        title: input.payload.title,
        ownerParticipantId: owner.projectParticipantId,
        status: "todo",
        ...(input.payload.dueAt !== undefined ? { dueAt: input.payload.dueAt } : {}),
        completedEvidenceIds: [],
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      return { resultRefs: { projectId: project.projectId, projectActionId: actionId } };
    },
  });
  if (!transaction.replayed) {
    emitProjectTrace(deps, {
      level: "info",
      eventName: "project.action.created",
      outcome: "success",
      traceId: projectTraceId(input.projectId),
      spanId: projectSpanId(input.projectId, input.commandId),
      projectId: input.projectId as never,
      projectActionId: actionId,
      projectWorkId: input.payload.workId,
      ownerParticipantId: input.payload.ownerParticipantId,
      actionRevision: 1,
      commandId: input.commandId,
    });
  }
  return getProjectWorkspace(deps, { principalId: input.principalId, projectId: input.projectId });
}

export async function transitionProjectAction(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly actionId: string;
    readonly expectedRevision: number;
    readonly payload: TransitionProjectActionPayload;
  },
): Promise<{ project: ProjectWorkspaceDto }> {
  const now = deps.now();
  const requestSha256 = hashCanonical("command.transition-project-action.v1", input);
  let priorStatus: ProjectAction["status"] | undefined;
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "TransitionProjectAction",
    requestSha256,
    mutate: (draft) => {
      const action = draft.entities.projectActions[input.actionId];
      if (action === undefined) throw notFound("Project Action不存在");
      const project = draft.entities.projects[action.projectId];
      if (project?.ownerPrincipalId !== input.principalId)
        throw forbidden("无权修改Project Action");
      assertProjectWritable(project);
      if (action.revision !== input.expectedRevision)
        throw revisionConflict("Project Action revision冲突");
      priorStatus = action.status;
      assertProjectActionTransition({
        from: action.status,
        to: input.payload.status,
        ...(input.payload.blockedReason !== undefined
          ? { blockedReason: input.payload.blockedReason }
          : {}),
      });
      draft.entities.projectActions[action.projectActionId] = {
        ...action,
        status: input.payload.status,
        ...(input.payload.status === "blocked"
          ? { blockedReason: input.payload.blockedReason }
          : { blockedReason: undefined }),
        revision: action.revision + 1,
        updatedAt: now,
      } as ProjectAction;
      return { resultRefs: { projectId: action.projectId } };
    },
  });
  if (!result.replayed && priorStatus !== undefined) {
    const after = await deps.store.read({ kind: "committedSnapshot" });
    const action = after.snapshot.entities.projectActions[input.actionId];
    if (action !== undefined) {
      emitProjectTrace(deps, {
        level: "info",
        eventName: "project.action.transitioned",
        outcome: "success",
        traceId: projectTraceId(action.projectId),
        spanId: projectSpanId(action.projectId, input.commandId),
        projectId: action.projectId,
        projectActionId: action.projectActionId,
        projectWorkId: action.workId,
        ownerParticipantId: action.ownerParticipantId,
        actionRevision: action.revision,
        fromStatus: priorStatus,
        toStatus: action.status,
        commandId: input.commandId,
      });
    }
  }
  return getProjectWorkspace(deps, {
    principalId: input.principalId,
    projectId: result.resultRefs.projectId ?? "",
  });
}

export async function assignProjectAction(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly actionId: string;
    readonly expectedRevision: number;
    readonly payload: AssignProjectActionPayload;
  },
): Promise<{ project: ProjectWorkspaceDto }> {
  const now = deps.now();
  const requestSha256 = hashCanonical("command.assign-project-action.v1", input);
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "AssignProjectAction",
    requestSha256,
    mutate: (draft) => {
      const action = draft.entities.projectActions[input.actionId];
      if (action === undefined) throw notFound("Project Action不存在");
      const project = draft.entities.projects[action.projectId];
      if (project?.ownerPrincipalId !== input.principalId)
        throw forbidden("无权分派Project Action");
      assertProjectWritable(project);
      if (action.revision !== input.expectedRevision)
        throw revisionConflict("Project Action revision冲突");
      const owner = draft.entities.projectParticipants[input.payload.ownerParticipantId];
      if (owner?.projectId !== project.projectId || owner.status !== "active") {
        throw revisionConflict("负责人不属于当前Project或已停用");
      }
      draft.entities.projectActions[action.projectActionId] = {
        ...action,
        ownerParticipantId: owner.projectParticipantId,
        revision: action.revision + 1,
        updatedAt: now,
      };
      return { resultRefs: { projectId: project.projectId } };
    },
  });
  if (!result.replayed) {
    const after = await deps.store.read({ kind: "committedSnapshot" });
    const action = after.snapshot.entities.projectActions[input.actionId];
    if (action !== undefined) {
      emitProjectTrace(deps, {
        level: "info",
        eventName: "project.action.assigned",
        outcome: "success",
        traceId: projectTraceId(action.projectId),
        spanId: projectSpanId(action.projectId, input.commandId),
        projectId: action.projectId,
        projectActionId: action.projectActionId,
        projectWorkId: action.workId,
        ownerParticipantId: action.ownerParticipantId,
        actionRevision: action.revision,
        commandId: input.commandId,
      });
    }
  }
  return getProjectWorkspace(deps, {
    principalId: input.principalId,
    projectId: result.resultRefs.projectId ?? "",
  });
}

export async function setProjectArchiveStatus(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectId: string;
    readonly expectedRevision: number;
    readonly payload: SetProjectArchiveStatusPayload;
  },
): Promise<{ project: ProjectWorkspaceDto }> {
  const now = deps.now();
  const requestSha256 = hashCanonical("command.set-project-archive-status.v1", input);
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "SetProjectArchiveStatus",
    requestSha256,
    mutate: (draft) => {
      const project = draft.entities.projects[input.projectId];
      if (project === undefined) throw notFound("Project不存在");
      if (project.ownerPrincipalId !== input.principalId) throw forbidden("无权归档Project");
      if (project.revision !== input.expectedRevision)
        throw revisionConflict("Project revision冲突");
      if (project.status === input.payload.status) throw revisionConflict("Project状态没有变化");
      draft.entities.projects[project.projectId] = {
        ...project,
        status: input.payload.status,
        revision: project.revision + 1,
        updatedAt: now,
      };
      return { resultRefs: { projectId: project.projectId } };
    },
  });
  return getProjectWorkspace(deps, { principalId: input.principalId, projectId: input.projectId });
}

export async function recordProjectDecision(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectId: string;
    readonly expectedRevision: number;
    readonly payload: RecordProjectDecisionPayload;
  },
): Promise<{ project: ProjectWorkspaceDto }> {
  const decisionId = requireProjectIds(deps).decision();
  const now = deps.now();
  const requestSha256 = hashCanonical("command.record-project-decision.v1", input);
  const transaction = await deps.store.transact({
    commandId: input.commandId,
    commandType: "RecordProjectDecision",
    requestSha256,
    mutate: (draft) => {
      const project = draft.entities.projects[input.projectId];
      if (project === undefined) throw notFound("Project不存在");
      if (project.ownerPrincipalId !== input.principalId)
        throw forbidden("无权记录Project Decision");
      assertProjectWritable(project);
      if (project.revision !== input.expectedRevision)
        throw revisionConflict("Project revision冲突");
      const participant = draft.entities.projectParticipants[input.payload.decidedByParticipantId];
      if (participant?.projectId !== project.projectId || participant.status !== "active")
        throw revisionConflict("决策者不属于当前Project");
      draft.entities.projectDecisions[decisionId] = {
        schemaVersion: "project-decision.v1",
        projectDecisionId: decisionId,
        projectId: project.projectId,
        ...input.payload,
        boundProjectRevision: project.revision,
        status: "active",
        commandId: input.commandId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      return { resultRefs: { projectId: project.projectId, projectDecisionId: decisionId } };
    },
  });
  if (!transaction.replayed) {
    emitProjectTrace(deps, {
      level: "info",
      eventName: "project.decision.committed",
      outcome: "success",
      traceId: projectTraceId(input.projectId),
      spanId: projectSpanId(input.projectId, input.commandId),
      projectId: input.projectId as never,
      projectDecisionId: decisionId,
      decidedByParticipantId: input.payload.decidedByParticipantId,
      boundProjectRevision: input.expectedRevision,
      decisionRevision: 1,
      commandId: input.commandId,
    });
  }
  return getProjectWorkspace(deps, { principalId: input.principalId, projectId: input.projectId });
}

export async function recordProjectContribution(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectId: string;
    readonly payload: RecordProjectContributionPayload;
  },
): Promise<{ project: ProjectWorkspaceDto }> {
  const contributionId = requireProjectIds(deps).contribution();
  const now = deps.now();
  const requestSha256 = hashCanonical("command.record-project-contribution.v1", input);
  const transaction = await deps.store.transact({
    commandId: input.commandId,
    commandType: "RecordProjectContribution",
    requestSha256,
    mutate: (draft) => {
      const project = draft.entities.projects[input.projectId];
      if (project === undefined) throw notFound("Project不存在");
      if (project.ownerPrincipalId !== input.principalId)
        throw forbidden("无权记录Project Contribution");
      assertProjectWritable(project);
      const participant = draft.entities.projectParticipants[input.payload.participantId];
      if (participant?.projectId !== project.projectId)
        throw revisionConflict("贡献者不属于当前Project");
      const evidence = input.payload.evidenceIds.map((id) => draft.entities.projectEvidence[id]);
      if (evidence.some((item) => item?.projectId !== project.projectId))
        throw revisionConflict("Evidence不属于当前Project");
      const contribution: ProjectContribution = {
        schemaVersion: "project-contribution.v1",
        projectContributionId: contributionId,
        projectId: project.projectId,
        ...input.payload,
        evidenceIds: input.payload.evidenceIds as never,
        evidenceStatus: input.payload.evidenceIds.length > 0 ? "verified" : "reported",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.entities.projectContributions[contributionId] = contribution;
      return {
        resultRefs: { projectId: project.projectId, projectContributionId: contributionId },
      };
    },
  });
  if (!transaction.replayed) {
    emitProjectTrace(deps, {
      level: "info",
      eventName: "project.contribution.committed",
      outcome: "success",
      traceId: projectTraceId(input.projectId),
      spanId: projectSpanId(input.projectId, input.commandId),
      projectId: input.projectId as never,
      projectContributionId: contributionId,
      participantId: input.payload.participantId,
      contributionRevision: 1,
      evidenceStatus: input.payload.evidenceIds.length > 0 ? "verified" : "reported",
      evidenceCount: input.payload.evidenceIds.length,
      commandId: input.commandId,
    });
  }
  return getProjectWorkspace(deps, { principalId: input.principalId, projectId: input.projectId });
}

export async function observeProjectResource(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectId: string;
    readonly resourceId: string;
  },
): Promise<{ project: ProjectWorkspaceDto }> {
  const before = await deps.store.read({ kind: "committedSnapshot" });
  const project = before.snapshot.entities.projects[input.projectId];
  const resource = before.snapshot.entities.projectResources[input.resourceId];
  if (project === undefined || resource?.projectId !== project.projectId)
    throw notFound("Project Resource不存在");
  if (project.ownerPrincipalId !== input.principalId) throw forbidden("无权观察Project Resource");
  assertProjectWritable(project);
  const startedAt = performance.now();
  emitProjectTrace(deps, {
    level: "info",
    eventName: "project.resource.observe.started",
    outcome: "unknown",
    traceId: projectTraceId(project.projectId),
    spanId: projectSpanId(project.projectId, input.commandId, "started"),
    projectId: project.projectId,
    projectResourceId: resource.projectResourceId,
    adapterCount: resource.enabledAdapters.length,
  });
  let observed;
  try {
    observed = await requireProjectRoots(deps).observe(resource.rootId);
  } catch (error) {
    emitProjectTrace(deps, {
      level: "warn",
      eventName: "project.resource.observe.failed",
      outcome: "failure",
      traceId: projectTraceId(project.projectId),
      spanId: projectSpanId(project.projectId, input.commandId, "failed"),
      projectId: project.projectId,
      projectResourceId: resource.projectResourceId,
      adapterCount: resource.enabledAdapters.length,
      error: {
        code:
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : "project.observe_failed",
        type: "ProjectResourceError",
      },
      durationMs: Math.round(performance.now() - startedAt),
    });
    throw error;
  }
  const projectIds = requireProjectIds(deps);
  const observationId = projectIds.observation();
  const evidenceId = projectIds.evidence();
  const now = deps.now();
  const observationSha256 = computeProjectObservationSha256(observed.data);
  const previous = Object.values(before.snapshot.entities.projectObservations)
    .filter((item) => item.resourceId === resource.projectResourceId)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
  const requestSha256 = hashCanonical("command.observe-project-resource.v1", {
    principalId: input.principalId,
    projectId: project.projectId,
    resourceId: resource.projectResourceId,
    resourceRevision: resource.revision,
    observationSha256,
  });
  const transaction = await deps.store.transact({
    commandId: input.commandId,
    commandType: "ObserveProjectResource",
    requestSha256,
    mutate: (draft) => {
      const current = draft.entities.projectResources[resource.projectResourceId];
      if (current?.revision !== resource.revision)
        throw revisionConflict("Project Resource revision冲突");
      draft.entities.projectObservations[observationId] = {
        schemaVersion: "project-observation.v1",
        projectObservationId: observationId,
        projectId: project.projectId,
        resourceId: resource.projectResourceId,
        ...(previous !== undefined ? { previousObservationId: previous.projectObservationId } : {}),
        adapterKinds: current.enabledAdapters,
        data: observed.data,
        sha256: observationSha256 as never,
        observedAt: now,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.entities.projectEvidence[evidenceId] = {
        schemaVersion: "project-evidence.v1",
        projectEvidenceId: evidenceId,
        projectId: project.projectId,
        resourceId: resource.projectResourceId,
        kind: "resource_observation",
        label: "资源观察刷新",
        revisionRef: observed.data.git.headSha,
        sha256: observationSha256 as never,
        observedAt: now,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      return { resultRefs: { projectId: project.projectId, projectObservationId: observationId } };
    },
  });
  if (!transaction.replayed) {
    emitProjectTrace(deps, {
      level: "info",
      eventName: "project.resource.observe.completed",
      outcome: "success",
      traceId: projectTraceId(project.projectId),
      spanId: projectSpanId(project.projectId, input.commandId, "completed"),
      projectId: project.projectId,
      projectResourceId: resource.projectResourceId,
      projectObservationId: observationId,
      observationSha256: observationSha256 as never,
      adapterCount: resource.enabledAdapters.length,
      durationMs: Math.round(performance.now() - startedAt),
    });
  }
  return getProjectWorkspace(deps, { principalId: input.principalId, projectId: input.projectId });
}
