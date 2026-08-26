import {
  type AdoptProjectPracticePayload,
  type BlockProjectWorkPayload,
  type ClaimProjectWorkPayload,
  type CommandId,
  type CreateContentProductionProjectPayload,
  type CreateProjectWorkPayload,
  type DecideProjectWorkTransitionPayload,
  type HandoffProjectWorkPayload,
  type PrincipalId,
  type Project,
  type ProjectContextMap,
  type ProjectDecision,
  type ProjectEvidence,
  type ProjectManagedObjectKind,
  type ProjectMethodSnapshot,
  type ProjectParticipant,
  type ProjectPracticeRevision,
  type ProjectResource,
  type ProjectStage,
  type ProjectStateTransition,
  type ProjectWork,
  type ProjectWorkBlock,
  type ProjectWorkClaim,
  type ProjectWorkHandoff,
  type ProjectWorkOutcome,
  type ProjectWorkspaceDto,
  type RecordContentPublicationPayload,
  type RecordProjectEvidencePayload,
  type RegisterProjectAgentPayload,
  type RequestProjectWorkReviewPayload,
  type ResumeProjectWorkPayload,
  projectRecoverableWorkStateSchema,
  projectEventSchema,
  projectWorkSchema,
} from "@chat/contracts";
import {
  assertProjectWorkClaimAcquisition,
  assertProjectWorkHandoff,
  assertProjectWorkResume,
  assertProjectWorkTransition,
  compileProjectMethodSnapshotPolicies,
  computeProjectContextMapSha256,
  computeProjectMethodSnapshotSha256,
  computeProjectPracticeRevisionSha256,
  hashCanonical,
} from "@chat/domain";
import type { ApplicationDeps, ProjectIdFactory } from "./deps.js";
import { forbidden, notFound, revisionConflict } from "./errors.js";
import { getProjectWorkspace } from "./project-use-cases/queries.js";
import {
  assertProjectWritable,
  requireProjectIds,
  requireProjectRoots,
} from "./project-use-cases/shared.js";

type CoordinationIds = ProjectIdFactory &
  Required<
    Pick<
      ProjectIdFactory,
      "workBlock" | "workClaim" | "workHandoff" | "practiceRevision" | "workOutcome" | "contextMap"
    >
  >;

type CoordinatedWork = ProjectWork;

function parseCoordinatedWork(input: unknown): CoordinatedWork {
  return projectWorkSchema.parse(input);
}

function requireCoordinationIds(deps: ApplicationDeps): CoordinationIds {
  const ids = requireProjectIds(deps);
  if (
    ids.workBlock === undefined ||
    ids.workClaim === undefined ||
    ids.workHandoff === undefined ||
    ids.practiceRevision === undefined ||
    ids.workOutcome === undefined ||
    ids.contextMap === undefined
  ) {
    throw new Error("Project Coordination ID Factory未配置");
  }
  return ids as CoordinationIds;
}

function ownerProject(
  snapshot: Parameters<Parameters<ApplicationDeps["store"]["transact"]>[0]["mutate"]>[0],
  projectId: string,
  principalId: PrincipalId,
): Project {
  const project = snapshot.entities.projects[projectId];
  if (project === undefined) throw notFound("Project不存在");
  if (project.ownerPrincipalId !== principalId) throw forbidden("无权管理该Project");
  assertProjectWritable(project);
  return project;
}

function humanActor(
  snapshot: Parameters<Parameters<ApplicationDeps["store"]["transact"]>[0]["mutate"]>[0],
  project: Project,
  participantId: string,
  principalId: PrincipalId,
): ProjectParticipant {
  const participant = snapshot.entities.projectParticipants[participantId];
  if (
    participant?.projectId !== project.projectId ||
    participant.kind !== "human" ||
    participant.principalId !== principalId ||
    participant.status !== "active"
  ) {
    throw forbidden("决定者不是当前Project的受权用户");
  }
  return participant;
}

function agentParticipant(
  snapshot: Parameters<Parameters<ApplicationDeps["store"]["transact"]>[0]["mutate"]>[0],
  project: Project,
  participantId: string,
): ProjectParticipant {
  const participant = snapshot.entities.projectParticipants[participantId];
  if (
    participant?.projectId !== project.projectId ||
    participant.kind !== "agent" ||
    participant.status !== "active"
  ) {
    throw revisionConflict("Agent Participant不存在、已停用或属于其他Project");
  }
  return participant;
}

function coordinatedActor(
  snapshot: Parameters<Parameters<ApplicationDeps["store"]["transact"]>[0]["mutate"]>[0],
  project: Project,
  participantId: string,
  principalId: PrincipalId,
): ProjectParticipant {
  const participant = snapshot.entities.projectParticipants[participantId];
  if (participant?.projectId !== project.projectId || participant.status !== "active") {
    throw forbidden("协调者不存在、已停用或属于其他Project");
  }
  if (participant.kind === "agent") return participant;
  if (participant.kind === "human" && participant.principalId === principalId) return participant;
  throw forbidden("只有当前用户或受权Agent能执行协调动作");
}

function isUsableClaim(
  claim: ProjectWorkClaim | undefined,
  participantId: ProjectParticipant["projectParticipantId"],
  now: string,
): claim is ProjectWorkClaim & { status: "active" } {
  return (
    claim?.participantId === participantId &&
    claim.status === "active" &&
    claim.leaseExpiresAt > now
  );
}

function evidenceForWork(
  snapshot: Parameters<Parameters<ApplicationDeps["store"]["transact"]>[0]["mutate"]>[0],
  work: CoordinatedWork,
  evidenceIds: readonly string[],
): ProjectEvidence[] {
  const evidence = evidenceIds.map((id) => snapshot.entities.projectEvidence[id]);
  if (
    evidence.some(
      (item) =>
        item?.projectId !== work.projectId ||
        item.workId !== work.projectWorkId ||
        item.workRevision === undefined ||
        item.workRevision > work.revision,
    )
  ) {
    throw revisionConflict("Evidence不存在、属于其他Work或绑定了未来Revision");
  }
  return evidence as ProjectEvidence[];
}

function recordCoordinationEvent(
  draft: Parameters<Parameters<ApplicationDeps["store"]["transact"]>[0]["mutate"]>[0],
  input: {
    readonly commandId: CommandId;
    readonly projectId: Project["projectId"];
    readonly eventType: string;
    readonly subject: {
      readonly kind: ProjectManagedObjectKind;
      readonly objectId: string;
      readonly revision?: number | undefined;
    };
    readonly actor: ProjectParticipant;
    readonly principalId: PrincipalId;
    readonly occurredAt: string;
    readonly observedAt?: string | undefined;
    readonly beforeRevision?: number | undefined;
    readonly afterRevision?: number | undefined;
    readonly evidenceIds?: readonly ProjectEvidence["projectEvidenceId"][] | undefined;
    readonly payload: unknown;
  },
): string {
  const projectEventId = `pev_${hashCanonical("id.project-coordination-event.v1", {
    commandId: input.commandId,
    projectId: input.projectId,
    eventType: input.eventType,
    subject: input.subject,
  }).slice(0, 24)}`;
  const recordedAt = input.observedAt ?? input.occurredAt;
  draft.entities.projectEvents[projectEventId] = projectEventSchema.parse({
    schemaVersion: "project-event.v1",
    projectEventId,
    projectId: input.projectId,
    eventType: input.eventType,
    subject: input.subject,
    source:
      input.actor.kind === "agent"
        ? { kind: "agent", participantId: input.actor.projectParticipantId }
        : {
            kind: "user",
            principalId: input.principalId,
            participantId: input.actor.projectParticipantId,
          },
    occurredAt: input.occurredAt,
    observedAt: recordedAt,
    recordedAt,
    ...(input.beforeRevision === undefined
      ? {}
      : {
          beforeRevision: input.beforeRevision,
          afterRevision: input.afterRevision,
        }),
    payloadSha256: hashCanonical("project-coordination-event-payload.v1", input.payload),
    evidenceIds: [...(input.evidenceIds ?? [])],
    revision: 1,
    createdAt: recordedAt,
    updatedAt: recordedAt,
  });
  return projectEventId;
}

