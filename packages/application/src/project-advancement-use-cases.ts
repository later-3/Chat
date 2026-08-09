import type {
  BeginProjectAdvancementPayload,
  CommandId,
  PrincipalId,
  Project,
  ProjectAdvancementCandidateDecisionPayload,
  ProjectAdvancementProposal,
  ProjectCandidate,
  ProjectCandidateDto,
  ProjectDecision,
  ProjectMilestone,
  ProjectUpdate,
  TransitionProjectStagePayload,
  TransitionProjectMilestonePayload,
  ProjectStateTransition,
  TraceEventInput,
} from "@chat/contracts";
import { PROJECT_API_SCHEMA_VERSION, projectCandidateDtoSchema } from "@chat/contracts";
import {
  computeProjectAdvancementCandidateSha256,
  assertProjectStageTransition,
  assertProjectMilestoneTransition,
  hashCanonical,
} from "@chat/domain";
import type { ApplicationDeps, ProjectIdFactory } from "./deps.js";
import { ApplicationError, forbidden, notFound, revisionConflict } from "./errors.js";
import { getProjectWorkspace } from "./project-use-cases.js";

type AdvancementCandidate = Extract<ProjectCandidate, { candidateKind: "advancement" }>;

function emitProjectTrace(deps: ApplicationDeps, event: TraceEventInput): void {
  try {
    deps.trace?.(event);
  } catch {
    // Trace是旁路证据：写入故障不能把已经提交的产品事实改写成失败。
  }
}

function projectTraceId(id: string): string {
  return `tr_${id.slice(4)}`;
}

function projectSpanId(...parts: string[]): string {
  return `sp_${hashCanonical("project-advancement-trace-span.v1", parts).slice(0, 24)}`;
}

function requireIds(deps: ApplicationDeps): ProjectIdFactory {
  if (deps.projectIds === undefined) {
    throw new ApplicationError({
      code: "internal_error",
      httpStatus: 500,
      message: "Project ID Factory未配置",
    });
  }
  return deps.projectIds;
}

function toDto(candidate: AdvancementCandidate): ProjectCandidateDto {
  const base = {
    schemaVersion: PROJECT_API_SCHEMA_VERSION,
    projectCandidateId: candidate.projectCandidateId,
    sessionId: candidate.sessionId,
    candidateKind: "advancement" as const,
    projectId: candidate.projectId,
    boundProjectRevision: candidate.boundProjectRevision,
    boundStageId: candidate.boundStageId,
    boundStageRevision: candidate.boundStageRevision,
    revision: candidate.revision,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  };
  if (candidate.status === "queued") {
    return projectCandidateDtoSchema.parse({ ...base, status: "queued", allowedActions: [] });
  }
  if (candidate.status === "failed") {
    return projectCandidateDtoSchema.parse({
      ...base,
      status: "failed",
      failureCode: candidate.failureCode,
      allowedActions: [],
    });
  }
  if (candidate.status === "under_review") {
    return projectCandidateDtoSchema.parse({
      ...base,
      status: "under_review",
      proposal: candidate.proposal,
      candidateSha256: candidate.candidateSha256,
      allowedActions: ["revise", "confirm", "reject"],
    });
  }
  if (candidate.status === "confirmed") {
    return projectCandidateDtoSchema.parse({
      ...base,
      status: "confirmed",
      proposal: candidate.proposal,
      candidateSha256: candidate.candidateSha256,
      committedStageId: candidate.committedStageId,
      committedMilestoneIds: candidate.committedMilestoneIds,
      committedUpdateId: candidate.committedUpdateId,
      allowedActions: [],
    });
  }
  return projectCandidateDtoSchema.parse({ ...base, status: "rejected", allowedActions: [] });
}

