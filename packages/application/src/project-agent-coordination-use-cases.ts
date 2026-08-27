import {
  projectAgentOpeningPacketV2Schema,
  projectAgentOpeningPacketV3Schema,
  type PrincipalId,
  type ProductSnapshot,
  type Project,
  type ProjectAgentOpeningPacketV2,
  type ProjectAgentOpeningPacketV2Query,
  type ProjectAgentOpeningPacketV3,
  type ProjectParticipant,
  type ProjectResource,
  type ProjectWork,
} from "@chat/contracts";
import type { ApplicationDeps } from "./deps.js";
import { forbidden, notFound, revisionConflict } from "./errors.js";
import { compileContentLabProjectContext } from "./project-content-context-use-cases.js";
import {
  compileProjectAgentContext,
  compileProjectAgentContextV2,
  evaluateProjectMaintenance,
} from "./project-management-query-use-cases.js";

interface ResolvedProject {
  readonly snapshot: ProductSnapshot;
  readonly project: Project;
  readonly resource?: ProjectResource | undefined;
  readonly participant?: ProjectParticipant | undefined;
  readonly workspaceRootId?: string | undefined;
  readonly sources: ProjectAgentOpeningPacketV2["resolution"]["sources"];
}

const TERMINAL_WORK_STATES = new Set([
  "done",
  "cancelled",
  "published",
  "dropped",
  "adopted",
  "rejected",
]);

/**
 * Codex、Pi和Chat内Agent共享同一个确定性开工入口。Resolver只使用Product ID和受管Root ID；
 * Session、工作目录或模型记忆都不能单独制造Project关联。
 */
/** 普通Agent入口只编译Chat拥有的Project事实。 */
export async function getProjectAgentOpeningPacketV2(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly query: ProjectAgentOpeningPacketV2Query;
  },
): Promise<{ packet: ProjectAgentOpeningPacketV2 }> {
  return compileProjectAgentOpeningPacket(deps, input, "v2") as Promise<{
    packet: ProjectAgentOpeningPacketV2;
  }>;
}

/** 新普通Opening使用精确Project目标Context；v2入口继续为旧Bridge只读保留。 */
export async function getProjectAgentOpeningPacketV3(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly query: ProjectAgentOpeningPacketV2Query;
  },
): Promise<{ packet: ProjectAgentOpeningPacketV3 }> {
  return compileProjectAgentOpeningPacket(deps, input, "v3") as Promise<{
    packet: ProjectAgentOpeningPacketV3;
  }>;
}

async function compileProjectAgentOpeningPacket(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly query: ProjectAgentOpeningPacketV2Query;
  },
  version: "v2" | "v3",
): Promise<{
  packet: ProjectAgentOpeningPacketV2 | ProjectAgentOpeningPacketV3;
}> {
  const resolved = await resolveProject(deps, input.principalId, input.query);
  const { snapshot, project, participant, resource } = resolved;
  const method = snapshot.entities.projectMethodSnapshots[project.methodSnapshotId];
  if (method === undefined) throw revisionConflict("Project Method Snapshot不存在");
  const contextMap = Object.values(snapshot.entities.projectContextMaps).find(
    (item) => item.projectId === project.projectId && item.status === "active",
  );
  const candidates = Object.values(snapshot.entities.projectWorks)
    .filter(
      (work) => work.projectId === project.projectId && !TERMINAL_WORK_STATES.has(work.status),
    )
    .sort(workPriority);
  const currentWork = selectCurrentWork(
    snapshot,
    candidates,
    participant,
    input.query.workKey,
    deps.now(),
  );
  const workCandidates = candidates
    .slice(0, 100)
    .map((work) => workBrief(snapshot, work, participant?.projectParticipantId, deps.now()));
  const packetInput = {
    schemaVersion:
      version === "v2" ? "project-agent-coordination.v2" : "project-agent-coordination.v3",
    resolution: {
      projectId: project.projectId,
      sources: resolved.sources,
      ...(input.query.productSessionId === undefined
        ? {}
        : { productSessionId: input.query.productSessionId }),
      ...(resolved.workspaceRootId === undefined
        ? {}
        : { workspaceRootId: resolved.workspaceRootId }),
    },
    project: {
      projectId: project.projectId,
      name: project.name,
      goal: project.goal,
      status: project.status,
      revision: project.revision,
      methodSnapshotId: method.projectMethodSnapshotId,
      methodProfileId: method.profileId,
      methodSnapshotRevision: method.revision,
      ...(contextMap === undefined
        ? {}
        : {
            contextMapId: contextMap.projectContextMapId,
            contextMapRevision: contextMap.revision,
            contextMapSha256: contextMap.sha256,
          }),
    },
    participant:
      participant === undefined
        ? null
        : {
            projectParticipantId: participant.projectParticipantId,
            displayName: participant.displayName,
            role: participant.role,
          },
    resource: resourceSummary(snapshot, resource),
    currentWork:
      currentWork === undefined
        ? null
        : workBrief(snapshot, currentWork, participant?.projectParticipantId, deps.now()),
    workCandidates,
    requiresWorkSelection: currentWork === undefined && candidates.length > 0,
    permissions: {
      allowedActions: allowedActions({
        snapshot,
        currentWork,
        participant,
        claimPolicy: method.policies.coordination.claimPolicy,
        now: deps.now(),
      }),
    },
    completionGate:
      currentWork === undefined ? null : completionGate(currentWork, method.profileId),
    resourceContext: await resourceContext(deps, {
      principalId: input.principalId,
      project,
      resource,
      work: currentWork,
      include: input.query.includeResourceContext,
    }),
    management: await managementProjection(
      deps,
      input.principalId,
      snapshot,
      project,
      version === "v3",
    ),
    generatedAt: deps.now(),
  };
  const packet =
    version === "v2"
      ? projectAgentOpeningPacketV2Schema.parse(packetInput)
      : projectAgentOpeningPacketV3Schema.parse(packetInput);
  return { packet };
}