const CONTENT_CONTEXT_SELECTORS: ProjectContextMap["selectors"] = [
  {
    role: "governance",
    resourceRef: "content-lab:AGENTS.md",
    required: true,
    maxItems: 1,
    maxCharacters: 40_000,
  },
  {
    role: "profile",
    resourceRef: "chat-project:content-production.v1",
    required: true,
    maxItems: 1,
    maxCharacters: 30_000,
  },
  {
    role: "current_work",
    resourceRef: "chat-project:current-work",
    required: true,
    maxItems: 1,
    maxCharacters: 30_000,
  },
  {
    role: "practice",
    resourceRef: "content-lab:workflows",
    required: true,
    maxItems: 3,
    maxCharacters: 80_000,
  },
  {
    role: "case",
    resourceRef: "content-lab:cases",
    required: false,
    maxItems: 5,
    maxCharacters: 80_000,
  },
  {
    role: "provider_snapshot",
    resourceRef: "project-provider:active-binding",
    required: false,
    maxItems: 1,
    maxCharacters: 20_000,
  },
];

export async function createContentProductionProject(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly payload: CreateContentProductionProjectPayload;
  },
): Promise<{ project: ProjectWorkspaceDto }> {
  const descriptor = requireProjectRoots(deps)
    .list()
    .find((root) => root.rootId === input.payload.rootId);
  if (descriptor === undefined) throw notFound("受管Content Lab Root不存在");
  const ids = requireCoordinationIds(deps);
  const allocated = {
    projectId: ids.project(),
    methodId: ids.methodSnapshot(),
    stageId: ids.stage(),
    participantId: ids.participant(),
    resourceId: ids.resource(),
    decisionId: ids.decision(),
    contextMapId: ids.contextMap(),
  };
  const now = deps.now();
  const transaction = await deps.store.transact({
    commandId: input.commandId,
    commandType: "CreateContentProductionProject",
    requestSha256: hashCanonical("command.create-content-production-project.v1", input),
    mutate: (draft) => {
      const duplicate = Object.values(draft.entities.projects).find(
        (project) =>
          project.ownerPrincipalId === input.principalId &&
          Object.values(draft.entities.projectResources).some(
            (resource) =>
              resource.projectId === project.projectId && resource.rootId === descriptor.rootId,
          ),
      );
      if (duplicate !== undefined) throw revisionConflict("该Root已经绑定Chat Project");
      const policies = compileProjectMethodSnapshotPolicies("content-production.v1");
      const project: Project = {
        schemaVersion: "project.v2",
        projectId: allocated.projectId,
        ownerPrincipalId: input.principalId,
        name: input.payload.name,
        summary: input.payload.summary,
        goal: input.payload.goal,
        scopeIn: input.payload.scopeIn,
        scopeOut: input.payload.scopeOut,
        successCriteria: input.payload.successCriteria,
        status: "active",
        methodSnapshotId: allocated.methodId,
        currentStageId: allocated.stageId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const method: ProjectMethodSnapshot = {
        schemaVersion: "project-method-snapshot.v3",
        projectMethodSnapshotId: allocated.methodId,
        projectId: allocated.projectId,
        profileId: "content-production.v1",
        rationale: "用户明确选择内容生产Profile；脚本和Git存在不改变项目业务类型。",
        policies,
        source: "user_tailored",
        sha256: computeProjectMethodSnapshotSha256({
          profileId: "content-production.v1",
          rationale: "用户明确选择内容生产Profile；脚本和Git存在不改变项目业务类型。",
          policies,
          source: "user_tailored",
        }) as never,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const stage: ProjectStage = {
        schemaVersion: "project-stage.v2",
        projectStageId: allocated.stageId,
        projectId: allocated.projectId,
        methodSnapshotId: allocated.methodId,
        key: "content-operations",
        name: "内容生产运营",
        goal: "持续交付内容并用真实案例改进工作方法。",
        successCriteria: input.payload.successCriteria.slice(0, 20),
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
        projectParticipantId: allocated.participantId,
        projectId: allocated.projectId,
        kind: "human",
        principalId: input.principalId,
        displayName: "项目所有者",
        role: "owner",
        status: "active",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const resource: ProjectResource = {
        schemaVersion: "project-resource.v1",
        projectResourceId: allocated.resourceId,
        projectId: allocated.projectId,
        rootId: descriptor.rootId,
        displayName: descriptor.displayName,
        kind: "workspace",
        enabledAdapters: [...descriptor.enabledAdapters],
        status: "active",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const decision: ProjectDecision = {
        schemaVersion: "project-decision.v2",
        projectDecisionId: allocated.decisionId,
        projectId: allocated.projectId,
        question: "是否按content-production.v1建立项目与Context Map？",
        options: ["建立", "不建立"],
        choice: "建立",
        rationale: "用户显式创建内容生产项目。",
        decidedByParticipantId: allocated.participantId,
        boundProjectRevision: 1,
        payloadSha256: hashCanonical("project-decision-payload.v1", {
          projectId: allocated.projectId,
          boundProjectRevision: 1,
          question: "是否按content-production.v1建立项目与Context Map？",
          options: ["建立", "不建立"],
          choice: "建立",
          rationale: "用户显式创建内容生产项目。",
        }) as never,
        status: "active",
        commandId: input.commandId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const contextInput = {
        projectId: allocated.projectId,
        methodSnapshotId: allocated.methodId,
        selectors: CONTENT_CONTEXT_SELECTORS,
        historyViews: [
          "当前执行与下一步",
          "待用户审核与决定",
          "阻塞与恢复",
          "按实际日期的发布历史",
          "内容来源与Practice Revision",
          "重复返工与失败",
          "改变后续方法的要求与案例",
        ],
        authorityPolicyVersion: "content-production-authority.v1" as const,
        evidencePolicyVersion: "content-production-evidence.v1" as const,
      };
      const contextMap: ProjectContextMap = {
        schemaVersion: "project-context-map.v1",
        projectContextMapId: allocated.contextMapId,
        ...contextInput,
        status: "active",
        sha256: computeProjectContextMapSha256(contextInput) as never,
        adoptedByDecisionId: allocated.decisionId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.entities.projects[project.projectId] = project;
      draft.entities.projectMethodSnapshots[method.projectMethodSnapshotId] = method;
      draft.entities.projectStages[stage.projectStageId] = stage;
      draft.entities.projectParticipants[participant.projectParticipantId] = participant;
      draft.entities.projectResources[resource.projectResourceId] = resource;
      draft.entities.projectDecisions[decision.projectDecisionId] = decision;
      draft.entities.projectContextMaps[contextMap.projectContextMapId] = contextMap;
      return {
        resultRefs: {
          projectId: project.projectId,
          projectContextMapId: contextMap.projectContextMapId,
        },
      };
    },
  });
  return getProjectWorkspace(deps, {
    principalId: input.principalId,
    projectId: transaction.resultRefs.projectId ?? "",
  });
}

export async function registerProjectAgent(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectId: string;
    readonly expectedProjectRevision: number;
    readonly payload: RegisterProjectAgentPayload;
  },
): Promise<{ project: ProjectWorkspaceDto }> {
  const participantId = requireProjectIds(deps).participant();
  const now = deps.now();
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "RegisterProjectAgent",
    requestSha256: hashCanonical("command.register-project-agent.v1", input),
    mutate: (draft) => {
      const project = ownerProject(draft, input.projectId, input.principalId);
      if (project.revision !== input.expectedProjectRevision)
        throw revisionConflict("Project revision冲突");
      if (
        Object.values(draft.entities.projectParticipants).some(
          (participant) =>
            participant.projectId === project.projectId &&
            participant.kind === "agent" &&
            participant.status === "active" &&
            participant.displayName === input.payload.displayName,
        )
      ) {
        throw revisionConflict("同名Agent Participant已经存在");
      }
      draft.entities.projectParticipants[participantId] = {
        schemaVersion: "project-participant.v1",
        projectParticipantId: participantId,
        projectId: project.projectId,
        kind: "agent",
        displayName: input.payload.displayName,
        role: input.payload.role,
        status: "active",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.entities.projects[project.projectId] = {
        ...project,
        revision: project.revision + 1,
        updatedAt: now,
      };
      return { resultRefs: { projectId: project.projectId, projectParticipantId: participantId } };
    },
  });
  return getProjectWorkspace(deps, { principalId: input.principalId, projectId: input.projectId });
}

export async function createProjectWork(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectId: string;
    readonly expectedProjectRevision: number;
    readonly payload: CreateProjectWorkPayload;
  },
): Promise<{ project: ProjectWorkspaceDto }> {
  const workId = requireProjectIds(deps).work();
  const now = deps.now();
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "CreateProjectWorkV2",
    requestSha256: hashCanonical("command.create-project-work.v2", input),
    mutate: (draft) => {
      const project = ownerProject(draft, input.projectId, input.principalId);
      if (project.revision !== input.expectedProjectRevision)
        throw revisionConflict("Project revision冲突");
      const method = draft.entities.projectMethodSnapshots[project.methodSnapshotId];
      if (method === undefined) throw revisionConflict("Project Method Snapshot不存在");
      if (!method.policies.coordination.workKinds.includes(input.payload.kind)) {
        throw revisionConflict("当前Project Profile不支持该Work kind");
      }
      if (
        Object.values(draft.entities.projectWorks).some(
          (work) => work.projectId === project.projectId && work.workKey === input.payload.workKey,
        )
      ) {
        throw revisionConflict("Work Key已经存在");
      }
      const owner = draft.entities.projectParticipants[input.payload.ownerParticipantId];
      if (owner?.projectId !== project.projectId || owner.status !== "active") {
        throw revisionConflict("Work责任人不属于当前Project或已停用");
      }
      const creator = Object.values(draft.entities.projectParticipants).find(
        (participant) =>
          participant.projectId === project.projectId &&
          participant.kind === "human" &&
          participant.principalId === input.principalId &&
          participant.status === "active",
      );
      if (creator === undefined) throw forbidden("当前用户不是Project中的活动Participant");
      if (
        input.payload.dependsOn.some(
          (id) => draft.entities.projectWorks[id]?.projectId !== project.projectId,
        ) ||
        input.payload.practiceRevisionIds.some(
          (id) => draft.entities.projectPracticeRevisions[id]?.projectId !== project.projectId,
        )
      ) {
        throw revisionConflict("Work依赖或Practice Revision跨Project");
      }
      const common = {
        schemaVersion: "project-work.v2" as const,
        projectWorkId: workId,
        projectId: project.projectId,
        stageId: project.currentStageId,
        workKey: input.payload.workKey,
        title: input.payload.title,
        priority: input.payload.priority ?? "none",
        objective: input.payload.objective,
        acceptanceCriteria: input.payload.acceptanceCriteria,
        dependsOn: input.payload.dependsOn,
        ownerParticipantId: input.payload.ownerParticipantId,
        practiceRevisionIds: input.payload.practiceRevisionIds,
        resourceRefs: input.payload.resourceRefs,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const work: ProjectWork =
        input.payload.kind === "generic"
          ? {
              ...common,
              kind: "generic",
              status: "draft",
            }
          : input.payload.kind === "content_delivery"
            ? {
                ...common,
                kind: "content_delivery",
                status: "intake",
                content: {
                  targetPlatforms: input.payload.targetPlatforms,
                  sourceRef: input.payload.sourceRef,
                  ...(input.payload.seriesKey === undefined
                    ? {}
                    : { seriesKey: input.payload.seriesKey }),
                },
              }
            : {
                ...common,
                kind: "workflow_improvement",
                status: "proposed",
                practice: {
                  practiceKey: input.payload.practiceKey,
                  hypothesis: input.payload.hypothesis,
                },
              };
      draft.entities.projectWorks[work.projectWorkId] = work;
      draft.entities.projects[project.projectId] = {
        ...project,
        revision: project.revision + 1,
        updatedAt: now,
      };
      recordCoordinationEvent(draft, {
        commandId: input.commandId,
        projectId: project.projectId,
        eventType: "work.created",
        subject: { kind: "work", objectId: work.projectWorkId },
        actor: creator,
        principalId: input.principalId,
        occurredAt: now,
        payload: { workKey: work.workKey, kind: work.kind, status: work.status },
      });
      return {
        resultRefs: {
          projectId: project.projectId,
          projectWorkId: work.projectWorkId,
        },
      };
    },
  });
  return getProjectWorkspace(deps, { principalId: input.principalId, projectId: input.projectId });
}

export async function recordProjectEvidence(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectId: string;
    readonly payload: RecordProjectEvidencePayload;
  },
): Promise<{ project: ProjectWorkspaceDto }> {
  const evidenceId = requireProjectIds(deps).evidence();
  const now = deps.now();
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "RecordProjectEvidenceV2",
    requestSha256: hashCanonical("command.record-project-evidence.v2", input),
    mutate: (draft) => {
      const project = ownerProject(draft, input.projectId, input.principalId);
      if (
        input.payload.sourceKind === "project_resource" &&
        (input.payload.resourceId === undefined ||
          draft.entities.projectResources[input.payload.resourceId]?.projectId !==
            project.projectId)
      ) {
        throw revisionConflict("project_resource Evidence缺少当前Project Resource");
      }
      if (
        input.payload.sourceKind !== "project_resource" &&
        input.payload.resourceId !== undefined
      ) {
        throw revisionConflict("非project_resource Evidence不能绑定Resource");
      }
      const work = draft.entities.projectWorks[input.payload.workId];
      if (work?.projectId !== project.projectId || work.revision !== input.payload.workRevision) {
        throw revisionConflict("Evidence必须绑定当前Project内精确的Work Revision");
      }
      draft.entities.projectEvidence[evidenceId] = {
        schemaVersion: "project-evidence.v2",
        projectEvidenceId: evidenceId,
        projectId: project.projectId,
        ...input.payload,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      return { resultRefs: { projectId: project.projectId, projectEvidenceId: evidenceId } };
    },
  });
  return getProjectWorkspace(deps, { principalId: input.principalId, projectId: input.projectId });
}

