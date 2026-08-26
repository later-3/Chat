import {
  projectConfigurationRevisionSchema,
  projectEventSchema,
  projectNeedSchema,
  projectProfileRevisionSchema,
  projectRequirementSchema,
  type AdoptProjectConfigurationPayload,
  type CaptureProjectNeedPayload,
  type CommandId,
  type PrincipalId,
  type ProjectConfigurationRevision,
  type ProjectId,
  type ProjectProfileKey,
  type ProposeProjectConfigurationPayload,
  type ProposeProjectRequirementPayload,
} from "@chat/contracts";
import {
  compileBuiltInProjectProfileRevision,
  computeProjectConfigurationRevisionSha256,
  computeProjectDecisionPayloadSha256,
  hashCanonical,
  type BuiltInProjectProfileKey,
} from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import { forbidden, notFound, revisionConflict } from "./errors.js";

const BUILT_IN_PROFILE_KEYS = new Set<ProjectProfileKey>([
  "software-delivery",
  "content-production",
  "learning",
  "personal-journal",
]);

function derivedId(prefix: string, domain: string, input: unknown): string {
  return `${prefix}_${hashCanonical(domain, input).slice(0, 24)}`;
}

function assertProjectOwner(
  snapshot: Awaited<ReturnType<ApplicationDeps["store"]["read"]>>["snapshot"],
  projectId: string,
  principalId: PrincipalId,
  expectedRevision: number,
) {
  const project = snapshot.entities.projects[projectId];
  if (project === undefined) throw notFound("Project不存在");
  if (project.ownerPrincipalId !== principalId) throw forbidden("无权管理该Project");
  if (project.status !== "active") throw revisionConflict("只有active Project可以修改管理配置");
  if (project.revision !== expectedRevision) throw revisionConflict("Project revision冲突");
  return project;
}

function resolveProfile(
  snapshot: Awaited<ReturnType<ApplicationDeps["store"]["read"]>>["snapshot"],
  profileKey: ProjectProfileKey,
  now: string,
) {
  const profiles = Object.values(snapshot.entities.projectProfileRevisions)
    .filter((profile) => profile.profileKey === profileKey && profile.status === "active")
    .sort((a, b) => b.version - a.version);
  const profile = profiles[0];
  if (profile !== undefined) return profile;
  if (!BUILT_IN_PROFILE_KEYS.has(profileKey)) throw notFound(`Project Profile不存在:${profileKey}`);
  return projectProfileRevisionSchema.parse(
    compileBuiltInProjectProfileRevision({
      profileKey: profileKey as BuiltInProjectProfileKey,
      now,
    }),
  );
}

function currentConfiguration(
  configurations: readonly ProjectConfigurationRevision[],
): ProjectConfigurationRevision | undefined {
  const superseded = new Set(
    configurations.flatMap((configuration) =>
      configuration.supersedesConfigurationRevisionId === undefined
        ? []
        : [configuration.supersedesConfigurationRevisionId],
    ),
  );
  return configurations
    .filter(
      (configuration) =>
        configuration.status === "adopted" &&
        !superseded.has(configuration.projectConfigurationRevisionId),
    )
    .sort((a, b) => b.version - a.version)[0];
}

function assertConfigurationReferences(
  snapshot: Awaited<ReturnType<ApplicationDeps["store"]["read"]>>["snapshot"],
  projectId: string,
  payload: ProposeProjectConfigurationPayload,
): void {
  for (const participantId of payload.participantIds) {
    const participant = snapshot.entities.projectParticipants[participantId];
    if (participant?.projectId !== projectId || participant.status !== "active") {
      throw revisionConflict(`Participant不属于当前Project:${participantId}`);
    }
  }
  for (const binding of payload.resourceBindings) {
    const resource = snapshot.entities.projectResources[binding.projectResourceId];
    if (resource?.projectId !== projectId || resource.status !== "active") {
      throw revisionConflict(`Resource不属于当前Project:${binding.projectResourceId}`);
    }
  }
}

/** 内置Profile是系统版本事实；注册不等于任何Project已经采用它。 */
export async function registerBuiltInProjectProfile(
  deps: ApplicationDeps,
  input: {
    readonly commandId: CommandId;
    readonly profileKey: BuiltInProjectProfileKey;
  },
) {
  if (!BUILT_IN_PROFILE_KEYS.has(input.profileKey)) throw notFound("内置Project Profile不存在");
  const now = deps.now();
  const profile = projectProfileRevisionSchema.parse(
    compileBuiltInProjectProfileRevision({ profileKey: input.profileKey, now }),
  );
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "RegisterProjectProfileRevision",
    requestSha256: hashCanonical("command.register-project-profile-revision.v1", {
      profileKey: input.profileKey,
      profileRevisionId: profile.projectProfileRevisionId,
      sha256: profile.sha256,
    }),
    mutate: (draft) => {
      const existing = draft.entities.projectProfileRevisions[profile.projectProfileRevisionId];
      if (existing !== undefined && existing.sha256 !== profile.sha256) {
        throw revisionConflict("固定Profile Revision ID已经绑定不同语义");
      }
      if (existing === undefined) {
        draft.entities.projectProfileRevisions[profile.projectProfileRevisionId] = profile;
      }
      return { resultRefs: { projectProfileRevisionId: profile.projectProfileRevisionId } };
    },
  });
  return { profile };
}

