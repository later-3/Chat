import {
  projectAgentOpeningPacketSchema,
  projectAgentOpeningPacketV2Schema,
  type PrincipalId,
  type ProductSnapshot,
  type Project,
  type ProjectAgentOpeningPacket,
  type ProjectAgentOpeningPacketQuery,
  type ProjectAgentOpeningPacketV2,
  type ProjectAgentOpeningPacketV2Query,
  type ProjectParticipant,
  type ProjectProviderBinding,
  type ProjectResource,
  type ProjectWork,
} from "@chat/contracts";
import type { ApplicationDeps } from "./deps.js";
import { ApplicationError, forbidden, notFound, revisionConflict } from "./errors.js";
import { compileContentLabProjectContext } from "./project-content-context-use-cases.js";
import { getPlaneProjectSnapshot } from "./plane-project-coordination-use-cases.js";
import {
  compileProjectAgentContext,
  evaluateProjectMaintenance,
} from "./project-management-query-use-cases.js";

interface ResolvedProject {
  readonly snapshot: ProductSnapshot;
  readonly project: Project;
  readonly resource?: ProjectResource | undefined;
  readonly participant?: ProjectParticipant | undefined;
  readonly workspaceRootId?: string | undefined;
  readonly sources: ProjectAgentOpeningPacket["resolution"]["sources"];
}

const TERMINAL_WORK_STATES = new Set([
  "done",
  "cancelled",
  "published",
  "dropped",
  "adopted",
  "rejected",
]);
const PENDING_OPERATION_STATES = new Set([
  "queued",
  "dispatching",
  "outcome_unknown",
  "needs_attention",
]);
const PENDING_INBOUND_STATES = new Set(["observed", "candidate", "needs_attention"]);

/**
 * Codex、Pi和Chat内Agent共享同一个确定性开工入口。Resolver只使用Product ID和受管Root ID；
 * Session、工作目录或模型记忆都不能单独制造Project关联。
 */
export async function getProjectAgentOpeningPacket(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly query: ProjectAgentOpeningPacketQuery;
  },
): Promise<{ packet: ProjectAgentOpeningPacket }> {
  return compileProjectAgentOpeningPacket(deps, input, true) as Promise<{
    packet: ProjectAgentOpeningPacket;
  }>;
}

/** 普通Agent入口只编译Chat事实，不读取或投影任何外部事项Provider状态。 */
export async function getProjectAgentOpeningPacketV2(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly query: ProjectAgentOpeningPacketV2Query;
  },
): Promise<{ packet: ProjectAgentOpeningPacketV2 }> {
  return compileProjectAgentOpeningPacket(deps, input, false) as Promise<{
    packet: ProjectAgentOpeningPacketV2;
  }>;
}