export async function claimProjectWork(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectId: string;
    readonly workId: string;
    readonly expectedWorkRevision: number;
    readonly payload: ClaimProjectWorkPayload;
  },
): Promise<{ project: ProjectWorkspaceDto }> {
  const ids = requireCoordinationIds(deps);
  const claimId = ids.workClaim();
  const transitionId = ids.stateTransition();
  const now = deps.now();
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "ClaimProjectWork",
    requestSha256: hashCanonical("command.claim-project-work.v1", input),
    mutate: (draft) => {
      const project = ownerProject(draft, input.projectId, input.principalId);
      const work = draft.entities.projectWorks[input.workId];
      if (work?.projectId !== project.projectId) throw notFound("Work不存在");
      if (work.revision !== input.expectedWorkRevision) throw revisionConflict("Work revision冲突");
      const participant = agentParticipant(draft, project, input.payload.participantId);
      const method = draft.entities.projectMethodSnapshots[project.methodSnapshotId];
      if (method === undefined) throw revisionConflict("Project Method Snapshot不存在");
      if (method.policies.coordination.claimPolicy === "disabled") {
        throw revisionConflict("当前Project Profile未启用Agent Claim");
      }
      const claimableStates =
        work.kind === "generic"
          ? ["approved", "in_progress", "blocked"]
          : ["selected", "producing", "experimenting", "blocked"];
      if (!claimableStates.includes(work.status)) {
        throw revisionConflict("当前Work状态不能被Agent认领");
      }
      const existingClaim =
        work.activeClaimId === undefined
          ? undefined
          : draft.entities.projectWorkClaims[work.activeClaimId];
      const existingClaimActive =
        existingClaim?.status === "active" && existingClaim.leaseExpiresAt > now;
      if (existingClaim?.status === "active" && !existingClaimActive) {
        draft.entities.projectWorkClaims[existingClaim.projectWorkClaimId] = {
          ...existingClaim,
          status: "expired",
          releasedAt: now,
          releaseReason: "lease_expired",
          revision: existingClaim.revision + 1,
          updatedAt: now,
        };
      }
      assertProjectWorkClaimAcquisition({
        workKind: work.kind,
        workStatus: work.status,
        participantKind: participant.kind,
        participantStatus: participant.status,
        activeClaimExists: existingClaimActive,
        acquiredAt: now,
        leaseExpiresAt: input.payload.leaseExpiresAt,
      });
      const claim: ProjectWorkClaim = {
        schemaVersion: "project-work-claim.v1",
        projectWorkClaimId: claimId,
        projectId: project.projectId,
        workId: work.projectWorkId,
        participantId: participant.projectParticipantId,
        status: "active",
        acquiredAt: now,
        leaseExpiresAt: input.payload.leaseExpiresAt,
        commandId: input.commandId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const nextStatus =
        work.kind === "generic" && work.status === "approved"
          ? "in_progress"
          : work.status === "selected"
            ? work.kind === "content_delivery"
              ? "producing"
              : "experimenting"
            : work.status;
      const nextWork = parseCoordinatedWork({
        ...work,
        status: nextStatus,
        activeClaimId: claimId,
        revision: work.revision + 1,
        updatedAt: now,
      });
      draft.entities.projectWorkClaims[claimId] = claim;
      draft.entities.projectWorks[work.projectWorkId] = nextWork;
      if (nextStatus !== work.status) {
        draft.entities.projectStateTransitions[transitionId] = {
          schemaVersion: "project-state-transition.v1",
          projectStateTransitionId: transitionId,
          projectId: project.projectId,
          objectType: "work",
          objectId: work.projectWorkId,
          from: work.status,
          to: nextStatus,
          actorParticipantId: participant.projectParticipantId,
          commandId: input.commandId,
          beforeRevision: work.revision,
          afterRevision: nextWork.revision,
          reason: "Agent取得活动Claim并开始执行",
          evidenceIds: [],
          occurredAt: now,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
      }
      recordCoordinationEvent(draft, {
        commandId: input.commandId,
        projectId: project.projectId,
        eventType: "work.claimed",
        subject: { kind: "work", objectId: work.projectWorkId },
        actor: participant,
        principalId: input.principalId,
        occurredAt: now,
        beforeRevision: work.revision,
        afterRevision: nextWork.revision,
        payload: {
          claimId,
          leaseExpiresAt: input.payload.leaseExpiresAt,
          from: work.status,
          to: nextWork.status,
        },
      });
      return {
        resultRefs: {
          projectId: project.projectId,
          projectWorkId: work.projectWorkId,
          projectWorkClaimId: claimId,
        },
      };
    },
  });
  return getProjectWorkspace(deps, { principalId: input.principalId, projectId: input.projectId });
}