/** 创建可审核Configuration候选；不自动采用，也不产生用户承诺。 */
export async function proposeProjectConfiguration(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
    readonly expectedProjectRevision: number;
    readonly payload: ProposeProjectConfigurationPayload;
  },
) {
  const before = await deps.store.read({ kind: "committedSnapshot" });
  const now = deps.now();
  assertProjectOwner(
    before.snapshot,
    input.projectId,
    input.principalId,
    input.expectedProjectRevision,
  );
  const profile = resolveProfile(before.snapshot, input.payload.profileKey, now);
  assertConfigurationReferences(before.snapshot, input.projectId, input.payload);
  const nextVersion =
    Math.max(
      0,
      ...Object.values(before.snapshot.entities.projectConfigurationRevisions)
        .filter((configuration) => configuration.projectId === input.projectId)
        .map((configuration) => configuration.version),
    ) + 1;
  const configurationId = derivedId("pcf", "id.project-configuration-candidate.v1", {
    commandId: input.commandId,
    projectId: input.projectId,
  });
  const eventId = derivedId("pev", "id.project-configuration-proposed-event.v1", {
    commandId: input.commandId,
    configurationId,
  });
  const configurationHashInput = {
    projectConfigurationRevisionId: configurationId,
    projectId: input.projectId,
    version: nextVersion,
    profileRevisionId: profile.projectProfileRevisionId,
    profileRevisionSha256: profile.sha256,
    status: "candidate" as const,
    objective: input.payload.objective,
    scopeIn: input.payload.scopeIn,
    scopeOut: input.payload.scopeOut,
    successCriteria: input.payload.successCriteria,
    timezone: input.payload.timezone,
    schedulePolicy: input.payload.schedulePolicy,
    participantIds: input.payload.participantIds,
    resourceBindings: input.payload.resourceBindings,
    presentationBindings: input.payload.presentationBindings,
    terminology: input.payload.terminology,
    requiredReads: input.payload.requiredReads,
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
    projectId: input.projectId,
    eventType: "configuration.proposed",
    subject: { kind: "configuration", objectId: configurationId, revision: 1 },
    source: { kind: "user", principalId: input.principalId },
    occurredAt: now,
    observedAt: now,
    recordedAt: now,
    payloadSha256: configuration.sha256,
    evidenceIds: [],
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "ProposeProjectConfiguration",
    requestSha256: hashCanonical("command.propose-project-configuration.v1", input),
    mutate: (draft) => {
      assertProjectOwner(
        { entities: draft.entities } as typeof before.snapshot,
        input.projectId,
        input.principalId,
        input.expectedProjectRevision,
      );
      assertConfigurationReferences(
        { entities: draft.entities } as typeof before.snapshot,
        input.projectId,
        input.payload,
      );
      const existingProfile =
        draft.entities.projectProfileRevisions[profile.projectProfileRevisionId];
      if (existingProfile !== undefined && existingProfile.sha256 !== profile.sha256) {
        throw revisionConflict("固定Profile Revision ID已经绑定不同语义");
      }
      if (existingProfile === undefined) {
        draft.entities.projectProfileRevisions[profile.projectProfileRevisionId] = profile;
      }
      draft.entities.projectConfigurationRevisions[configurationId] = configuration;
      draft.entities.projectEvents[eventId] = event;
      return {
        resultRefs: {
          projectId: input.projectId,
          projectConfigurationRevisionId: configurationId,
          projectEventId: eventId,
        },
      };
    },
  });
  return { configuration, event };
}

