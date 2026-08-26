import {
  type PrincipalId,
  type ProjectSummaryDto,
  type ProjectWorkspaceDto,
} from "@chat/contracts";
import { projectSummaryV3DtoSchema, projectWorkspaceV3DtoSchema } from "@chat/contracts";
import { forbidden, notFound } from "../errors.js";
/**
 * Project用例共享helper：根注册表、ID工厂、Trace发射与可写性断言。
 * 只有本目录内模块使用；不作为包公开面。
 */
import {
  type CommandId,
  type Project,
  type ProjectCandidate,
  type ProjectCandidateDto,
  type TraceEventInput,
} from "@chat/contracts";
import { PROJECT_API_V3_SCHEMA_VERSION, projectCandidateDtoSchema } from "@chat/contracts";
import { hashCanonical } from "@chat/domain";
import { type ApplicationDeps, type ProjectIdFactory } from "../deps.js";
import { ApplicationError, revisionConflict } from "../errors.js";
export type Snapshot = Awaited<ReturnType<ApplicationDeps["store"]["read"]>>["snapshot"];

export function requireProjectRoots(deps: ApplicationDeps) {
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

export function requireProjectIds(deps: ApplicationDeps): ProjectIdFactory {
  if (deps.projectIds === undefined) {
    throw new ApplicationError({
      code: "internal_error",
      httpStatus: 500,
      message: "Project ID Factory未配置",
    });
  }
  return deps.projectIds;
}

export function emitProjectTrace(deps: ApplicationDeps, event: TraceEventInput): void {
  try {
    deps.trace?.(event);
  } catch {
    // Trace故障不能把已经提交的Project事实改写成失败。
  }
}

export async function emitProjectLifecycleTrace(
  deps: ApplicationDeps,
  transitionId: string,
  commandId: CommandId,
): Promise<void> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const transition = snapshot.entities.projectStateTransitions[transitionId];
  if (transition === undefined || transition.objectType !== "project") return;
  emitProjectTrace(deps, {
    level: "info",
    eventName: "project.lifecycle.transitioned",
    outcome: "success",
    traceId: projectTraceId(transition.projectId),
    spanId: projectSpanId(transition.projectStateTransitionId, commandId),
    projectId: transition.projectId,
    projectStateTransitionId: transition.projectStateTransitionId,
    projectDecisionId: transition.decisionId,
    fromStatus: transition.from,
    toStatus: transition.to,
    beforeRevision: transition.beforeRevision,
    afterRevision: transition.afterRevision,
    evidenceCount: transition.evidenceIds.length,
    commandId,
  });
}

export function projectTraceId(id: string): string {
  return `tr_${id.slice(4)}`;
}

export function projectSpanId(...parts: string[]): string {
  return `sp_${hashCanonical("project-trace-span.v1", parts).slice(0, 24)}`;
}

export function assertProjectWritable(project: Project): void {
  if (project.status !== "active") {
    throw revisionConflict("只有active Project可以执行普通写入；请先显式恢复生命周期");
  }
}