export async function blockProjectWork(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectId: string;
    readonly workId: string;
    readonly expectedWorkRevision: number;
    readonly payload: BlockProjectWorkPayload;
  },
): Promise<{ project: ProjectWorkspaceDto }> {
  const ids = requireCoordinationIds(deps);
  const blockId = ids.workBlock();
  const transitionId = ids.stateTransition();
  const now = deps.now();
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "BlockProjectWork",
    requestSha256: hashCanonical("command.block-project-work.v1", input),
    mutate: (draft) => {
      const project = ownerProject(draft, input.projectId, input.principalId);
      const work = draft.entities.projectWorks[input.workId];
      if (work?.projectId !== project.projectId) throw notFound("Work不存在");
      if (work.revision !== input.expectedWorkRevision) throw revisionConflict("Work revision冲突");
      const participant = coordinatedActor(
        draft,
        project,
        input.payload.participantId,
        input.principalId,
      );
      const claim =
        work.activeClaimId === undefined
          ? undefined
          : draft.entities.projectWorkClaims[work.activeClaimId];
      if (
        participant.kind === "agent" &&
        !isUsableClaim(claim, participant.projectParticipantId, now)
      ) {
        throw forbidden("只有持有活动Claim的Agent能阻塞Work");
      }
      const blockableStates =
        work.kind === "generic"
          ? ["approved", "in_progress", "review"]
          : ["selected", "producing", "experimenting", "needs_review", "ready"];
      if (!blockableStates.includes(work.status)) {
        throw revisionConflict("当前Work状态不能进入Blocked");
      }
      assertProjectWorkTransition({
        kind: work.kind,
        from: work.status,
        to: "blocked",
        actorKind: participant.kind === "agent" ? "agent" : "human",
        hasActiveClaim:
          participant.kind === "agent" &&
          isUsableClaim(claim, participant.projectParticipantId, now),
        evidenceRoles: [],
        hasConfirmedPublicationOutcome: false,
        hasPracticeRevisionEvidence: false,
      });
      const previousState = projectRecoverableWorkStateSchema.parse(work.status);
      const block: ProjectWorkBlock = {
        schemaVersion: "project-work-block.v1",
        projectWorkBlockId: blockId,
        projectId: project.projectId,
        workId: work.projectWorkId,
        previousState,
        reason: input.payload.reason,
        stoppedAt: input.payload.stoppedAt,
        recoveryConditions: input.payload.recoveryConditions,
        reportedByParticipantId: participant.projectParticipantId,
        status: "active",
        resolvedEvidenceIds: [],
        commandId: input.commandId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const nextWork = parseCoordinatedWork({
        ...work,
        status: "blocked",
        activeBlockId: blockId,
        revision: work.revision + 1,
        updatedAt: now,
      });
      draft.entities.projectWorkBlocks[blockId] = block;
      draft.entities.projectWorks[work.projectWorkId] = nextWork;
      draft.entities.projectStateTransitions[transitionId] = workTransition({
        id: transitionId,
        projectId: project.projectId,
        work,
        nextWork,
        actorParticipantId: participant.projectParticipantId,
        commandId: input.commandId,
        reason: input.payload.reason,
        evidenceIds: [],
        now,
      });
      recordCoordinationEvent(draft, {
        commandId: input.commandId,
        projectId: project.projectId,
        eventType: "work.blocked",
        subject: { kind: "block", objectId: blockId },
        actor: participant,
        principalId: input.principalId,
        occurredAt: now,
        payload: {
          workId: work.projectWorkId,
          previousState,
          reason: input.payload.reason,
          recoveryConditions: input.payload.recoveryConditions,
        },
      });
      return {
        resultRefs: {
          projectId: project.projectId,
          projectWorkId: work.projectWorkId,
          projectWorkBlockId: blockId,
        },
      };
    },
  });
  return getProjectWorkspace(deps, { principalId: input.principalId, projectId: input.projectId });
}