/** 采用时创建新的不可变语义Revision，候选仍作为历史保留；旧采用版本由链式引用结束。 */
export async function adoptProjectConfiguration(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
    readonly expectedProjectRevision: number;
    readonly expectedCandidateRevision: number;
    readonly payload: AdoptProjectConfigurationPayload;
  },
) {
  const before = await deps.store.read({ kind: "committedSnapshot" });
  const project = assertProjectOwner(
    before.snapshot,
    input.projectId,
    input.principalId,
    input.expectedProjectRevision,
  );
  const candidate =
    before.snapshot.entities.projectConfigurationRevisions[
      input.payload.candidateConfigurationRevisionId
    ];
  if (
    candidate?.projectId !== input.projectId ||
    candidate.status !== "candidate" ||
    candidate.revision !== input.expectedCandidateRevision ||
    candidate.sha256 !== input.payload.candidateSha256
  ) {
    throw revisionConflict("Configuration候选Revision或Hash已经变化");
  }
  const decider =
    before.snapshot.entities.projectParticipants[input.payload.decidedByParticipantId];
  if (
    decider?.projectId !== input.projectId ||
    decider.status !== "active" ||
    decider.kind !== "human" ||
    decider.principalId !== input.principalId
  ) {
    throw forbidden("只有当前Project中的用户Participant可以采用Configuration");
  }
  const configurations = Object.values(
    before.snapshot.entities.projectConfigurationRevisions,
  ).filter((configuration) => configuration.projectId === input.projectId);
  const current = currentConfiguration(configurations);
  const adoptedVersion = Math.max(...configurations.map((item) => item.version)) + 1;
  const decisionId = derivedId("pdc", "id.project-configuration-decision.v1", {
    commandId: input.commandId,
    candidateId: candidate.projectConfigurationRevisionId,
  });
  const adoptedId = derivedId("pcf", "id.project-configuration-adopted.v1", {
    commandId: input.commandId,
    candidateId: candidate.projectConfigurationRevisionId,
  });
  const eventId = derivedId("pev", "id.project-configuration-adopted-event.v1", {
    commandId: input.commandId,
    adoptedId,
  });
  const now = deps.now();
  const decisionShape = {
    projectId: input.projectId,
    boundProjectRevision: project.revision,
    question: `是否采用Project Configuration ${candidate.projectConfigurationRevisionId}？`,
    options: ["adopt", "reject"],
    choice: "adopt",
    rationale: input.payload.rationale,
  };
  const decision = {
    schemaVersion: "project-decision.v2" as const,
    projectDecisionId: decisionId as never,
    ...decisionShape,
    decidedByParticipantId: input.payload.decidedByParticipantId,
    payloadSha256: computeProjectDecisionPayloadSha256(decisionShape) as never,
    status: "active" as const,
    commandId: input.commandId,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  const configurationHashInput = {
    projectConfigurationRevisionId: adoptedId,
    projectId: input.projectId,
    version: adoptedVersion,
    profileRevisionId: candidate.profileRevisionId,
    profileRevisionSha256: candidate.profileRevisionSha256,
    status: "adopted" as const,
    objective: candidate.objective,
    scopeIn: candidate.scopeIn,
    scopeOut: candidate.scopeOut,
    successCriteria: candidate.successCriteria,
    timezone: candidate.timezone,
    schedulePolicy: candidate.schedulePolicy,
    participantIds: candidate.participantIds,
    resourceBindings: candidate.resourceBindings,
    presentationBindings: candidate.presentationBindings,
    terminology: candidate.terminology,
    requiredReads: candidate.requiredReads,
    effectiveFrom: now,
    ...(current === undefined
      ? {}
      : { supersedesConfigurationRevisionId: current.projectConfigurationRevisionId }),
    adoptedByDecisionId: decisionId,
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
    projectId: input.projectId,
    eventType: "configuration.adopted",
    subject: { kind: "configuration", objectId: adoptedId, revision: 1 },
    source: {
      kind: "user",
      principalId: input.principalId,
      participantId: input.payload.decidedByParticipantId,
    },
    occurredAt: now,
    observedAt: now,
    recordedAt: now,
    payloadSha256: configuration.sha256,
    evidenceIds: [],
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "AdoptProjectConfiguration",
    requestSha256: hashCanonical("command.adopt-project-configuration.v1", input),
    mutate: (draft) => {
      assertProjectOwner(
        { entities: draft.entities } as typeof before.snapshot,
        input.projectId,
        input.principalId,
        input.expectedProjectRevision,
      );
      const currentCandidate =
        draft.entities.projectConfigurationRevisions[
          input.payload.candidateConfigurationRevisionId
        ];
      if (
        currentCandidate?.revision !== input.expectedCandidateRevision ||
        currentCandidate.sha256 !== input.payload.candidateSha256
      ) {
        throw revisionConflict("Configuration候选Revision或Hash已经变化");
      }
      draft.entities.projectDecisions[decisionId] = decision;
      draft.entities.projectConfigurationRevisions[adoptedId] = configuration;
      draft.entities.projectEvents[eventId] = event;
      return {
        resultRefs: {
          projectId: input.projectId,
          projectConfigurationRevisionId: adoptedId,
          projectDecisionId: decisionId,
          projectEventId: eventId,
        },
      };
    },
  });
  return { configuration, decision, event };
}