async function compileProjectAgentOpeningPacket(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly query: ProjectAgentOpeningPacketQuery | ProjectAgentOpeningPacketV2Query;
  },
  includeProviderCoordination: boolean,
): Promise<{ packet: ProjectAgentOpeningPacket | ProjectAgentOpeningPacketV2 }> {
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
  const bindings = includeProviderCoordination
    ? Object.values(snapshot.entities.projectProviderBindings).filter(
        (binding) =>
          binding.projectId === project.projectId &&
          binding.ownerPrincipalId === input.principalId &&
          binding.status !== "archived" &&
          (resolved.workspaceRootId === undefined ||
            binding.workspaceRootId === resolved.workspaceRootId),
      )
    : [];
  if (bindings.length > 1) throw revisionConflict("Project存在多个可用Plane Binding");
  const binding = bindings[0];
  const pendingOperations = includeProviderCoordination
    ? Object.values(snapshot.entities.projectCoordinationOperations)
        .filter(
          (operation) =>
            operation.projectId === project.projectId &&
            PENDING_OPERATION_STATES.has(operation.status),
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 100)
        .map((operation) => ({
          planeProjectOperationId: operation.planeProjectOperationId,
          projectWorkId: operation.projectWorkId,
          kind: operation.intent.kind,
          status: operation.status,
          ...(operation.errorCode === undefined ? {} : { errorCode: operation.errorCode }),
          revision: operation.revision,
          updatedAt: operation.updatedAt,
        }))
    : [];
  const pendingInboundChanges = includeProviderCoordination
    ? Object.values(snapshot.entities.projectInboundChanges)
        .filter(
          (change) =>
            change.projectId === project.projectId && PENDING_INBOUND_STATES.has(change.status),
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 100)
        .map((change) => ({
          projectInboundChangeId: change.projectInboundChangeId,
          projectWorkId: change.workId,
          classification: change.classification,
          status: change.status,
          revision: change.revision,
          updatedAt: change.updatedAt,
        }))
    : [];

  const packetInput = {
    schemaVersion: includeProviderCoordination
      ? "project-agent-coordination.v1"
      : "project-agent-coordination.v2",
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
        pendingOperations,
        claimPolicy: method.policies.coordination.claimPolicy,
        now: deps.now(),
      }),
      ...(includeProviderCoordination
        ? { planeWritesThroughChatOnly: true, rawPlaneCredentialAvailable: false }
        : {}),
    },
    completionGate:
      currentWork === undefined ? null : completionGate(currentWork, method.profileId),
    ...(includeProviderCoordination
      ? {
          plane: await planeProjection(
            deps,
            input.principalId,
            binding,
            currentWork,
            "refreshPlane" in input.query ? input.query.refreshPlane : true,
          ),
          pendingOperations,
          pendingInboundChanges,
        }
      : {}),
    resourceContext: await resourceContext(deps, {
      principalId: input.principalId,
      project,
      resource,
      work: currentWork,
      include: input.query.includeResourceContext,
    }),
    management: await managementProjection(deps, input.principalId, snapshot, project),
    generatedAt: deps.now(),
  };
  const packet = includeProviderCoordination
    ? projectAgentOpeningPacketSchema.parse(packetInput)
    : projectAgentOpeningPacketV2Schema.parse(packetInput);
  return { packet };
}