export async function resumeProjectWork(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectId: string;
    readonly workId: string;
    readonly expectedWorkRevision: number;
    readonly payload: ResumeProjectWorkPayload;
  },
): Promise<{ project: ProjectWorkspaceDto }> {
  const transitionId = requireCoordinationIds(deps).stateTransition();
  const now = deps.now();
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "ResumeProjectWork",
    requestSha256: hashCanonical("command.resume-project-work.v1", input),
    mutate: (draft) => {
      const project = ownerProject(draft, input.projectId, input.principalId);
      const work = draft.entities.projectWorks[input.workId];
      if (work?.projectId !== project.projectId) throw notFound("Work不存在");
      if (
        work.revision !== input.expectedWorkRevision ||
        work.status !== "blocked" ||
        work.activeBlockId === undefined
      ) {
        throw revisionConflict("Work不是当前Revision的Blocked状态");
      }
      const participant = coordinatedActor(
        draft,
        project,
        input.payload.participantId,
        input.principalId,
      );
      const claim =
        work.activeClaimId === undefined
          ? undefined
          : draft.entities.projectWorkClaims[work.activeClaimId];
      if (
        participant.kind === "agent" &&
        !isUsableClaim(claim, participant.projectParticipantId, now)
      ) {
        throw forbidden("只有持有活动Claim的Agent能恢复Work");
      }
      const block = draft.entities.projectWorkBlocks[work.activeBlockId];
      if (block?.status !== "active") throw revisionConflict("活动Block不存在");
      evidenceForWork(draft, work, input.payload.recoveryEvidenceIds);
      assertProjectWorkResume({
        kind: work.kind,
        previousState: block.previousState,
        targetState: block.previousState,
        recoveryEvidenceIds: input.payload.recoveryEvidenceIds,
      });
      const claimExpired = claim?.status === "active" && claim.leaseExpiresAt <= now;
      if (claimExpired) {
        draft.entities.projectWorkClaims[claim.projectWorkClaimId] = {
          ...claim,
          status: "expired",
          releasedAt: now,
          releaseReason: "lease_expired",
          revision: claim.revision + 1,
          updatedAt: now,
        };
      }
      const workWithoutBlock = structuredClone(work);
      delete workWithoutBlock.activeBlockId;
      const workWithoutExpiredClaim = structuredClone(workWithoutBlock);
      delete workWithoutExpiredClaim.activeClaimId;
      const nextWork = parseCoordinatedWork({
        ...(claimExpired ? workWithoutExpiredClaim : workWithoutBlock),
        status: block.previousState,
        revision: work.revision + 1,
        updatedAt: now,
      });
      draft.entities.projectWorkBlocks[block.projectWorkBlockId] = {
        ...block,
        status: "resolved",
        resolutionKind: "recovered",
        resolvedByParticipantId: participant.projectParticipantId,
        resolvedEvidenceIds: input.payload.recoveryEvidenceIds,
        resolvedAt: now,
        revision: block.revision + 1,
        updatedAt: now,
      };
      draft.entities.projectWorks[work.projectWorkId] = nextWork;
      draft.entities.projectStateTransitions[transitionId] = workTransition({
        id: transitionId,
        projectId: project.projectId,
        work,
        nextWork,
        actorParticipantId: participant.projectParticipantId,
        commandId: input.commandId,
        reason: "恢复条件已满足，回到Block记录的原State",
        evidenceIds: input.payload.recoveryEvidenceIds,
        now,
      });
      recordCoordinationEvent(draft, {
        commandId: input.commandId,
        projectId: project.projectId,
        eventType: "work.resumed",
        subject: { kind: "work", objectId: work.projectWorkId },
        actor: participant,
        principalId: input.principalId,
        occurredAt: now,
        beforeRevision: work.revision,
        afterRevision: nextWork.revision,
        evidenceIds: input.payload.recoveryEvidenceIds,
        payload: { blockId: block.projectWorkBlockId, restoredState: block.previousState },
      });
      return {
        resultRefs: {
          projectId: project.projectId,
          projectWorkId: work.projectWorkId,
          projectWorkBlockId: block.projectWorkBlockId,
        },
      };
    },
  });
  return getProjectWorkspace(deps, { principalId: input.principalId, projectId: input.projectId });
}

export async function requestProjectWorkReview(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectId: string;
    readonly workId: string;
    readonly expectedWorkRevision: number;
    readonly payload: RequestProjectWorkReviewPayload;
  },
): Promise<{ project: ProjectWorkspaceDto }> {
  const ids = requireCoordinationIds(deps);
  const transitionId = ids.stateTransition();
  const contributionId = ids.contribution();
  const now = deps.now();
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "RequestProjectWorkReview",
    requestSha256: hashCanonical("command.request-project-work-review.v1", input),
    mutate: (draft) => {
      const project = ownerProject(draft, input.projectId, input.principalId);
      const work = draft.entities.projectWorks[input.workId];
      if (work?.projectId !== project.projectId) throw notFound("Work不存在");
      if (work.revision !== input.expectedWorkRevision) throw revisionConflict("Work revision冲突");
      const participant = agentParticipant(draft, project, input.payload.participantId);
      const claim =
        work.activeClaimId === undefined
          ? undefined
          : draft.entities.projectWorkClaims[work.activeClaimId];
      if (!isUsableClaim(claim, participant.projectParticipantId, now)) {
        throw forbidden("只有持有活动Claim的Agent能请求审核");
      }
      const evidence = evidenceForWork(draft, work, input.payload.evidenceIds);
      assertProjectWorkTransition({
        kind: work.kind,
        from: work.status,
        to: work.kind === "generic" ? "review" : "needs_review",
        actorKind: "agent",
        hasActiveClaim: true,
        evidenceRoles: evidence.map((item) => item.role),
        hasConfirmedPublicationOutcome: false,
        hasPracticeRevisionEvidence: evidence.some((item) => item.role === "practice_revision"),
      });
      const workWithoutClaim = structuredClone(work);
      delete workWithoutClaim.activeClaimId;
      const nextWork = parseCoordinatedWork({
        ...workWithoutClaim,
        status: work.kind === "generic" ? "review" : "needs_review",
        revision: work.revision + 1,
        updatedAt: now,
      });
      draft.entities.projectWorkClaims[claim.projectWorkClaimId] = {
        ...claim,
        status: "released",
        releasedAt: now,
        releaseReason: "review_requested",
        revision: claim.revision + 1,
        updatedAt: now,
      };
      draft.entities.projectWorks[work.projectWorkId] = nextWork;
      draft.entities.projectContributions[contributionId] = {
        schemaVersion: "project-contribution.v1",
        projectContributionId: contributionId,
        projectId: project.projectId,
        participantId: participant.projectParticipantId,
        workId: work.projectWorkId,
        kind: "review",
        summary: input.payload.summary,
        evidenceStatus: evidence.every((item) => item.verification !== "reported")
          ? "verified"
          : "reported",
        evidenceIds: input.payload.evidenceIds,
        occurredAt: now,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.entities.projectStateTransitions[transitionId] = workTransition({
        id: transitionId,
        projectId: project.projectId,
        work,
        nextWork,
        actorParticipantId: participant.projectParticipantId,
        commandId: input.commandId,
        reason: input.payload.summary,
        evidenceIds: input.payload.evidenceIds,
        now,
      });
      recordCoordinationEvent(draft, {
        commandId: input.commandId,
        projectId: project.projectId,
        eventType: "work.review-requested",
        subject: { kind: "review", objectId: contributionId, revision: 1 },
        actor: participant,
        principalId: input.principalId,
        occurredAt: now,
        evidenceIds: input.payload.evidenceIds,
        payload: { workId: work.projectWorkId, summary: input.payload.summary },
      });
      return {
        resultRefs: {
          projectId: project.projectId,
          projectWorkId: work.projectWorkId,
          projectContributionId: contributionId,
        },
      };
    },
  });
  return getProjectWorkspace(deps, { principalId: input.principalId, projectId: input.projectId });
}

