import {
  type CommandId,
  type PrincipalId,
  type Project,
  type ProjectContribution,
  type ProjectDecision,
  type ProjectStateTransition,
  type ProjectWorkspaceDto,
  type RecordProjectContributionPayload,
  type RecordProjectDecisionPayload,
  type TransitionProjectLifecyclePayload,
} from "@chat/contracts";
import {
  assertProjectLifecycleTransition,
  computeProjectObservationSha256,
  hashCanonical,
} from "@chat/domain";
import { type ApplicationDeps } from "../deps.js";
import { forbidden, notFound, revisionConflict } from "../errors.js";
import {
  requireProjectRoots,
  requireProjectIds,
  emitProjectTrace,
  emitProjectLifecycleTrace,
  projectTraceId,
  projectSpanId,
  assertProjectWritable,
} from "./shared.js";
import { getProjectWorkspace } from "./queries.js";

export async function transitionProjectLifecycle(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectId: string;
    readonly expectedRevision: number;
    readonly payload: TransitionProjectLifecyclePayload;
  },
): Promise<{ project: ProjectWorkspaceDto }> {
  const ids = requireProjectIds(deps);
  const decisionId = ids.decision();
  const transitionId = ids.stateTransition();
  const now = deps.now();
  const transaction = await deps.store.transact({
    commandId: input.commandId,
    commandType: "TransitionProjectLifecycle",
    requestSha256: hashCanonical("command.transition-project-lifecycle.v1", input),
    mutate: (draft) => {
      const project = draft.entities.projects[input.projectId];
      const actor = draft.entities.projectParticipants[input.payload.decidedByParticipantId];
      if (project === undefined) throw notFound("Project不存在");
      if (
        project.ownerPrincipalId !== input.principalId ||
        actor?.projectId !== project.projectId ||
        actor.kind !== "human" ||
        actor.principalId !== input.principalId ||
        actor.status !== "active"
      ) {
        throw forbidden("无权转换该Project生命周期");
      }
      if (project.revision !== input.expectedRevision)
        throw revisionConflict("Project revision冲突");
      if (
        input.payload.evidenceIds.some(
          (id) => draft.entities.projectEvidence[id]?.projectId !== project.projectId,
        )
      ) {
        throw revisionConflict("Evidence不存在或属于其他Project");
      }
      assertProjectLifecycleTransition({
        from: project.status,
        to: input.payload.status,
        evidenceIds: input.payload.evidenceIds,
      });
      const decision: ProjectDecision = {
        schemaVersion: "project-decision.v1",
        projectDecisionId: decisionId,
        projectId: project.projectId,
        question: `是否把Project从${project.status}转换为${input.payload.status}？`,
        options: [input.payload.status],
        choice: input.payload.status,
        rationale: input.payload.reason,
        decidedByParticipantId: actor.projectParticipantId,
        boundProjectRevision: project.revision,
        status: "active",
        commandId: input.commandId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const nextProject: Project = {
        ...project,
        status: input.payload.status,
        revision: project.revision + 1,
        updatedAt: now,
      };
      const transition: ProjectStateTransition = {
        schemaVersion: "project-state-transition.v1",
        projectStateTransitionId: transitionId,
        projectId: project.projectId,
        objectType: "project",
        objectId: project.projectId,
        from: project.status,
        to: input.payload.status,
        actorParticipantId: actor.projectParticipantId,
        commandId: input.commandId,
        beforeRevision: project.revision,
        afterRevision: nextProject.revision,
        reason: input.payload.reason,
        decisionId,
        evidenceIds: input.payload.evidenceIds,
        occurredAt: now,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.entities.projects[project.projectId] = nextProject;
      draft.entities.projectDecisions[decisionId] = decision;
      draft.entities.projectStateTransitions[transitionId] = transition;
      return {
        resultRefs: {
          projectId: project.projectId,
          projectDecisionId: decisionId,
          projectStateTransitionId: transitionId,
        },
      };
    },
  });
  if (!transaction.replayed) {
    await emitProjectLifecycleTrace(deps, transitionId, input.commandId);
  }
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