async function managementProjection(
  deps: ApplicationDeps,
  principalId: PrincipalId,
  snapshot: ProductSnapshot,
  project: Project,
  contextV2: boolean,
): Promise<
  NonNullable<ProjectAgentOpeningPacketV2["management"] | ProjectAgentOpeningPacketV3["management"]>
> {
  const hasAdoptedConfiguration = Object.values(
    snapshot.entities.projectConfigurationRevisions,
  ).some(
    (configuration) =>
      configuration.projectId === project.projectId && configuration.status === "adopted",
  );
  if (!hasAdoptedConfiguration) {
    return {
      status: "not_configured",
      reason: "Project尚未采用工具无关的管理Configuration。",
    };
  }
  if (contextV2) {
    const [{ context }, { maintenance }] = await Promise.all([
      compileProjectAgentContextV2(deps, {
        principalId,
        projectId: project.projectId,
        purpose: "project_opening",
        target: { kind: "project" },
      }),
      evaluateProjectMaintenance(deps, {
        principalId,
        projectId: project.projectId,
        trigger: "agent_started",
      }),
    ]);
    return { status: "ready", context, maintenance };
  }
  const [{ context }, { maintenance }] = await Promise.all([
    compileProjectAgentContext(deps, {
      principalId,
      projectId: project.projectId,
      purpose: "project_opening",
    }),
    evaluateProjectMaintenance(deps, {
      principalId,
      projectId: project.projectId,
      trigger: "agent_started",
    }),
  ]);
  return { status: "ready", context, maintenance };
}