export function toCandidateDto(candidate: ProjectCandidate): ProjectCandidateDto {
  if (candidate.candidateKind === "management") {
    return projectCandidateDtoSchema.parse({
      schemaVersion: PROJECT_API_V3_SCHEMA_VERSION,
      projectCandidateId: candidate.projectCandidateId,
      sessionId: candidate.sessionId,
      candidateKind: "management",
      projectId: candidate.projectId,
      boundProjectRevision: candidate.boundProjectRevision,
      proposal: candidate.proposal,
      candidateSha256: candidate.candidateSha256,
      status: candidate.status,
      ...(candidate.status === "confirmed"
        ? { committedObjectId: candidate.committedObjectId }
        : {}),
      revision: candidate.revision,
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
      allowedActions: candidate.status === "under_review" ? ["revise", "confirm", "reject"] : [],
    });
  }
  if (candidate.candidateKind === "advancement") {
    const base = {
      schemaVersion: PROJECT_API_V3_SCHEMA_VERSION,
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
    return projectCandidateDtoSchema.parse({
      ...base,
      status: "rejected",
      allowedActions: [],
    });
  }
  const base = {
    schemaVersion: PROJECT_API_V3_SCHEMA_VERSION,
    projectCandidateId: candidate.projectCandidateId,
    sessionId: candidate.sessionId,
    candidateKind: "intake",
    rootId: candidate.rootId,
    revision: candidate.revision,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  } as const;
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

export function projectSummary(snapshot: Snapshot, project: Project): ProjectSummaryDto {
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
  return projectSummaryV3DtoSchema.parse({
    schemaVersion: PROJECT_API_V3_SCHEMA_VERSION,
    projectId: project.projectId,
    name: project.name,
    summary: project.summary,
    goal: project.goal,
    status: project.status,
    methodProfileId: method.profileId,
    stageName: stage.name,
    activeWorkCount: works.filter(
      (work) =>
        !["done", "cancelled", "published", "dropped", "adopted", "rejected"].includes(work.status),
    ).length,
    openActionCount: actions.filter((action) => !["done", "cancelled"].includes(action.status))
      .length,
    participantCount: participants.filter((participant) => participant.status === "active").length,
    revision: project.revision,
    updatedAt: project.updatedAt,
  });
}

export function projectWorkspace(
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
  const workBlocks = Object.values(snapshot.entities.projectWorkBlocks).filter(
    (item) => item.projectId === project.projectId,
  );
  const workClaims = Object.values(snapshot.entities.projectWorkClaims).filter(
    (item) => item.projectId === project.projectId,
  );
  const workHandoffs = Object.values(snapshot.entities.projectWorkHandoffs).filter(
    (item) => item.projectId === project.projectId,
  );
  const practices = Object.values(snapshot.entities.projectPracticeRevisions).filter(
    (item) => item.projectId === project.projectId,
  );
  const publicationOutcomes = Object.values(snapshot.entities.projectWorkOutcomes).filter(
    (item) => item.projectId === project.projectId,
  );
  const contextMap = Object.values(snapshot.entities.projectContextMaps).find(
    (item) => item.projectId === project.projectId && item.status === "active",
  );
  const providerBindings = Object.values(snapshot.entities.projectProviderBindings).filter(
    (item) => item.projectId === project.projectId,
  );
  const providerProjections = Object.values(snapshot.entities.projectProviderProjections).filter(
    (item) => item.projectId === project.projectId,
  );
  const stage = snapshot.entities.projectStages[project.currentStageId];
  if (stage === undefined) throw notFound("Project当前Stage不存在");
  const milestones = Object.values(snapshot.entities.projectMilestones).filter(
    (item) => item.projectId === project.projectId && item.stageId === stage.projectStageId,
  );
  const latestUpdate = Object.values(snapshot.entities.projectUpdates)
    .filter((item) => item.projectId === project.projectId)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0];
  return projectWorkspaceV3DtoSchema.parse({
    schemaVersion: PROJECT_API_V3_SCHEMA_VERSION,
    project: projectSummary(snapshot, project),
    scopeIn: project.scopeIn,
    scopeOut: project.scopeOut,
    successCriteria: project.successCriteria,
    stage: {
      projectStageId: stage.projectStageId,
      name: stage.name,
      goal: stage.goal,
      successCriteria: stage.successCriteria,
      status: stage.status,
      revision: stage.revision,
    },
    milestones: milestones.map((item) => ({
      projectMilestoneId: item.projectMilestoneId,
      outcome: item.outcome,
      acceptanceCriteria: item.acceptanceCriteria,
      status: item.status,
      ...(item.targetAt !== undefined ? { targetAt: item.targetAt } : {}),
      revision: item.revision,
    })),
    latestUpdate:
      latestUpdate === undefined
        ? null
        : {
            projectUpdateId: latestUpdate.projectUpdateId,
            authorParticipantId: latestUpdate.authorParticipantId,
            health: latestUpdate.health,
            narrative: latestUpdate.narrative,
            observedChanges: latestUpdate.observedChanges,
            blockers: latestUpdate.blockers,
            nextFocus: latestUpdate.nextFocus,
            publishedAt: latestUpdate.publishedAt,
          },
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
    works: works.map((work) => {
      const activeBlock = workBlocks.find(
        (block) => block.projectWorkBlockId === work.activeBlockId && block.status === "active",
      );
      const activeClaim = workClaims.find(
        (claim) => claim.projectWorkClaimId === work.activeClaimId && claim.status === "active",
      );
      const latestHandoff = workHandoffs
        .filter((handoff) => handoff.workId === work.projectWorkId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      return {
        projectWorkId: work.projectWorkId,
        workKey: work.workKey,
        kind: work.kind,
        title: work.title,
        objective: work.objective,
        acceptanceCriteria: work.acceptanceCriteria,
        dependsOn: work.dependsOn,
        ownerParticipantId: work.ownerParticipantId,
        practiceRevisionIds: work.practiceRevisionIds,
        resourceRefs: work.resourceRefs,
        status: work.status,
        ...(work.kind === "content_delivery" ? { content: work.content } : {}),
        ...(work.kind === "workflow_improvement" ? { practice: work.practice } : {}),
        activeBlock:
          activeBlock === undefined
            ? null
            : {
                projectWorkBlockId: activeBlock.projectWorkBlockId,
                previousState: activeBlock.previousState,
                reason: activeBlock.reason,
                stoppedAt: activeBlock.stoppedAt,
                recoveryConditions: activeBlock.recoveryConditions,
                reportedByParticipantId: activeBlock.reportedByParticipantId,
                revision: activeBlock.revision,
              },
        activeClaim:
          activeClaim === undefined
            ? null
            : {
                projectWorkClaimId: activeClaim.projectWorkClaimId,
                participantId: activeClaim.participantId,
                acquiredAt: activeClaim.acquiredAt,
                leaseExpiresAt: activeClaim.leaseExpiresAt,
                revision: activeClaim.revision,
              },
        latestHandoff:
          latestHandoff === undefined
            ? null
            : {
                projectWorkHandoffId: latestHandoff.projectWorkHandoffId,
                fromParticipantId: latestHandoff.fromParticipantId,
                ...(latestHandoff.toParticipantId === undefined
                  ? {}
                  : { toParticipantId: latestHandoff.toParticipantId }),
                completed: latestHandoff.completed,
                remaining: latestHandoff.remaining,
                risks: latestHandoff.risks,
                nextStep: latestHandoff.nextStep,
                requiredReads: latestHandoff.requiredReads,
                evidenceIds: latestHandoff.evidenceIds,
                createdAt: latestHandoff.createdAt,
              },
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
      };
    }),
    practices: practices.map((practice) => ({
      projectPracticeRevisionId: practice.projectPracticeRevisionId,
      practiceKey: practice.practiceKey,
      version: practice.version,
      title: practice.title,
      applicableWorkKinds: practice.applicableWorkKinds,
      artifactEvidenceId: practice.artifactEvidenceId,
      status: practice.status,
      sha256: practice.sha256,
      adoptedAt: practice.adoptedAt,
    })),
    publicationOutcomes: publicationOutcomes.map((outcome) => ({
      projectWorkOutcomeId: outcome.projectWorkOutcomeId,
      workId: outcome.workId,
      kind: outcome.kind,
      platform: outcome.platform,
      contentRevisionEvidenceId: outcome.contentRevisionEvidenceId,
      publicationEvidenceId: outcome.publicationEvidenceId,
      ...(outcome.externalContentId === undefined
        ? {}
        : { externalContentId: outcome.externalContentId }),
      ...(outcome.url === undefined ? {} : { url: outcome.url }),
      publishedAt: outcome.publishedAt,
      status: outcome.status,
      verification: outcome.verification,
      revision: outcome.revision,
    })),
    contextMap:
      contextMap === undefined
        ? null
        : {
            projectContextMapId: contextMap.projectContextMapId,
            methodSnapshotId: contextMap.methodSnapshotId,
            selectors: contextMap.selectors,
            historyViews: contextMap.historyViews,
            authorityPolicyVersion: contextMap.authorityPolicyVersion,
            evidencePolicyVersion: contextMap.evidencePolicyVersion,
            sha256: contextMap.sha256,
            revision: contextMap.revision,
          },
    providerBindings: providerBindings.map((binding) => ({
      projectProviderBindingId: binding.projectProviderBindingId,
      providerKind: binding.providerKind,
      providerVersion: binding.providerVersion,
      externalWorkspaceId: binding.externalWorkspaceId,
      externalProjectId: binding.externalProjectId,
      externalProjectIdentifier: binding.externalProjectIdentifier,
      syncPolicyVersion: binding.syncPolicyVersion,
      status: binding.status,
      revision: binding.revision,
    })),
    providerProjections: providerProjections.map((projection) => ({
      projectProviderProjectionId: projection.projectProviderProjectionId,
      bindingId: projection.bindingId,
      objectType: projection.objectType,
      objectId: projection.objectId,
      providerObjectType: projection.providerObjectType,
      providerObjectId: projection.providerObjectId,
      ...(projection.externalKey === undefined ? {} : { externalKey: projection.externalKey }),
      chatObjectRevision: projection.chatObjectRevision,
      syncStatus: projection.syncStatus,
      ...(projection.lastSyncedAt === undefined ? {} : { lastSyncedAt: projection.lastSyncedAt }),
      revision: projection.revision,
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