export async function handoffProjectWork(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectId: string;
    readonly workId: string;
    readonly expectedWorkRevision: number;
    readonly payload: HandoffProjectWorkPayload;
  },
): Promise<{ project: ProjectWorkspaceDto }> {
  const handoffId = requireCoordinationIds(deps).workHandoff();
  const now = deps.now();
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "HandoffProjectWork",
    requestSha256: hashCanonical("command.handoff-project-work.v1", input),
    mutate: (draft) => {
      const project = ownerProject(draft, input.projectId, input.principalId);
      const work = draft.entities.projectWorks[input.workId];
      if (work?.projectId !== project.projectId || work.activeClaimId === undefined)
        throw notFound("活动Work Claim不存在");
      if (work.revision !== input.expectedWorkRevision) throw revisionConflict("Work revision冲突");
      const from = agentParticipant(draft, project, input.payload.fromParticipantId);
      if (input.payload.toParticipantId !== undefined)
        agentParticipant(draft, project, input.payload.toParticipantId);
      evidenceForWork(draft, work, input.payload.evidenceIds);
      const claim = draft.entities.projectWorkClaims[work.activeClaimId];
      if (!isUsableClaim(claim, from.projectParticipantId, now)) {
        throw revisionConflict("活动Claim不存在或租约已过期");
      }
      assertProjectWorkHandoff({
        claimStatus: claim.status,
        claimParticipantId: claim.participantId,
        fromParticipantId: from.projectParticipantId,
        remaining: input.payload.remaining,
        nextStep: input.payload.nextStep,
      });
      const handoff: ProjectWorkHandoff = {
        schemaVersion: "project-work-handoff.v1",
        projectWorkHandoffId: handoffId,
        projectId: project.projectId,
        workId: work.projectWorkId,
        fromClaimId: claim.projectWorkClaimId,
        fromParticipantId: from.projectParticipantId,
        ...(input.payload.toParticipantId === undefined
          ? {}
          : { toParticipantId: input.payload.toParticipantId }),
        completed: input.payload.completed,
        remaining: input.payload.remaining,
        risks: input.payload.risks,
        nextStep: input.payload.nextStep,
        requiredReads: input.payload.requiredReads,
        evidenceIds: input.payload.evidenceIds,
        commandId: input.commandId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.entities.projectWorkHandoffs[handoffId] = handoff;
      draft.entities.projectWorkClaims[claim.projectWorkClaimId] = {
        ...claim,
        status: "released",
        releasedAt: now,
        releaseReason: "handoff",
        handoffId,
        revision: claim.revision + 1,
        updatedAt: now,
      };
      const workWithoutClaim = structuredClone(work);
      delete workWithoutClaim.activeClaimId;
      draft.entities.projectWorks[work.projectWorkId] = parseCoordinatedWork({
        ...workWithoutClaim,
        revision: work.revision + 1,
        updatedAt: now,
      });
      recordCoordinationEvent(draft, {
        commandId: input.commandId,
        projectId: project.projectId,
        eventType: "work.handed-off",
        subject: { kind: "handoff", objectId: handoffId, revision: handoff.revision },
        actor: from,
        principalId: input.principalId,
        occurredAt: now,
        evidenceIds: input.payload.evidenceIds,
        payload: {
          workId: work.projectWorkId,
          fromParticipantId: from.projectParticipantId,
          toParticipantId: input.payload.toParticipantId,
          remaining: input.payload.remaining,
          nextStep: input.payload.nextStep,
        },
      });
      return {
        resultRefs: {
          projectId: project.projectId,
          projectWorkId: work.projectWorkId,
          projectWorkHandoffId: handoffId,
        },
      };
    },
  });
  return getProjectWorkspace(deps, { principalId: input.principalId, projectId: input.projectId });
}