async function resolveProject(
  deps: ApplicationDeps,
  principalId: PrincipalId,
  query: ProjectAgentOpeningPacketV2Query,
): Promise<ResolvedProject> {
  const { snapshot: readonlySnapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const snapshot = structuredClone(readonlySnapshot);
  const sources: ResolvedProject["sources"][number][] = [];
  let requestedProject: Project | undefined;
  if (query.projectId !== undefined) {
    requestedProject = snapshot.entities.projects[query.projectId];
    if (requestedProject === undefined || requestedProject.ownerPrincipalId !== principalId) {
      throw notFound("Project不存在");
    }
    sources.push("project_id");
  }

  const rootIds = new Set<string>();
  let sessionProjectId: string | undefined;
  if (query.workspaceRootId !== undefined) {
    rootIds.add(query.workspaceRootId);
    sources.push("workspace_root");
  }
  if (query.productSessionId !== undefined) {
    const session = snapshot.entities.sessions[query.productSessionId];
    if (session === undefined) throw notFound("Product Session不存在");
    if (session.ownerPrincipalId !== principalId) throw forbidden("无权解析该Product Session");
    const sessionProjectIds = new Set(
      Object.values(snapshot.entities.projectCandidates).flatMap((candidate) =>
        candidate.candidateKind === "intake" &&
        candidate.status === "confirmed" &&
        candidate.sessionId === query.productSessionId &&
        "confirmedProjectId" in candidate
          ? [candidate.confirmedProjectId]
          : [],
      ),
    );
    if (sessionProjectIds.size > 1) {
      throw revisionConflict("Product Session关联了多个Project");
    }
    sessionProjectId = [...sessionProjectIds][0];
    if (sessionProjectId !== undefined) sources.push("product_session");
  }
  if (rootIds.size > 1) throw revisionConflict("Resolver输入指向不同Workspace Root");
  const workspaceRootId = [...rootIds][0];
  const matchingResources =
    workspaceRootId === undefined
      ? []
      : Object.values(snapshot.entities.projectResources).filter((resource) => {
          const project = snapshot.entities.projects[resource.projectId];
          return (
            resource.rootId === workspaceRootId &&
            resource.status === "active" &&
            project?.ownerPrincipalId === principalId
          );
        });
  const resourceProjectIds = new Set(matchingResources.map((resource) => resource.projectId));
  if (resourceProjectIds.size > 1) throw revisionConflict("Workspace Root关联了多个活动Project");
  const rootProjectId = [...resourceProjectIds][0];
  const resolvedProjectIds = new Set(
    [requestedProject?.projectId, rootProjectId, sessionProjectId].filter(
      (value): value is string => value !== undefined,
    ),
  );
  if (resolvedProjectIds.size > 1) {
    throw revisionConflict("Project、Product Session与Workspace Root关联不一致");
  }
  const project =
    requestedProject ??
    (rootProjectId === undefined ? undefined : snapshot.entities.projects[rootProjectId]) ??
    (sessionProjectId === undefined ? undefined : snapshot.entities.projects[sessionProjectId]);
  if (project === undefined) {
    throw notFound("没有从Product Session或Workspace Root解析到Chat Project");
  }
  let resources = Object.values(snapshot.entities.projectResources).filter(
    (resource) => resource.projectId === project.projectId && resource.status === "active",
  );
  if (workspaceRootId !== undefined)
    resources = resources.filter((item) => item.rootId === workspaceRootId);
  if (workspaceRootId !== undefined && resources.length !== 1) {
    throw revisionConflict("Project没有唯一活动Workspace Resource");
  }
  const resource = resources.length === 1 ? resources[0] : undefined;
  const participant =
    query.participantId === undefined
      ? undefined
      : snapshot.entities.projectParticipants[query.participantId];
  if (
    query.participantId !== undefined &&
    (participant?.projectId !== project.projectId ||
      participant.kind !== "agent" ||
      participant.status !== "active")
  ) {
    throw forbidden("Agent Participant不属于当前Project或不可用");
  }
  if (sources.length === 0) throw revisionConflict("Project Resolver没有有效来源");
  return {
    snapshot,
    project,
    ...(resource === undefined ? {} : { resource }),
    ...(participant === undefined ? {} : { participant }),
    ...(workspaceRootId === undefined ? {} : { workspaceRootId }),
    sources,
  };
}

function selectCurrentWork(
  snapshot: ProductSnapshot,
  candidates: readonly ProjectWork[],
  participant: ProjectParticipant | undefined,
  requestedWorkKey: string | undefined,
  now: string,
): ProjectWork | undefined {
  if (requestedWorkKey !== undefined) {
    const matches = candidates.filter((work) => work.workKey === requestedWorkKey);
    if (matches.length !== 1) throw notFound("Work Key没有唯一命中活动Work");
    return matches[0];
  }
  if (participant !== undefined) {
    const claimed = candidates.filter((work) => {
      const claim =
        work.activeClaimId === undefined
          ? undefined
          : snapshot.entities.projectWorkClaims[work.activeClaimId];
      return (
        claim?.status === "active" &&
        claim.leaseExpiresAt > now &&
        claim.participantId === participant.projectParticipantId
      );
    });
    if (claimed.length > 1) throw revisionConflict("Agent同时持有多个活动Work Claim");
    if (claimed[0] !== undefined) return claimed[0];
  }
  const engaged = candidates.filter(
    (work) =>
      work.activeBlockId !== undefined ||
      [
        "in_progress",
        "review",
        "selected",
        "producing",
        "experimenting",
        "needs_review",
        "ready",
        "blocked",
      ].includes(work.status),
  );
  if (engaged.length === 1) return engaged[0];
  if (engaged.length === 0 && candidates.length === 1) return candidates[0];
  return undefined;
}

function workPriority(left: ProjectWork, right: ProjectWork): number {
  const rank = (status: string) => {
    const order = [
      "blocked",
      "review",
      "needs_review",
      "in_progress",
      "producing",
      "experimenting",
      "ready",
      "approved",
      "selected",
    ];
    const index = order.indexOf(status);
    return index < 0 ? order.length : index;
  };
  return rank(left.status) - rank(right.status) || right.updatedAt.localeCompare(left.updatedAt);
}

function workBrief(
  snapshot: ProductSnapshot,
  work: ProjectWork,
  participantId: string | undefined,
  now: string,
): ProjectAgentOpeningPacketV2["workCandidates"][number] {
  const claim =
    work.activeClaimId === undefined
      ? undefined
      : snapshot.entities.projectWorkClaims[work.activeClaimId];
  const block =
    work.activeBlockId === undefined
      ? undefined
      : snapshot.entities.projectWorkBlocks[work.activeBlockId];
  const handoff = Object.values(snapshot.entities.projectWorkHandoffs)
    .filter((item) => item.workId === work.projectWorkId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  return {
    projectWorkId: work.projectWorkId,
    workKey: work.workKey,
    kind: work.kind,
    status: work.status,
    title: work.title,
    objective: work.objective,
    acceptanceCriteria: work.acceptanceCriteria,
    ownerParticipantId: work.ownerParticipantId,
    resourceRefs: work.resourceRefs,
    revision: work.revision,
    activeClaim:
      claim?.status === "active" && claim.leaseExpiresAt > now
        ? {
            participantId: claim.participantId,
            leaseExpiresAt: claim.leaseExpiresAt,
            ownedByRequester: claim.participantId === participantId,
          }
        : null,
    activeBlock:
      block?.status === "active"
        ? {
            reason: block.reason,
            stoppedAt: block.stoppedAt,
            recoveryConditions: block.recoveryConditions,
          }
        : null,
    latestHandoff:
      handoff === undefined
        ? null
        : {
            fromParticipantId: handoff.fromParticipantId,
            ...(handoff.toParticipantId === undefined
              ? {}
              : { toParticipantId: handoff.toParticipantId }),
            completed: handoff.completed,
            remaining: handoff.remaining,
            risks: handoff.risks,
            nextStep: handoff.nextStep,
            requiredReads: handoff.requiredReads,
            evidenceIds: handoff.evidenceIds,
            createdAt: handoff.createdAt,
          },
  };
}

function resourceSummary(
  snapshot: ProductSnapshot,
  resource: ProjectResource | undefined,
): ProjectAgentOpeningPacketV2["resource"] {
  if (resource === undefined) return null;
  const observation = Object.values(snapshot.entities.projectObservations)
    .filter((item) => item.resourceId === resource.projectResourceId)
    .sort((left, right) => right.observedAt.localeCompare(left.observedAt))[0];
  return {
    projectResourceId: resource.projectResourceId,
    workspaceRootId: resource.rootId,
    displayName: resource.displayName,
    ...(observation === undefined
      ? {}
      : {
          latestObservationId: observation.projectObservationId,
          latestObservationAt: observation.observedAt,
          ...(observation.changeCandidate === undefined
            ? {}
            : { changeCandidateClassification: observation.changeCandidate.classification }),
          ...(observation.data.contentLab === undefined
            ? {}
            : { observedJobCount: observation.data.contentLab.jobs.length }),
        }),
  };
}

function completionGate(
  work: ProjectWork,
  methodProfileId: string,
): ProjectAgentOpeningPacketV2["completionGate"] {
  if (work.kind === "content_delivery") {
    return {
      terminalState: "published",
      requiredEvidenceRoles: ["content_revision", "qc_report", "publication_receipt"],
      humanDecisionRequired: true,
      publicationOutcomeRequired: true,
      automaticTerminalTransitionAllowed: false,
      explanation:
        "Agent只能请求审核；用户Decision与每个平台的确认发布Outcome齐备后才能Published。",
    };
  }
  if (work.kind === "workflow_improvement") {
    return {
      terminalState: "adopted",
      requiredEvidenceRoles: ["practice_case", "practice_revision"],
      humanDecisionRequired: true,
      publicationOutcomeRequired: false,
      automaticTerminalTransitionAllowed: false,
      explanation: "Agent只能提交案例和方法修订；用户Decision后才能采用新的Practice Revision。",
    };
  }
  if (methodProfileId === "software-delivery.v1")
    return {
      terminalState: "done",
      requiredEvidenceRoles: ["commit", "test"],
      humanDecisionRequired: true,
      publicationOutcomeRequired: false,
      automaticTerminalTransitionAllowed: false,
      explanation: "完成事实必须经过Chat既有Work、Decision与Evidence合同。",
    };
  return {
    terminalState: "done",
    requiredEvidenceRoles: [],
    humanDecisionRequired: true,
    publicationOutcomeRequired: false,
    automaticTerminalTransitionAllowed: false,
    explanation: "完成事实遵守当前Project Profile与Work验收条件。",
  };
}

function allowedActions(input: {
  readonly snapshot: ProductSnapshot;
  readonly currentWork?: ProjectWork | undefined;
  readonly participant?: ProjectParticipant | undefined;
  readonly claimPolicy: "disabled" | "optional" | "required_for_agent";
  readonly now: string;
}): ProjectAgentOpeningPacketV2["permissions"]["allowedActions"] {
  const actions: ProjectAgentOpeningPacketV2["permissions"]["allowedActions"][number][] = [];
  if (input.currentWork === undefined) actions.push("select_work");
  const work = input.currentWork;
  const participant = input.participant;
  if (work === undefined || participant === undefined) return actions;
  const claim =
    work.activeClaimId === undefined
      ? undefined
      : input.snapshot.entities.projectWorkClaims[work.activeClaimId];
  const activeClaim = claim?.status === "active" && claim.leaseExpiresAt > input.now;
  if (work.kind === "generic") {
    if (input.claimPolicy === "disabled") return actions;
    if (["approved", "in_progress", "blocked"].includes(work.status) && !activeClaim)
      actions.push("claim");
    if (activeClaim && claim.participantId === participant.projectParticipantId) {
      actions.push("record_evidence", "handoff", "progress");
      if (work.activeBlockId !== undefined) actions.push("resume");
      if (work.activeBlockId === undefined && ["approved", "in_progress"].includes(work.status)) {
        actions.push("block");
      }
      if (work.activeBlockId === undefined && work.status === "in_progress") {
        actions.push("request_review");
      }
    }
    return [...new Set(actions)];
  }
  if (["selected", "producing", "experimenting", "blocked"].includes(work.status) && !activeClaim) {
    actions.push("claim");
  }
  if (activeClaim && claim.participantId === participant.projectParticipantId) {
    actions.push("record_evidence", "handoff");
    if (work.activeBlockId !== undefined) actions.push("resume");
    if (["producing", "experimenting", "blocked"].includes(work.status)) actions.push("progress");
    if (["selected", "producing", "experimenting", "needs_review"].includes(work.status))
      actions.push("block");
    if (["producing", "experimenting"].includes(work.status)) actions.push("request_review");
  }
  return [...new Set(actions)];
}

async function resourceContext(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly project: Project;
    readonly resource?: ProjectResource | undefined;
    readonly work?: ProjectWork | undefined;
    readonly include: boolean;
  },
): Promise<ProjectAgentOpeningPacketV2["resourceContext"]> {
  if (!input.include) return { status: "not_requested" };
  if (
    input.resource === undefined ||
    input.work === undefined ||
    (input.work.kind !== "content_delivery" && input.work.kind !== "workflow_improvement")
  ) {
    return { status: "not_applicable" };
  }
  try {
    const context = await compileContentLabProjectContext(deps, {
      principalId: input.principalId,
      projectId: input.project.projectId,
      resourceId: input.resource.projectResourceId,
      workId: input.work.projectWorkId,
    });
    return { status: "ready", bundle: context.resourceContext };
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "project_resource_context_unavailable";
    return {
      status: "unavailable",
      errorCode: code,
      message: error instanceof Error ? error.message.slice(0, 500) : "Content Lab上下文不可用",
    };
  }
}