/** 记录Need但不把它偷换成承诺或Work。 */
export async function captureProjectNeed(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
    readonly expectedProjectRevision: number;
    readonly payload: CaptureProjectNeedPayload;
  },
) {
  const before = await deps.store.read({ kind: "committedSnapshot" });
  assertProjectOwner(
    before.snapshot,
    input.projectId,
    input.principalId,
    input.expectedProjectRevision,
  );
  const needId = derivedId("pnd", "id.project-need.v1", {
    commandId: input.commandId,
    projectId: input.projectId,
  });
  const eventId = derivedId("pev", "id.project-need-captured-event.v1", {
    commandId: input.commandId,
    needId,
  });
  const now = deps.now();
  const need = projectNeedSchema.parse({
    schemaVersion: "project-need.v1",
    projectNeedId: needId,
    projectId: input.projectId,
    ...input.payload,
    status: "captured",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  const event = projectEventSchema.parse({
    schemaVersion: "project-event.v1",
    projectEventId: eventId,
    projectId: input.projectId,
    eventType: "need.captured",
    subject: { kind: "need", objectId: needId, revision: 1 },
    source: {
      kind: input.payload.origin === "agent_candidate" ? "agent" : "user",
      principalId: input.principalId,
    },
    occurredAt: input.payload.occurredAt,
    observedAt: now < input.payload.occurredAt ? input.payload.occurredAt : now,
    recordedAt: now < input.payload.occurredAt ? input.payload.occurredAt : now,
    payloadSha256: hashCanonical("project-need-payload.v1", input.payload),
    evidenceIds: [],
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "CaptureProjectNeed",
    requestSha256: hashCanonical("command.capture-project-need.v1", input),
    mutate: (draft) => {
      assertProjectOwner(
        { entities: draft.entities } as typeof before.snapshot,
        input.projectId,
        input.principalId,
        input.expectedProjectRevision,
      );
      draft.entities.projectNeeds[needId] = need;
      draft.entities.projectEvents[eventId] = event;
      return {
        resultRefs: { projectId: input.projectId, projectNeedId: needId, projectEventId: eventId },
      };
    },
  });
  return { need, event };
}

/** Requirement只引用已存在Need；进入accepted仍需要后续显式Decision。 */
export async function proposeProjectRequirement(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
    readonly expectedProjectRevision: number;
    readonly payload: ProposeProjectRequirementPayload;
  },
) {
  const before = await deps.store.read({ kind: "committedSnapshot" });
  assertProjectOwner(
    before.snapshot,
    input.projectId,
    input.principalId,
    input.expectedProjectRevision,
  );
  for (const needId of input.payload.needIds) {
    if (before.snapshot.entities.projectNeeds[needId]?.projectId !== input.projectId) {
      throw revisionConflict(`Requirement引用的Need无效:${needId}`);
    }
  }
  const requirementId = derivedId("prq", "id.project-requirement.v1", {
    commandId: input.commandId,
    projectId: input.projectId,
  });
  const eventId = derivedId("pev", "id.project-requirement-proposed-event.v1", {
    commandId: input.commandId,
    requirementId,
  });
  const now = deps.now();
  const requirement = projectRequirementSchema.parse({
    schemaVersion: "project-requirement.v1",
    projectRequirementId: requirementId,
    projectId: input.projectId,
    ...input.payload,
    status: "proposed",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  const event = projectEventSchema.parse({
    schemaVersion: "project-event.v1",
    projectEventId: eventId,
    projectId: input.projectId,
    eventType: "requirement.proposed",
    subject: { kind: "requirement", objectId: requirementId, revision: 1 },
    source: { kind: "user", principalId: input.principalId },
    occurredAt: now,
    observedAt: now,
    recordedAt: now,
    payloadSha256: hashCanonical("project-requirement-payload.v1", input.payload),
    evidenceIds: [],
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "ProposeProjectRequirement",
    requestSha256: hashCanonical("command.propose-project-requirement.v1", input),
    mutate: (draft) => {
      assertProjectOwner(
        { entities: draft.entities } as typeof before.snapshot,
        input.projectId,
        input.principalId,
        input.expectedProjectRevision,
      );
      for (const needId of input.payload.needIds) {
        if (draft.entities.projectNeeds[needId]?.projectId !== input.projectId) {
          throw revisionConflict(`Requirement引用的Need无效:${needId}`);
        }
      }
      draft.entities.projectRequirements[requirementId] = requirement;
      draft.entities.projectEvents[eventId] = event;
      return {
        resultRefs: {
          projectId: input.projectId,
          projectRequirementId: requirementId,
          projectEventId: eventId,
        },
      };
    },
  });
  return { requirement, event };
}