export async function decideProjectWorkTransition(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectId: string;
    readonly workId: string;
    readonly expectedWorkRevision: number;
    readonly payload: DecideProjectWorkTransitionPayload;
  },
): Promise<{ project: ProjectWorkspaceDto }> {
  const ids = requireCoordinationIds(deps);
  const decisionId = ids.decision();
  const transitionId = ids.stateTransition();
  const now = deps.now();
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "DecideProjectWorkTransition",
    requestSha256: hashCanonical("command.decide-project-work-transition.v1", input),
    mutate: (draft) => {
      const project = ownerProject(draft, input.projectId, input.principalId);
      const work = draft.entities.projectWorks[input.workId];
      if (work?.projectId !== project.projectId) throw notFound("Work不存在");
      if (work.revision !== input.expectedWorkRevision) throw revisionConflict("Work revision冲突");
      const actor = humanActor(
        draft,
        project,
        input.payload.decidedByParticipantId,
        input.principalId,
      );
      const evidence = evidenceForWork(draft, work, input.payload.evidenceIds);
      const method = draft.entities.projectMethodSnapshots[project.methodSnapshotId];
      if (method === undefined) throw revisionConflict("Project Method Snapshot不存在");
      if (work.kind === "generic" && input.payload.targetState === "done") {
        const requiredRoles =
          method.profileId === "software-delivery.v1" ? (["commit", "test"] as const) : [];
        const evidenceRoles = new Set(evidence.map((item) => item.role));
        if (requiredRoles.some((role) => !evidenceRoles.has(role))) {
          throw revisionConflict("软件交付Work完成必须同时引用commit和test Evidence");
        }
      }
      if (
        input.payload.targetState === "ready" &&
        evidence.some(
          (item) =>
            ["content_revision", "qc_report"].includes(item.role) &&
            item.verification === "reported",
        )
      ) {
        throw revisionConflict("Ready所需content_revision和qc_report不能只是Agent自报");
      }
      const hasPublication =
        work.kind === "content_delivery" &&
        work.content.targetPlatforms.every((platform) =>
          Object.values(draft.entities.projectWorkOutcomes).some(
            (outcome) =>
              outcome.workId === work.projectWorkId &&
              outcome.platform === platform &&
              outcome.status === "confirmed",
          ),
        );
      assertProjectWorkTransition({
        kind: work.kind,
        from: work.status,
        to: input.payload.targetState,
        actorKind: "human",
        hasActiveClaim: work.activeClaimId !== undefined,
        decisionId,
        evidenceRoles: evidence.map((item) => item.role),
        hasConfirmedPublicationOutcome: hasPublication,
        hasPracticeRevisionEvidence: false,
      });
      const decision: ProjectDecision = {
        schemaVersion: "project-decision.v2",
        projectDecisionId: decisionId,
        projectId: project.projectId,
        question: `是否把Work从${work.status}转换为${input.payload.targetState}？`,
        options: [input.payload.targetState],
        choice: input.payload.targetState,
        rationale: input.payload.rationale,
        decidedByParticipantId: actor.projectParticipantId,
        boundProjectRevision: project.revision,
        boundWorkId: work.projectWorkId,
        boundWorkRevision: work.revision,
        payloadSha256: hashCanonical("project-decision-payload.v1", {
          projectId: project.projectId,
          boundProjectRevision: project.revision,
          boundWorkId: work.projectWorkId,
          boundWorkRevision: work.revision,
          question: `是否把Work从${work.status}转换为${input.payload.targetState}？`,
          options: [input.payload.targetState],
          choice: input.payload.targetState,
          rationale: input.payload.rationale,
        }) as never,
        status: "active",
        commandId: input.commandId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const terminal = ["done", "cancelled", "published", "dropped", "rejected"].includes(
        input.payload.targetState,
      );
      const workWithoutExecutionLocks = structuredClone(work);
      delete workWithoutExecutionLocks.activeClaimId;
      delete workWithoutExecutionLocks.activeBlockId;
      const nextWork = parseCoordinatedWork({
        ...(terminal ? workWithoutExecutionLocks : work),
        status: input.payload.targetState,
        ...(terminal ? { resolutionDecisionId: decisionId } : {}),
        revision: work.revision + 1,
        updatedAt: now,
      });
      if (terminal && work.activeClaimId !== undefined) {
        const claim = draft.entities.projectWorkClaims[work.activeClaimId];
        if (claim?.status === "active") {
          draft.entities.projectWorkClaims[claim.projectWorkClaimId] = {
            ...claim,
            status: "revoked",
            releasedAt: now,
            releaseReason: "terminal_resolution",
            revision: claim.revision + 1,
            updatedAt: now,
          };
        }
      }
      if (terminal && work.activeBlockId !== undefined) {
        const block = draft.entities.projectWorkBlocks[work.activeBlockId];
        if (block?.status !== "active") throw revisionConflict("Work引用的活动Block不存在");
        draft.entities.projectWorkBlocks[block.projectWorkBlockId] = {
          ...block,
          status: "resolved",
          resolutionKind: "terminal",
          resolutionDecisionId: decisionId,
          resolvedByParticipantId: actor.projectParticipantId,
          resolvedEvidenceIds: input.payload.evidenceIds,
          resolvedAt: now,
          revision: block.revision + 1,
          updatedAt: now,
        };
      }
      draft.entities.projectDecisions[decisionId] = decision;
      draft.entities.projectWorks[work.projectWorkId] = nextWork;
      draft.entities.projectStateTransitions[transitionId] = workTransition({
        id: transitionId,
        projectId: project.projectId,
        work,
        nextWork,
        actorParticipantId: actor.projectParticipantId,
        commandId: input.commandId,
        reason: input.payload.rationale,
        decisionId,
        evidenceIds: input.payload.evidenceIds,
        now,
      });
      recordCoordinationEvent(draft, {
        commandId: input.commandId,
        projectId: project.projectId,
        eventType: "work.transition-decided",
        subject: { kind: "work", objectId: work.projectWorkId },
        actor,
        principalId: input.principalId,
        occurredAt: now,
        beforeRevision: work.revision,
        afterRevision: nextWork.revision,
        evidenceIds: input.payload.evidenceIds,
        payload: {
          decisionId,
          from: work.status,
          to: nextWork.status,
          rationale: input.payload.rationale,
        },
      });
      return {
        resultRefs: {
          projectId: project.projectId,
          projectWorkId: work.projectWorkId,
          projectDecisionId: decisionId,
        },
      };
    },
  });
  return getProjectWorkspace(deps, { principalId: input.principalId, projectId: input.projectId });
}

export async function recordContentPublication(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectId: string;
    readonly workId: string;
    readonly expectedWorkRevision: number;
    readonly payload: RecordContentPublicationPayload;
  },
): Promise<{ project: ProjectWorkspaceDto }> {
  const ids = requireCoordinationIds(deps);
  const outcomeId = ids.workOutcome();
  const decisionId = ids.decision();
  const now = deps.now();
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "RecordContentPublication",
    requestSha256: hashCanonical("command.record-content-publication.v1", input),
    mutate: (draft) => {
      const project = ownerProject(draft, input.projectId, input.principalId);
      const work = draft.entities.projectWorks[input.workId];
      if (work?.projectId !== project.projectId || work.kind !== "content_delivery")
        throw notFound("Content Work不存在");
      if (work.revision !== input.expectedWorkRevision || work.status !== "ready") {
        throw revisionConflict("只有当前Revision的Ready Work能记录发布结果");
      }
      const actor = humanActor(
        draft,
        project,
        input.payload.decidedByParticipantId,
        input.principalId,
      );
      if (!work.content.targetPlatforms.includes(input.payload.platform))
        throw revisionConflict("发布平台不在Work目标范围");
      if (
        Object.values(draft.entities.projectWorkOutcomes).some(
          (outcome) =>
            outcome.workId === work.projectWorkId &&
            outcome.platform === input.payload.platform &&
            outcome.status === "confirmed",
        )
      ) {
        throw revisionConflict("该平台已经存在confirmed Publication Outcome");
      }
      const contentEvidence =
        draft.entities.projectEvidence[input.payload.contentRevisionEvidenceId];
      const publicationEvidence =
        draft.entities.projectEvidence[input.payload.publicationEvidenceId];
      if (
        contentEvidence?.projectId !== project.projectId ||
        contentEvidence.workId !== work.projectWorkId ||
        contentEvidence.workRevision === undefined ||
        contentEvidence.workRevision > work.revision ||
        contentEvidence.role !== "content_revision" ||
        publicationEvidence?.projectId !== project.projectId ||
        publicationEvidence.workId !== work.projectWorkId ||
        publicationEvidence.workRevision === undefined ||
        publicationEvidence.workRevision > work.revision ||
        publicationEvidence.role !== "publication_receipt" ||
        publicationEvidence.verification !== "verified"
      ) {
        throw revisionConflict("Publication Outcome缺少精确内容版本或verified发布回执");
      }
      const decision: ProjectDecision = {
        schemaVersion: "project-decision.v2",
        projectDecisionId: decisionId,
        projectId: project.projectId,
        question: `是否确认${input.payload.platform}发布结果？`,
        options: ["确认", "不确认"],
        choice: "确认",
        rationale: input.payload.rationale,
        decidedByParticipantId: actor.projectParticipantId,
        boundProjectRevision: project.revision,
        boundWorkId: work.projectWorkId,
        boundWorkRevision: work.revision,
        payloadSha256: hashCanonical("project-decision-payload.v1", {
          projectId: project.projectId,
          boundProjectRevision: project.revision,
          boundWorkId: work.projectWorkId,
          boundWorkRevision: work.revision,
          question: `是否确认${input.payload.platform}发布结果？`,
          options: ["确认", "不确认"],
          choice: "确认",
          rationale: input.payload.rationale,
        }) as never,
        status: "active",
        commandId: input.commandId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const outcome: ProjectWorkOutcome = {
        schemaVersion: "project-work-outcome.v1",
        projectWorkOutcomeId: outcomeId,
        projectId: project.projectId,
        workId: work.projectWorkId,
        kind: "content_publication",
        platform: input.payload.platform,
        contentRevisionEvidenceId: input.payload.contentRevisionEvidenceId,
        publicationEvidenceId: input.payload.publicationEvidenceId,
        ...(input.payload.externalContentId === undefined
          ? {}
          : { externalContentId: input.payload.externalContentId }),
        ...(input.payload.url === undefined ? {} : { url: input.payload.url }),
        publishedAt: input.payload.publishedAt,
        status: "confirmed",
        verification: input.payload.verification,
        decisionId,
        commandId: input.commandId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.entities.projectDecisions[decisionId] = decision;
      draft.entities.projectWorkOutcomes[outcomeId] = outcome;
      return {
        resultRefs: {
          projectId: project.projectId,
          projectWorkId: work.projectWorkId,
          projectWorkOutcomeId: outcomeId,
          projectDecisionId: decisionId,
        },
      };
    },
  });
  return getProjectWorkspace(deps, { principalId: input.principalId, projectId: input.projectId });
}