async function managementProjection(
  deps: ApplicationDeps,
  principalId: PrincipalId,
  snapshot: ProductSnapshot,
  project: Project,
): Promise<NonNullable<ProjectAgentOpeningPacket["management"]>> {
  const hasAdoptedConfiguration = Object.values(
    snapshot.entities.projectConfigurationRevisions,
  ).some(
    (configuration) =>
      configuration.projectId === project.projectId && configuration.status === "adopted",
  );
  if (!hasAdoptedConfiguration) {
    return {
      status: "not_configured",
      reason: "Project尚未采用工具无关的管理Configuration；旧协调事实仍可读取。",
    };
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
  query: ProjectAgentOpeningPacketQuery | ProjectAgentOpeningPacketV2Query,
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
  if (query.workspaceRootId !== undefined) {
    rootIds.add(query.workspaceRootId);
    sources.push("workspace_root");
  }
  if (query.productSessionId !== undefined) {
    const session = snapshot.entities.sessions[query.productSessionId];
    if (session === undefined) throw notFound("Product Session不存在");
    if (session.ownerPrincipalId !== principalId) throw forbidden("无权解析该Product Session");
    const sessionBindings = Object.values(snapshot.entities.projectWorkspaceBindings).filter(
      (binding) =>
        binding.ownerPrincipalId === principalId &&
        binding.productSessionId === query.productSessionId &&
        binding.status === "active",
    );
    for (const binding of sessionBindings) rootIds.add(binding.workspaceRootId);
    if (sessionBindings.length > 0) sources.push("product_session");
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
  if (
    requestedProject !== undefined &&
    rootProjectId !== undefined &&
    rootProjectId !== requestedProject.projectId
  ) {
    throw revisionConflict("Project与Workspace Root关联不一致");
  }
  const project =
    requestedProject ??
    (rootProjectId === undefined ? undefined : snapshot.entities.projects[rootProjectId]);
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
): ProjectAgentOpeningPacket["workCandidates"][number] {
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
): ProjectAgentOpeningPacket["resource"] {
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
): ProjectAgentOpeningPacket["completionGate"] {
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
      explanation: "完成事实必须经过Chat既有Work/Evidence合同；Agent不能用Plane状态代替完成门。",
    };
  return {
    terminalState: "done",
    requiredEvidenceRoles: [],
    humanDecisionRequired: true,
    publicationOutcomeRequired: false,
    automaticTerminalTransitionAllowed: false,
    explanation: "完成事实遵守当前Project Profile与Work验收条件；Agent不能用Plane状态代替完成门。",
  };
}

function allowedActions(input: {
  readonly snapshot: ProductSnapshot;
  readonly currentWork?: ProjectWork | undefined;
  readonly participant?: ProjectParticipant | undefined;
  readonly pendingOperations: readonly unknown[];
  readonly claimPolicy: "disabled" | "optional" | "required_for_agent";
  readonly now: string;
}): ProjectAgentOpeningPacket["permissions"]["allowedActions"] {
  const actions: ProjectAgentOpeningPacket["permissions"]["allowedActions"][number][] = [];
  if (input.currentWork === undefined) actions.push("select_work");
  if (input.pendingOperations.length > 0) actions.push("reconcile");
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

async function planeProjection(
  deps: ApplicationDeps,
  principalId: PrincipalId,
  binding: ProjectProviderBinding | undefined,
  currentWork: ProjectWork | undefined,
  refreshPlane: boolean,
): Promise<ProjectAgentOpeningPacket["plane"]> {
  if (binding === undefined) return { status: "not_bound" };
  if (binding.status !== "active") {
    return {
      status: "needs_attention",
      planeProjectBindingId: binding.projectProviderBindingId,
      errorCode: "plane_binding_needs_attention",
    };
  }
  if (!refreshPlane) {
    return {
      status: "unavailable",
      planeProjectBindingId: binding.projectProviderBindingId,
      errorCode: "plane_refresh_not_requested",
    };
  }
  try {
    const plane = await getPlaneProjectSnapshot(deps, {
      principalId,
      planeProjectBindingId: binding.projectProviderBindingId,
    });
    const currentItem =
      currentWork === undefined
        ? undefined
        : plane.workItems.find((item) => item.projectWorkId === currentWork.projectWorkId);
    return {
      status: "ready",
      planeProjectBindingId: binding.projectProviderBindingId,
      planeWorkspaceSlug: plane.planeWorkspaceSlug,
      planeProjectId: plane.project.planeProjectId,
      planeProjectIdentifier: plane.project.identifier,
      planeProjectName: plane.project.name,
      currentWorkItem:
        currentItem === undefined
          ? null
          : {
              planeWorkItemId: currentItem.planeWorkItemId,
              sequenceId: currentItem.sequenceId,
              name: currentItem.name,
              priority: currentItem.priority,
              stateName: currentItem.state.name,
              stateGroup: currentItem.state.group,
              updatedAt: currentItem.updatedAt,
            },
      totalWorkItemCount: plane.totalWorkItemCount,
      unresolvedOperationCount: plane.unresolvedOperationCount,
      pendingInboundChangeCount: plane.pendingInboundChangeCount,
      capturedAt: plane.capturedAt,
    };
  } catch (error) {
    const code =
      error instanceof ApplicationError
        ? error.code
        : typeof error === "object" &&
            error !== null &&
            "code" in error &&
            typeof error.code === "string"
          ? error.code
          : "plane_snapshot_unavailable";
    return {
      status:
        error instanceof ApplicationError && error.code === "revision_conflict"
          ? "needs_attention"
          : "unavailable",
      planeProjectBindingId: binding.projectProviderBindingId,
      errorCode: code,
    };
  }
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
): Promise<ProjectAgentOpeningPacket["resourceContext"]> {
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
