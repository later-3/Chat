import {
  projectConfigurationRevisionSchema,
  projectEventSchema,
  projectProfileRevisionSchema,
  type CommandId,
  type CreateManagedProjectPayload,
  type PrincipalId,
  type Project,
  type ProjectDecision,
  type ProjectMethodSnapshot,
  type ProjectParticipant,
  type ProjectResource,
  type ProjectStage,
  type ProjectWorkspaceDto,
} from "@chat/contracts";
import {
  compileBuiltInProjectProfileRevision,
  compileProjectMethodSnapshotPolicies,
  computeProjectConfigurationRevisionSha256,
  computeProjectDecisionPayloadSha256,
  computeProjectMethodSnapshotSha256,
  hashCanonical,
  type BuiltInProjectProfileKey,
} from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import { notFound, revisionConflict } from "./errors.js";
import { getProjectWorkspace } from "./project-use-cases/queries.js";
import { requireProjectIds, requireProjectRoots } from "./project-use-cases/shared.js";

const PROFILE_METHOD = {
  "software-delivery": "software-delivery.v1",
  "content-production": "content-production.v1",
  learning: "small-project.v1",
  "personal-journal": "lightweight.v1",
} as const satisfies Record<BuiltInProjectProfileKey, string>;

function derivedId(prefix: string, domain: string, input: unknown): string {
  return `${prefix}_${hashCanonical(domain, input).slice(0, 24)}`;
}

/**
 * 用户已经明确Project目标、Profile和首个Configuration时，不再强制走模型Intake。
 * 一个命令原子提交Project、Workspace Resource、用户Participant、Profile、Configuration、
 * Decision和Event；后续所有View与Agent Context都从这些同一事实编译。
 */