export async function adoptProjectPractice(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectId: string;
    readonly workId: string;
    readonly expectedWorkRevision: number;
    readonly payload: AdoptProjectPracticePayload;
  },
): Promise<{ project: ProjectWorkspaceDto }> {
  const ids = requireCoordinationIds(deps);
  const practiceRevisionId = ids.practiceRevision();
  const decisionId = ids.decision();
  const transitionId = ids.stateTransition();
  const now = deps.now();
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "AdoptProjectPractice",
    requestSha256: hashCanonical("command.adopt-project-practice.v1", input),
    mutate: (draft) => {
      const project = ownerProject(draft, input.projectId, input.principalId);
      const work = draft.entities.projectWorks[input.workId];
      if (work?.projectId !== project.projectId || work.kind !== "workflow_improvement")
        throw notFound("Workflow Improvement Work不存在");
      if (work.revision !== input.expectedWorkRevision || work.status !== "needs_review") {
        throw revisionConflict("只有当前Revision的Needs Review方法Work能被采用");
      }
      const actor = humanActor(
        draft,
        project,
        input.payload.decidedByParticipantId,
        input.principalId,
      );
      const artifactEvidence = draft.entities.projectEvidence[input.payload.artifactEvidenceId];
      if (
        artifactEvidence?.projectId !== project.projectId ||
        artifactEvidence.workId !== work.projectWorkId ||
        artifactEvidence.workRevision === undefined ||
        artifactEvidence.workRevision > work.revision ||
        artifactEvidence.role !== "practice_revision" ||
        artifactEvidence.verification === "reported"
      ) {
        throw revisionConflict("Practice采用需要observed或verified的practice_revision Evidence");
      }
      const prior =
        input.payload.supersedesRevisionId === undefined
          ? undefined
          : draft.entities.projectPracticeRevisions[input.payload.supersedesRevisionId];
      const currentPractice = Object.values(draft.entities.projectPracticeRevisions).find(
        (item) =>
          item.projectId === project.projectId &&
          item.practiceKey === work.practice.practiceKey &&
          item.status === "adopted",
      );
      if (
        (currentPractice === undefined) !== (input.payload.supersedesRevisionId === undefined) ||
        (currentPractice !== undefined &&
          currentPractice.projectPracticeRevisionId !== input.payload.supersedesRevisionId)
      ) {
        throw revisionConflict("Practice存在当前版本时必须显式且精确声明supersedesRevisionId");
      }
      if (
        prior !== undefined &&
        (prior.projectId !== project.projectId ||
          prior.practiceKey !== work.practice.practiceKey ||
          prior.status !== "adopted")
      ) {
        throw revisionConflict("被替代的Practice Revision无效");
      }
      const version =
        Math.max(
          0,
          ...Object.values(draft.entities.projectPracticeRevisions)
            .filter(
              (item) =>
                item.projectId === project.projectId &&
                item.practiceKey === work.practice.practiceKey,
            )
            .map((item) => item.version),
        ) + 1;
      const decision: ProjectDecision = {
        schemaVersion: "project-decision.v2",
        projectDecisionId: decisionId,
        projectId: project.projectId,
        question: `是否采用${work.practice.practiceKey}@${version}？`,
        options: ["采用", "拒绝"],
        choice: "采用",
        rationale: input.payload.rationale,
        decidedByParticipantId: actor.projectParticipantId,
        boundProjectRevision: project.revision,
        boundWorkId: work.projectWorkId,
        boundWorkRevision: work.revision,
        payloadSha256: hashCanonical("project-decision-payload.v1", {
          projectId: project.projectId,
          boundProjectRevision: project.revision,
          boundWorkId: work.projectWorkId,
          boundWorkRevision: work.revision,
          question: `是否采用${work.practice.practiceKey}@${version}？`,
          options: ["采用", "拒绝"],
          choice: "采用",
          rationale: input.payload.rationale,
        }) as never,
        status: "active",
        commandId: input.commandId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const practiceHashInput = {
        projectId: project.projectId,
        practiceKey: work.practice.practiceKey,
        version,
        title: input.payload.title,
        applicableWorkKinds: input.payload.applicableWorkKinds,
        artifactEvidenceId: input.payload.artifactEvidenceId,
        adoptionDecisionId: decisionId,
        ...(input.payload.supersedesRevisionId === undefined
          ? {}
          : { supersedesRevisionId: input.payload.supersedesRevisionId }),
      };
      const practice: ProjectPracticeRevision = {
        schemaVersion: "project-practice-revision.v1",
        projectPracticeRevisionId: practiceRevisionId,
        ...practiceHashInput,
        status: "adopted",
        sha256: computeProjectPracticeRevisionSha256(practiceHashInput) as never,
        adoptedAt: now,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      if (prior !== undefined) {
        draft.entities.projectPracticeRevisions[prior.projectPracticeRevisionId] = {
          ...prior,
          status: "superseded",
          supersededByRevisionId: practiceRevisionId,
          revision: prior.revision + 1,
          updatedAt: now,
        };
      }
      const nextWork = parseCoordinatedWork({
        ...work,
        status: "adopted",
        resolutionDecisionId: decisionId,
        practiceRevisionIds: [...work.practiceRevisionIds, practiceRevisionId],
        revision: work.revision + 1,
        updatedAt: now,
      });
      draft.entities.projectDecisions[decisionId] = decision;
      draft.entities.projectPracticeRevisions[practiceRevisionId] = practice;
      draft.entities.projectWorks[work.projectWorkId] = nextWork;
      draft.entities.projectStateTransitions[transitionId] = workTransition({
        id: transitionId,
        projectId: project.projectId,
        work,
        nextWork,
        actorParticipantId: actor.projectParticipantId,
        commandId: input.commandId,
        reason: input.payload.rationale,
        decisionId,
        evidenceIds: [input.payload.artifactEvidenceId],
        now,
      });
      return {
        resultRefs: {
          projectId: project.projectId,
          projectWorkId: work.projectWorkId,
          projectPracticeRevisionId: practiceRevisionId,
          projectDecisionId: decisionId,
        },
      };
    },
  });
  return getProjectWorkspace(deps, { principalId: input.principalId, projectId: input.projectId });
}

function workTransition(input: {
  readonly id: ProjectStateTransition["projectStateTransitionId"];
  readonly projectId: ProjectStateTransition["projectId"];
  readonly work: ProjectWork;
  readonly nextWork: ProjectWork;
  readonly actorParticipantId: ProjectParticipant["projectParticipantId"];
  readonly commandId: CommandId;
  readonly reason: string;
  readonly decisionId?: ProjectDecision["projectDecisionId"] | undefined;
  readonly evidenceIds: readonly ProjectEvidence["projectEvidenceId"][];
  readonly now: string;
}): Extract<ProjectStateTransition, { objectType: "work" }> {
  return {
    schemaVersion: "project-state-transition.v1",
    projectStateTransitionId: input.id,
    projectId: input.projectId,
    objectType: "work",
    objectId: input.work.projectWorkId,
    from: input.work.status,
    to: input.nextWork.status,
    actorParticipantId: input.actorParticipantId,
    commandId: input.commandId,
    beforeRevision: input.work.revision,
    afterRevision: input.nextWork.revision,
    reason: input.reason,
    ...(input.decisionId === undefined ? {} : { decisionId: input.decisionId }),
    evidenceIds: [...input.evidenceIds],
    occurredAt: input.now,
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
}