/** 推进消息与Queued Candidate/Start Outbox同事务提交，HTTP请求不直接调用模型。 */
export async function beginProjectAdvancement(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly payload: BeginProjectAdvancementPayload;
  },
): Promise<{ candidate: ProjectCandidateDto }> {
  const ids = requireIds(deps);
  const messageId = deps.ids.message();
  const candidateId = ids.candidate();
  const outboxId = deps.ids.outbox();
  const now = deps.now();
  const requestSha256 = hashCanonical("command.begin-project-advancement.v1", input);
  const tx = await deps.store.transact({
    commandId: input.commandId,
    commandType: "BeginProjectAdvancement",
    requestSha256,
    traceContext: { productSessionId: input.payload.sessionId },
    mutate: (draft) => {
      const session = draft.entities.sessions[input.payload.sessionId];
      const project = draft.entities.projects[input.payload.projectId];
      if (session === undefined || project === undefined) throw notFound("Session或Project不存在");
      if (
        session.ownerPrincipalId !== input.principalId ||
        project.ownerPrincipalId !== input.principalId
      ) {
        throw forbidden("无权推进该Project");
      }
      if (project.status !== "active") throw revisionConflict("只有active Project可以普通推进");
      const stage = draft.entities.projectStages[project.currentStageId];
      const method = draft.entities.projectMethodSnapshots[project.methodSnapshotId];
      if (stage === undefined || method === undefined)
        throw revisionConflict("Project阶段或方法缺失");
      if (
        Object.values(draft.entities.projectCandidates).some(
          (candidate) =>
            candidate.sessionId === session.sessionId &&
            (candidate.status === "queued" || candidate.status === "under_review"),
        )
      ) {
        throw revisionConflict("当前Session已有未决定的Project Candidate");
      }
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
        candidateKind: "advancement",
        projectId: project.projectId,
        boundProjectRevision: project.revision,
        boundStageId: stage.projectStageId,
        boundStageRevision: stage.revision,
        boundMethodSnapshotId: method.projectMethodSnapshotId,
        boundMethodSha256: method.sha256,
        status: "queued",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.outbox[outboxId] = {
        schemaVersion: "outbox-entry.v1",
        outboxId,
        kind: "project_advancement_start",
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
  const candidate = snapshot.entities.projectCandidates[tx.resultRefs.projectCandidateId ?? ""];
  if (candidate === undefined || candidate.candidateKind !== "advancement") {
    throw notFound("Project推进Candidate不存在");
  }
  if (!tx.replayed) {
    emitProjectTrace(deps, {
      level: "info",
      eventName: "project.advancement.started",
      outcome: "unknown",
      traceId: projectTraceId(candidate.projectCandidateId),
      spanId: projectSpanId(candidate.projectCandidateId, input.commandId),
      projectCandidateId: candidate.projectCandidateId,
      projectId: candidate.projectId,
      projectStageId: candidate.boundStageId,
      boundProjectRevision: candidate.boundProjectRevision,
      boundStageRevision: candidate.boundStageRevision,
      commandId: input.commandId,
      candidateRevision: candidate.revision,
    });
  }
  return { candidate: toDto(candidate) };
}

/** Workflow Step调用；模型发生在产品事务外，结果只作为Candidate编译输入。 */
export async function prepareProjectAdvancementCandidate(
  deps: ApplicationDeps,
  input: {
    readonly commandId: CommandId;
    readonly projectCandidateId: string;
    readonly expectedRevision: number;
  },
): Promise<{ candidate: ProjectCandidateDto }> {
  const port = deps.projectAdvancementUnderstanding;
  if (port === undefined) {
    throw new ApplicationError({
      code: "internal_error",
      httpStatus: 503,
      message: "Project推进理解Adapter未配置",
    });
  }
  const before = await deps.store.read({ kind: "committedSnapshot" });
  const candidate = before.snapshot.entities.projectCandidates[input.projectCandidateId];
  if (
    candidate === undefined ||
    candidate.candidateKind !== "advancement" ||
    candidate.status !== "queued" ||
    candidate.revision !== input.expectedRevision
  ) {
    throw revisionConflict("Project推进Candidate状态或revision已变化");
  }
  const project = before.snapshot.entities.projects[candidate.projectId];
  const stage = before.snapshot.entities.projectStages[candidate.boundStageId];
  const message = before.snapshot.entities.messages[candidate.sourceMessageId];
  if (project === undefined || stage === undefined || message === undefined) {
    throw notFound("Project推进上下文不完整");
  }
  const startedAt = performance.now();
  const model = port.describe();
  const inputManifestSha256 = hashCanonical("project-advancement-input-manifest.v1", {
    sourceMessageId: message.messageId,
    sourceMessageSha256: hashCanonical("message-content.v1", message.content),
    projectId: project.projectId,
    projectRevision: project.revision,
    stageId: stage.projectStageId,
    stageRevision: stage.revision,
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
  let result;
  try {
    result = await port.understand({
      text: message.content.text,
      projectName: project.name,
      currentStage: {
        name: stage.name,
        goal: stage.goal,
        successCriteria: stage.successCriteria,
      },
    });
  } catch (error) {
    const failureCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/u.test(error.code)
        ? error.code
        : "project.advancement_understanding_failed";
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
      error: { code: failureCode, type: "ProjectAdvancementUnderstandingError" },
      durationMs: Math.round(performance.now() - startedAt),
    });
    await deps.store.transact({
      commandId: input.commandId,
      commandType: "FailProjectAdvancementCandidate",
      requestSha256: hashCanonical("command.fail-project-advancement.v1", {
        projectCandidateId: candidate.projectCandidateId,
        expectedRevision: input.expectedRevision,
        failureCode,
      }),
      mutate: (draft) => {
        const current = draft.entities.projectCandidates[candidate.projectCandidateId];
        if (
          current === undefined ||
          current.candidateKind !== "advancement" ||
          current.status !== "queued" ||
          current.revision !== input.expectedRevision
        ) {
          throw revisionConflict("提交推进失败状态时Candidate已经变化");
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
      message: "Project推进理解失败，Candidate已记录失败状态",
      retryable: false,
      recoveryAction: problemCode === "provider_auth_failed" ? "reauthenticate" : "none",
    });
  }
  const owner = Object.values(before.snapshot.entities.projectParticipants).find(
    (participant) =>
      participant.projectId === project.projectId &&
      participant.kind === "human" &&
      participant.principalId === candidate.requestedByPrincipalId &&
      participant.status === "active",
  );
  if (owner === undefined) throw revisionConflict("Project没有可发布Update的所有者Participant");
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
    ...(result.evidence.providerRequestId !== undefined
      ? { providerRequestId: result.evidence.providerRequestId }
      : {}),
    ...(result.evidence.tokenUsage !== undefined ? { tokenUsage: result.evidence.tokenUsage } : {}),
    durationMs: result.evidence.durationMs,
  });
  const proposal: ProjectAdvancementProposal = {
    stage: result.understanding.stage,
    milestones: result.understanding.milestones,
    update: {
      authorParticipantId: owner.projectParticipantId,
      ...result.understanding.update,
      evidenceIds: [],
    },
  };
  const candidateSha256 = computeProjectAdvancementCandidateSha256({
    projectId: candidate.projectId,
    boundProjectRevision: candidate.boundProjectRevision,
    boundStageId: candidate.boundStageId,
    boundStageRevision: candidate.boundStageRevision,
    boundMethodSnapshotId: candidate.boundMethodSnapshotId,
    boundMethodSha256: candidate.boundMethodSha256,
    sourceMessageId: candidate.sourceMessageId,
    proposal,
  });
  const tx = await deps.store.transact({
    commandId: input.commandId,
    commandType: "PrepareProjectAdvancementCandidate",
    requestSha256: hashCanonical("command.prepare-project-advancement.v1", {
      projectCandidateId: candidate.projectCandidateId,
      expectedRevision: input.expectedRevision,
      candidateSha256,
    }),
    mutate: (draft) => {
      const current = draft.entities.projectCandidates[candidate.projectCandidateId];
      if (
        current === undefined ||
        current.candidateKind !== "advancement" ||
        current.status !== "queued" ||
        current.revision !== input.expectedRevision
      ) {
        throw revisionConflict("发布推进Candidate时状态已变化");
      }
      draft.entities.projectCandidates[current.projectCandidateId] = {
        ...current,
        status: "under_review",
        understanding: result.understanding,
        proposal,
        candidateSha256: candidateSha256 as never,
        revision: current.revision + 1,
        updatedAt: deps.now(),
      };
      return { resultRefs: { projectCandidateId: current.projectCandidateId } };
    },
  });
  const after = await deps.store.read({ kind: "committedSnapshot" });
  const published =
    after.snapshot.entities.projectCandidates[tx.resultRefs.projectCandidateId ?? ""];
  if (published === undefined || published.candidateKind !== "advancement") {
    throw notFound("Project推进Candidate不存在");
  }
  if (published.status === "under_review" && !tx.replayed) {
    emitProjectTrace(deps, {
      level: "info",
      eventName: "project.advancement.candidate_published",
      outcome: "success",
      traceId: projectTraceId(published.projectCandidateId),
      spanId: projectSpanId(published.projectCandidateId, input.commandId, "published"),
      projectCandidateId: published.projectCandidateId,
      projectId: published.projectId,
      projectStageId: published.boundStageId,
      candidateRevision: published.revision,
      candidateSha256: published.candidateSha256,
      durationMs: Math.round(performance.now() - startedAt),
    });
  }
  return { candidate: toDto(published) };
}

function advancementResumeOutbox(input: {
  readonly outboxId: ReturnType<ApplicationDeps["ids"]["outbox"]>;
  readonly candidateId: AdvancementCandidate["projectCandidateId"];
  readonly candidateRevision: number;
  readonly now: string;
}) {
  return {
    schemaVersion: "outbox-entry.v1" as const,
    outboxId: input.outboxId,
    kind: "project_advancement_resume" as const,
    status: "pending" as const,
    projectCandidateId: input.candidateId,
    expectedCandidateRevision: input.candidateRevision,
    dispatchAttempts: 0,
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function assertProposalReferences(
  snapshot: Awaited<ReturnType<ApplicationDeps["store"]["read"]>>["snapshot"],
  project: Project,
  proposal: ProjectAdvancementProposal,
): void {
  const author = snapshot.entities.projectParticipants[proposal.update.authorParticipantId];
  if (
    author?.projectId !== project.projectId ||
    author.kind !== "human" ||
    author.principalId !== project.ownerPrincipalId ||
    author.status !== "active"
  ) {
    throw forbidden("Project Update作者不是当前Project所有者");
  }
  if (
    proposal.update.evidenceIds.some(
      (id) => snapshot.entities.projectEvidence[id]?.projectId !== project.projectId,
    )
  ) {
    throw revisionConflict("Project Update引用了其他Project或不存在的Evidence");
  }
}

/** 确认时一次提交Stage内容、Milestone、Decision、Update和Resume Outbox。 */
export async function decideProjectAdvancementCandidate(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectCandidateId: string;
    readonly expectedRevision: number;
    readonly payload: ProjectAdvancementCandidateDecisionPayload;
  },
): Promise<{
  candidate: ProjectCandidateDto;
  project: Awaited<ReturnType<typeof getProjectWorkspace>>["project"];
}> {
  const ids = requireIds(deps);
  const milestoneIds = Array.from({ length: 8 }, () => ids.milestone());
  const updateId = ids.update();
  const decisionId = ids.decision();
  const outboxId = deps.ids.outbox();
  const now = deps.now();
  const tx = await deps.store.transact({
    commandId: input.commandId,
    commandType: "DecideProjectAdvancementCandidate",
    requestSha256: hashCanonical("command.decide-project-advancement.v1", input),
    mutate: (draft) => {
      const candidate = draft.entities.projectCandidates[input.projectCandidateId];
      if (
        candidate === undefined ||
        candidate.candidateKind !== "advancement" ||
        candidate.status !== "under_review"
      ) {
        throw revisionConflict("Project推进Candidate当前不可决定");
      }
      if (candidate.requestedByPrincipalId !== input.principalId)
        throw forbidden("无权决定Candidate");
      if (candidate.revision !== input.expectedRevision)
        throw revisionConflict("Candidate revision冲突");
      if (candidate.candidateSha256 !== input.payload.candidateSha256) {
        throw revisionConflict("Candidate Hash已变化");
      }
      const project = draft.entities.projects[candidate.projectId];
      const stage = draft.entities.projectStages[candidate.boundStageId];
      const method = draft.entities.projectMethodSnapshots[candidate.boundMethodSnapshotId];
      if (project === undefined || stage === undefined || method === undefined) {
        throw notFound("Project推进绑定对象不存在");
      }
      const nextCandidateRevision = candidate.revision + 1;
      if (input.payload.kind === "reject") {
        draft.entities.projectCandidates[candidate.projectCandidateId] = {
          ...candidate,
          status: "rejected",
          ...(input.payload.reason !== undefined ? { rejectionReason: input.payload.reason } : {}),
          decidedByCommandId: input.commandId,
          revision: nextCandidateRevision,
          updatedAt: now,
        };
        draft.outbox[outboxId] = advancementResumeOutbox({
          outboxId,
          candidateId: candidate.projectCandidateId,
          candidateRevision: nextCandidateRevision,
          now,
        });
        return {
          resultRefs: {
            projectCandidateId: candidate.projectCandidateId,
            projectId: project.projectId,
          },
        };
      }
      if (
        project.revision !== candidate.boundProjectRevision ||
        stage.revision !== candidate.boundStageRevision ||
        method.sha256 !== candidate.boundMethodSha256 ||
        project.currentStageId !== stage.projectStageId ||
        project.methodSnapshotId !== method.projectMethodSnapshotId
      ) {
        throw revisionConflict("Project、Stage或Method版本已变化");
      }
      if (input.payload.kind === "revise") {
        assertProposalReferences(draft, project, input.payload.proposal);
        const candidateSha256 = computeProjectAdvancementCandidateSha256({
          projectId: candidate.projectId,
          boundProjectRevision: candidate.boundProjectRevision,
          boundStageId: candidate.boundStageId,
          boundStageRevision: candidate.boundStageRevision,
          boundMethodSnapshotId: candidate.boundMethodSnapshotId,
          boundMethodSha256: candidate.boundMethodSha256,
          sourceMessageId: candidate.sourceMessageId,
          proposal: input.payload.proposal,
        });
        draft.entities.projectCandidates[candidate.projectCandidateId] = {
          ...candidate,
          proposal: input.payload.proposal,
          candidateSha256: candidateSha256 as never,
          revision: nextCandidateRevision,
          updatedAt: now,
        };
        return {
          resultRefs: {
            projectCandidateId: candidate.projectCandidateId,
            projectId: project.projectId,
          },
        };
      }
      assertProposalReferences(draft, project, candidate.proposal);
      const decision: ProjectDecision = {
        schemaVersion: "project-decision.v1",
        projectDecisionId: decisionId,
        projectId: project.projectId,
        question: "是否采用本次Stage、Milestone与Project Update方案？",
        options: ["采用", "拒绝"],
        choice: "采用",
        rationale: "用户确认版本绑定的Project Advancement Candidate。",
        decidedByParticipantId: candidate.proposal.update.authorParticipantId,
        boundProjectRevision: project.revision,
        status: "active",
        commandId: input.commandId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.entities.projectDecisions[decisionId] = decision;
      draft.entities.projectStages[stage.projectStageId] = {
        ...stage,
        name: candidate.proposal.stage.name,
        goal: candidate.proposal.stage.goal,
        successCriteria: candidate.proposal.stage.successCriteria,
        revision: stage.revision + 1,
        updatedAt: now,
      };
      const committedMilestoneIds: ProjectMilestone["projectMilestoneId"][] = [];
      for (const [index, proposal] of candidate.proposal.milestones.entries()) {
        const projectMilestoneId = milestoneIds[index];
        if (projectMilestoneId === undefined) throw new Error("Milestone ID分配不足");
        const milestone: ProjectMilestone = {
          schemaVersion: "project-milestone.v1",
          projectMilestoneId,
          projectId: project.projectId,
          stageId: stage.projectStageId,
          outcome: proposal.outcome,
          acceptanceCriteria: proposal.acceptanceCriteria,
          ...(proposal.targetAt !== undefined ? { targetAt: proposal.targetAt } : {}),
          status: "planned",
          evidenceIds: [],
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        draft.entities.projectMilestones[projectMilestoneId] = milestone;
        committedMilestoneIds.push(projectMilestoneId);
      }
      const update: ProjectUpdate = {
        schemaVersion: "project-update.v1",
        projectUpdateId: updateId,
        projectId: project.projectId,
        stageId: stage.projectStageId,
        authorParticipantId: candidate.proposal.update.authorParticipantId,
        confirmedByPrincipalId: input.principalId,
        health: candidate.proposal.update.health,
        narrative: candidate.proposal.update.narrative,
        observedChanges: candidate.proposal.update.observedChanges,
        blockers: candidate.proposal.update.blockers,
        nextFocus: candidate.proposal.update.nextFocus,
        evidenceIds: candidate.proposal.update.evidenceIds,
        boundProjectRevision: project.revision + 1,
        boundStageRevision: stage.revision + 1,
        publishedAt: now,
        commandId: input.commandId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.entities.projectUpdates[updateId] = update;
      draft.entities.projects[project.projectId] = {
        ...project,
        revision: project.revision + 1,
        updatedAt: now,
      };
      draft.entities.projectCandidates[candidate.projectCandidateId] = {
        ...candidate,
        status: "confirmed",
        committedStageId: stage.projectStageId,
        committedMilestoneIds,
        committedUpdateId: updateId,
        decidedByCommandId: input.commandId,
        revision: nextCandidateRevision,
        updatedAt: now,
      };
      draft.outbox[outboxId] = advancementResumeOutbox({
        outboxId,
        candidateId: candidate.projectCandidateId,
        candidateRevision: nextCandidateRevision,
        now,
      });
      return {
        resultRefs: {
          projectCandidateId: candidate.projectCandidateId,
          projectId: project.projectId,
        },
      };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const candidate = snapshot.entities.projectCandidates[tx.resultRefs.projectCandidateId ?? ""];
  if (candidate === undefined || candidate.candidateKind !== "advancement") {
    throw notFound("Project推进Candidate不存在");
  }
  const workspace = await getProjectWorkspace(deps, {
    principalId: input.principalId,
    projectId: candidate.projectId,
  });
  if (!tx.replayed && candidate.status === "confirmed") {
    const stage = snapshot.entities.projectStages[candidate.committedStageId];
    const update = snapshot.entities.projectUpdates[candidate.committedUpdateId];
    const project = snapshot.entities.projects[candidate.projectId];
    if (stage !== undefined && update !== undefined && project !== undefined) {
      emitProjectTrace(deps, {
        level: "info",
        eventName: "project.advancement.confirmed",
        outcome: "success",
        traceId: projectTraceId(candidate.projectCandidateId),
        spanId: projectSpanId(candidate.projectCandidateId, input.commandId, "confirmed"),
        projectCandidateId: candidate.projectCandidateId,
        projectId: candidate.projectId,
        projectStageId: stage.projectStageId,
        projectUpdateId: update.projectUpdateId,
        candidateRevision: candidate.revision,
        candidateSha256: candidate.candidateSha256,
        projectRevision: project.revision,
        stageRevision: stage.revision,
        milestoneCount: candidate.committedMilestoneIds.length,
        commandId: input.commandId,
      });
      emitProjectTrace(deps, {
        level: "info",
        eventName: "project.update.published",
        outcome: "success",
        traceId: projectTraceId(candidate.projectId),
        spanId: projectSpanId(update.projectUpdateId, input.commandId),
        projectId: candidate.projectId,
        projectStageId: stage.projectStageId,
        projectUpdateId: update.projectUpdateId,
        projectRevision: update.boundProjectRevision,
        stageRevision: update.boundStageRevision,
        updateRevision: update.revision,
        evidenceCount: update.evidenceIds.length,
        commandId: input.commandId,
      });
    }
  } else if (!tx.replayed && candidate.status === "rejected") {
    if (candidate.candidateSha256 === undefined) {
      throw revisionConflict("已拒绝的推进Candidate缺少Hash证据");
    }
    emitProjectTrace(deps, {
      level: "info",
      eventName: "project.advancement.rejected",
      outcome: "rejected",
      traceId: projectTraceId(candidate.projectCandidateId),
      spanId: projectSpanId(candidate.projectCandidateId, input.commandId, "rejected"),
      projectCandidateId: candidate.projectCandidateId,
      projectId: candidate.projectId,
      projectStageId: candidate.boundStageId,
      candidateRevision: candidate.revision,
      candidateSha256: candidate.candidateSha256,
      commandId: input.commandId,
    });
  }
  return { candidate: toDto(candidate), project: workspace.project };
}

function assertEvidenceBelongsToProject(
  snapshot: Awaited<ReturnType<ApplicationDeps["store"]["read"]>>["snapshot"],
  projectId: string,
  evidenceIds: readonly string[],
): void {
  if (evidenceIds.some((id) => snapshot.entities.projectEvidence[id]?.projectId !== projectId)) {
    throw revisionConflict("Evidence不存在或属于其他Project");
  }
}

export async function transitionProjectStage(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectStageId: string;
    readonly expectedRevision: number;
    readonly payload: TransitionProjectStagePayload;
  },
) {
  const ids = requireIds(deps);
  const decisionId = ids.decision();
  const transitionId = ids.stateTransition();
  const now = deps.now();
  const tx = await deps.store.transact({
    commandId: input.commandId,
    commandType: "TransitionProjectStage",
    requestSha256: hashCanonical("command.transition-project-stage.v1", input),
    mutate: (draft) => {
      const stage = draft.entities.projectStages[input.projectStageId];
      const project = stage === undefined ? undefined : draft.entities.projects[stage.projectId];
      const method =
        stage === undefined
          ? undefined
          : draft.entities.projectMethodSnapshots[stage.methodSnapshotId];
      const actor = draft.entities.projectParticipants[input.payload.decidedByParticipantId];
      if (stage === undefined || project === undefined || method === undefined)
        throw notFound("Stage不存在");
      if (
        project.ownerPrincipalId !== input.principalId ||
        actor?.principalId !== input.principalId
      ) {
        throw forbidden("无权转换该Stage");
      }
      if (stage.revision !== input.expectedRevision) throw revisionConflict("Stage revision冲突");
      assertEvidenceBelongsToProject(draft, project.projectId, input.payload.evidenceIds);
      assertProjectStageTransition({
        from: stage.status,
        to: input.payload.status,
        decisionId,
        evidenceIds: input.payload.evidenceIds,
        evidenceRequirement: method.policies.stage.completionEvidence,
      });
      if (
        input.payload.status === "active" &&
        Object.values(draft.entities.projectStages).some(
          (item) =>
            item.projectId === project.projectId &&
            item.projectStageId !== stage.projectStageId &&
            item.status === "active",
        )
      ) {
        throw revisionConflict("Project已有另一个active Stage");
      }
      const decision: ProjectDecision = {
        schemaVersion: "project-decision.v1",
        projectDecisionId: decisionId,
        projectId: project.projectId,
        question: `是否把Stage从${stage.status}转换为${input.payload.status}？`,
        options: [input.payload.status],
        choice: input.payload.status,
        rationale: input.payload.reason,
        decidedByParticipantId: input.payload.decidedByParticipantId,
        boundProjectRevision: project.revision,
        status: "active",
        commandId: input.commandId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const nextStage = {
        ...stage,
        status: input.payload.status,
        ...(input.payload.status === "active" && stage.startedAt === undefined
          ? { startedAt: now }
          : {}),
        ...(["completed", "skipped"].includes(input.payload.status)
          ? {
              completedAt: now,
              completionDecisionId: decisionId,
              completionEvidenceIds: input.payload.evidenceIds,
            }
          : {}),
        revision: stage.revision + 1,
        updatedAt: now,
      };
      const transition: ProjectStateTransition = {
        schemaVersion: "project-state-transition.v1",
        projectStateTransitionId: transitionId,
        projectId: project.projectId,
        objectType: "stage",
        objectId: stage.projectStageId,
        from: stage.status,
        to: input.payload.status,
        actorParticipantId: input.payload.decidedByParticipantId,
        commandId: input.commandId,
        beforeRevision: stage.revision,
        afterRevision: nextStage.revision,
        reason: input.payload.reason,
        decisionId,
        evidenceIds: input.payload.evidenceIds,
        occurredAt: now,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.entities.projectStages[stage.projectStageId] = nextStage;
      draft.entities.projectDecisions[decisionId] = decision;
      draft.entities.projectStateTransitions[transitionId] = transition;
      draft.entities.projects[project.projectId] = {
        ...project,
        revision: project.revision + 1,
        updatedAt: now,
      };
      return { resultRefs: { projectId: project.projectId, projectStageId: stage.projectStageId } };
    },
  });
  const workspace = await getProjectWorkspace(deps, {
    principalId: input.principalId,
    projectId: tx.resultRefs.projectId ?? "",
  });
  if (!tx.replayed) {
    const transition = Object.values(
      (await deps.store.read({ kind: "committedSnapshot" })).snapshot.entities
        .projectStateTransitions,
    ).find((item) => item.commandId === input.commandId && item.objectId === input.projectStageId);
    if (transition !== undefined && transition.objectType === "stage") {
      emitProjectTrace(deps, {
        level: "info",
        eventName: "project.stage.transitioned",
        outcome: "success",
        traceId: projectTraceId(transition.projectId),
        spanId: projectSpanId(transition.projectStateTransitionId, input.commandId),
        projectId: transition.projectId,
        projectStageId: transition.objectId as never,
        projectStateTransitionId: transition.projectStateTransitionId,
        projectDecisionId: decisionId,
        fromStatus: transition.from as never,
        toStatus: transition.to as never,
        beforeRevision: transition.beforeRevision,
        afterRevision: transition.afterRevision,
        evidenceCount: transition.evidenceIds.length,
        commandId: input.commandId,
      });
    }
  }
  return workspace.project;
}

export async function transitionProjectMilestone(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectMilestoneId: string;
    readonly expectedRevision: number;
    readonly payload: TransitionProjectMilestonePayload;
  },
) {
  const ids = requireIds(deps);
  const decisionId = ids.decision();
  const transitionId = ids.stateTransition();
  const now = deps.now();
  const tx = await deps.store.transact({
    commandId: input.commandId,
    commandType: "TransitionProjectMilestone",
    requestSha256: hashCanonical("command.transition-project-milestone.v1", input),
    mutate: (draft) => {
      const milestone = draft.entities.projectMilestones[input.projectMilestoneId];
      const project =
        milestone === undefined ? undefined : draft.entities.projects[milestone.projectId];
      const actor = draft.entities.projectParticipants[input.payload.decidedByParticipantId];
      if (milestone === undefined || project === undefined) throw notFound("Milestone不存在");
      if (
        project.ownerPrincipalId !== input.principalId ||
        actor?.principalId !== input.principalId
      ) {
        throw forbidden("无权转换该Milestone");
      }
      if (milestone.revision !== input.expectedRevision)
        throw revisionConflict("Milestone revision冲突");
      assertEvidenceBelongsToProject(draft, project.projectId, input.payload.evidenceIds);
      assertProjectMilestoneTransition({
        from: milestone.status,
        to: input.payload.status,
        decisionId,
        evidenceIds: input.payload.evidenceIds,
      });
      const decision: ProjectDecision = {
        schemaVersion: "project-decision.v1",
        projectDecisionId: decisionId,
        projectId: project.projectId,
        question: `是否把Milestone转换为${input.payload.status}？`,
        options: [input.payload.status],
        choice: input.payload.status,
        rationale: input.payload.reason,
        decidedByParticipantId: input.payload.decidedByParticipantId,
        boundProjectRevision: project.revision,
        status: "active",
        commandId: input.commandId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const nextMilestone = {
        ...milestone,
        status: input.payload.status,
        ...(input.payload.status === "achieved" ? { achievedDecisionId: decisionId } : {}),
        evidenceIds: input.payload.evidenceIds,
        revision: milestone.revision + 1,
        updatedAt: now,
      };
      const transition: ProjectStateTransition = {
        schemaVersion: "project-state-transition.v1",
        projectStateTransitionId: transitionId,
        projectId: project.projectId,
        objectType: "milestone",
        objectId: milestone.projectMilestoneId,
        from: milestone.status,
        to: input.payload.status,
        actorParticipantId: input.payload.decidedByParticipantId,
        commandId: input.commandId,
        beforeRevision: milestone.revision,
        afterRevision: nextMilestone.revision,
        reason: input.payload.reason,
        decisionId,
        evidenceIds: input.payload.evidenceIds,
        occurredAt: now,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.entities.projectMilestones[milestone.projectMilestoneId] = nextMilestone;
      draft.entities.projectDecisions[decisionId] = decision;
      draft.entities.projectStateTransitions[transitionId] = transition;
      draft.entities.projects[project.projectId] = {
        ...project,
        revision: project.revision + 1,
        updatedAt: now,
      };
      return {
        resultRefs: {
          projectId: project.projectId,
          projectMilestoneId: milestone.projectMilestoneId,
        },
      };
    },
  });
  const workspace = await getProjectWorkspace(deps, {
    principalId: input.principalId,
    projectId: tx.resultRefs.projectId ?? "",
  });
  if (!tx.replayed) {
    const transition = Object.values(
      (await deps.store.read({ kind: "committedSnapshot" })).snapshot.entities
        .projectStateTransitions,
    ).find(
      (item) => item.commandId === input.commandId && item.objectId === input.projectMilestoneId,
    );
    if (transition !== undefined && transition.objectType === "milestone") {
      emitProjectTrace(deps, {
        level: "info",
        eventName: "project.milestone.transitioned",
        outcome: "success",
        traceId: projectTraceId(transition.projectId),
        spanId: projectSpanId(transition.projectStateTransitionId, input.commandId),
        projectId: transition.projectId,
        projectMilestoneId: transition.objectId as never,
        projectStateTransitionId: transition.projectStateTransitionId,
        projectDecisionId: decisionId,
        fromStatus: transition.from as never,
        toStatus: transition.to as never,
        beforeRevision: transition.beforeRevision,
        afterRevision: transition.afterRevision,
        evidenceCount: transition.evidenceIds.length,
        commandId: input.commandId,
      });
    }
  }
  return workspace.project;
}