export async function createManagedProject(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly payload: CreateManagedProjectPayload;
  },
): Promise<{ project: ProjectWorkspaceDto }> {
  if (
    new Set(
      input.payload.presentationBindings.map((binding) => `${binding.capability}\0${binding.mode}`),
    ).size !== input.payload.presentationBindings.length ||
    new Set(input.payload.requiredReads).size !== input.payload.requiredReads.length
  ) {
    throw revisionConflict("Presentation capability/mode或Required Read不能重复");
  }
  const descriptor = requireProjectRoots(deps)
    .list()
    .find((root) => root.rootId === input.payload.rootId);
  if (descriptor === undefined) throw notFound("受管Project Root不存在");
  const ids = requireProjectIds(deps);
  const allocated = {
    projectId: ids.project(),
    methodId: ids.methodSnapshot(),
    stageId: ids.stage(),
    participantId: ids.participant(),
    resourceId: ids.resource(),
    decisionId: ids.decision(),
  };
  const now = deps.now();
  const profileKey = input.payload.profileKey as BuiltInProjectProfileKey;
  const profile = projectProfileRevisionSchema.parse(
    compileBuiltInProjectProfileRevision({ profileKey, now }),
  );
  const configurationId = derivedId("pcf", "id.managed-project-configuration.v1", {
    commandId: input.commandId,
    projectId: allocated.projectId,
  });
  const eventId = derivedId("pev", "id.managed-project-created-event.v1", {
    commandId: input.commandId,
    projectId: allocated.projectId,
  });
  const requestSha256 = hashCanonical("command.create-managed-project.v1", input);
  const transaction = await deps.store.transact({
    commandId: input.commandId,
    commandType: "CreateManagedProject",
    requestSha256,
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

      const methodProfileId = PROFILE_METHOD[profileKey];
      if (methodProfileId === undefined) throw notFound(`内置Project Profile不存在:${profileKey}`);
      const policies = compileProjectMethodSnapshotPolicies(methodProfileId);
      const rationale = `用户显式选择${profileKey} Profile；Workspace中的代码或文档形态不改变项目业务类型。`;
      const project: Project = {
        schemaVersion: "project.v2",
        projectId: allocated.projectId,
        ownerPrincipalId: input.principalId,
        name: input.payload.name,
        summary: input.payload.summary,
        goal: input.payload.objective,
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
        profileId: methodProfileId as ProjectMethodSnapshot["profileId"],
        rationale,
        policies,
        source: "user_tailored",
        sha256: computeProjectMethodSnapshotSha256({
          profileId: methodProfileId,
          rationale,
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
        key: "initial-stage",
        name: input.payload.initialStage.name,
        goal: input.payload.initialStage.goal,
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
      const decisionShape = {
        projectId: allocated.projectId,
        boundProjectRevision: 1,
        question: `是否创建Project并采用${profileKey}管理配置？`,
        options: ["create", "cancel"],
        choice: "create",
        rationale: "用户显式要求创建并开始持续使用该项目。",
      };
      const decision: ProjectDecision = {
        schemaVersion: "project-decision.v2",
        projectDecisionId: allocated.decisionId,
        ...decisionShape,
        decidedByParticipantId: allocated.participantId,
        payloadSha256: computeProjectDecisionPayloadSha256(decisionShape) as never,
        status: "active",
        commandId: input.commandId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const configurationHashInput = {
        projectConfigurationRevisionId: configurationId,
        projectId: allocated.projectId,
        version: 1,
        profileRevisionId: profile.projectProfileRevisionId,
        profileRevisionSha256: profile.sha256,
        status: "adopted" as const,
        objective: input.payload.objective,
        scopeIn: input.payload.scopeIn,
        scopeOut: input.payload.scopeOut,
        successCriteria: input.payload.successCriteria,
        timezone: input.payload.timezone,
        schedulePolicy: input.payload.schedulePolicy,
        participantIds: [allocated.participantId],
        resourceBindings: [
          {
            projectResourceId: allocated.resourceId,
            role: "source" as const,
            required: true,
            capabilities: ["read", "version", "diff", "search"] as const,
          },
        ],
        presentationBindings: input.payload.presentationBindings,
        terminology: {},
        requiredReads: input.payload.requiredReads,
        effectiveFrom: now,
        adoptedByDecisionId: allocated.decisionId,
      };
      const configuration = projectConfigurationRevisionSchema.parse({
        schemaVersion: "project-configuration-revision.v1",
        ...configurationHashInput,
        sha256: computeProjectConfigurationRevisionSha256(configurationHashInput),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      const event = projectEventSchema.parse({
        schemaVersion: "project-event.v1",
        projectEventId: eventId,
        projectId: allocated.projectId,
        eventType: "project.created",
        subject: { kind: "project", objectId: allocated.projectId, revision: 1 },
        source: {
          kind: "user",
          principalId: input.principalId,
          participantId: allocated.participantId,
        },
        occurredAt: now,
        observedAt: now,
        recordedAt: now,
        payloadSha256: hashCanonical("project-created-event-payload.v1", {
          projectId: allocated.projectId,
          profileRevisionSha256: profile.sha256,
          configurationSha256: configuration.sha256,
        }),
        evidenceIds: [],
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });

      const existingProfile =
        draft.entities.projectProfileRevisions[profile.projectProfileRevisionId];
      if (existingProfile !== undefined && existingProfile.sha256 !== profile.sha256) {
        throw revisionConflict("固定Profile Revision ID已经绑定不同语义");
      }
      draft.entities.projects[project.projectId] = project;
      draft.entities.projectMethodSnapshots[method.projectMethodSnapshotId] = method;
      draft.entities.projectStages[stage.projectStageId] = stage;
      draft.entities.projectParticipants[participant.projectParticipantId] = participant;
      draft.entities.projectResources[resource.projectResourceId] = resource;
      draft.entities.projectDecisions[decision.projectDecisionId] = decision;
      draft.entities.projectProfileRevisions[profile.projectProfileRevisionId] = profile;
      draft.entities.projectConfigurationRevisions[configuration.projectConfigurationRevisionId] =
        configuration;
      draft.entities.projectEvents[event.projectEventId] = event;
      return {
        resultRefs: {
          projectId: project.projectId,
          projectParticipantId: participant.projectParticipantId,
          projectResourceId: resource.projectResourceId,
          projectConfigurationRevisionId: configuration.projectConfigurationRevisionId,
          projectEventId: event.projectEventId,
        },
      };
    },
  });
  return getProjectWorkspace(deps, {
    principalId: input.principalId,
    projectId: transaction.resultRefs.projectId ?? "",
  });
}
