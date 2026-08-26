import type { ProductSnapshot } from "@chat/contracts";
import {
  computeProjectConfigurationRevisionSha256,
  computeProjectProfileRevisionSha256,
  type ProjectProfileDefinition,
} from "@chat/domain";
import type { Fail } from "./shared.js";

function assertUnique(values: readonly string[], label: string, fail: Fail): void {
  if (new Set(values).size !== values.length) fail(`${label}重复`);
}

function profileDefinition(
  profile: ProductSnapshot["entities"]["projectProfileRevisions"][string],
): ProjectProfileDefinition {
  return {
    profileKey: profile.profileKey,
    title: profile.title,
    purpose: profile.purpose,
    objectCatalog: profile.objectCatalog,
    lifecycle: profile.lifecycle,
    defaultTimePolicy: profile.defaultTimePolicy,
    authorityPolicy: profile.authorityPolicy,
    evidencePolicy: profile.evidencePolicy,
    contextPolicies: profile.contextPolicies,
    viewRequirements: profile.viewRequirements,
    maintenanceCadences: profile.maintenanceCadences,
    metrics: profile.metrics,
  };
}

function persistedEventSubject(
  snapshot: ProductSnapshot,
  event: ProductSnapshot["entities"]["projectEvents"][string],
  fail: Fail,
): { readonly revision: number; readonly projectId?: string | undefined } {
  const { entities } = snapshot;
  const subject = (() => {
    switch (event.subject.kind) {
      case "project":
        return entities.projects[event.subject.objectId];
      case "profile":
        return entities.projectProfileRevisions[event.subject.objectId];
      case "configuration":
        return entities.projectConfigurationRevisions[event.subject.objectId];
      case "need":
        return entities.projectNeeds[event.subject.objectId];
      case "requirement":
        return entities.projectRequirements[event.subject.objectId];
      case "work":
        return entities.projectWorks[event.subject.objectId];
      case "action":
        return entities.projectActions[event.subject.objectId];
      case "activity":
      case "review":
        return entities.projectContributions[event.subject.objectId];
      case "claim":
        return entities.projectWorkClaims[event.subject.objectId];
      case "handoff":
        return entities.projectWorkHandoffs[event.subject.objectId];
      case "block":
        return entities.projectWorkBlocks[event.subject.objectId];
      case "resource":
        return entities.projectResources[event.subject.objectId];
      case "artifact":
        return entities.projectArtifactRefs[event.subject.objectId];
      case "evidence":
        return entities.projectEvidence[event.subject.objectId];
      case "decision":
        return entities.projectDecisions[event.subject.objectId];
      case "practice":
        return entities.projectPracticeRevisions[event.subject.objectId];
      case "metric":
        return entities.projectMetricObservations[event.subject.objectId];
      case "event":
        return entities.projectEvents[event.subject.objectId];
      case "publication":
        return entities.projectWorkOutcomes[event.subject.objectId];
      case "objective":
      case "scope":
      case "commitment":
      case "dependency":
      case "risk":
      case "issue":
      case "acceptance":
      case "change":
      case "knowledge":
      case "case":
      case "lesson":
      case "capture":
      case "competency":
      case "assessment":
      case "daily_entry":
      case "report":
        fail(
          `projectEvent ${event.projectEventId} Subject kind ${event.subject.kind} 没有持久聚合或外部Ref合同`,
        );
    }
  })();
  if (subject === undefined) fail(`projectEvent ${event.projectEventId} Subject不存在`);
  if (event.subject.kind === "profile") {
    const belongsToProject = Object.values(entities.projectConfigurationRevisions).some(
      (configuration) =>
        configuration.projectId === event.projectId &&
        configuration.profileRevisionId === event.subject.objectId,
    );
    if (!belongsToProject) fail(`projectEvent ${event.projectEventId} Profile Subject跨Project`);
    return { revision: subject.revision };
  }
  const subjectProjectId = "projectId" in subject ? subject.projectId : undefined;
  if (subjectProjectId !== event.projectId) {
    fail(`projectEvent ${event.projectEventId} Subject跨Project`);
  }
  return { revision: subject.revision, projectId: subjectProjectId };
}

export function assertProjectManagement(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const profileVersions = new Set<string>();

  for (const profile of Object.values(entities.projectProfileRevisions)) {
    const versionKey = `${profile.profileKey}\0${String(profile.version)}`;
    if (profileVersions.has(versionKey)) {
      fail(`projectProfileRevision ${profile.projectProfileRevisionId} Profile/version重复`);
    }
    profileVersions.add(versionKey);
    const expectedHash = computeProjectProfileRevisionSha256({
      projectProfileRevisionId: profile.projectProfileRevisionId,
      version: profile.version,
      definition: profileDefinition(profile),
      status: profile.status,
      ...(profile.adoptedByDecisionId === undefined
        ? {}
        : { adoptedByDecisionId: profile.adoptedByDecisionId }),
    });
    if (expectedHash !== profile.sha256) {
      fail(`projectProfileRevision ${profile.projectProfileRevisionId} Hash不一致`);
    }
    if (
      profile.adoptedByDecisionId !== undefined &&
      entities.projectDecisions[profile.adoptedByDecisionId] === undefined
    ) {
      fail(`projectProfileRevision ${profile.projectProfileRevisionId} 采用Decision不存在`);
    }
  }

  const adoptedConfigurations = new Set<string>();
  const configurationVersions = new Set<string>();
  const successorByConfigurationId = new Map<string, string>();
  for (const configuration of Object.values(entities.projectConfigurationRevisions)) {
    const versionKey = `${configuration.projectId}\0${String(configuration.version)}`;
    if (configurationVersions.has(versionKey)) {
      fail(
        `projectConfigurationRevision ${configuration.projectConfigurationRevisionId} Project/version重复`,
      );
    }
    configurationVersions.add(versionKey);
    assertUnique(
      configuration.participantIds,
      `projectConfigurationRevision ${configuration.projectConfigurationRevisionId} Participant`,
      fail,
    );
    assertUnique(
      configuration.resourceBindings.map(
        (binding) => `${binding.projectResourceId}\0${binding.role}`,
      ),
      `projectConfigurationRevision ${configuration.projectConfigurationRevisionId} Resource Binding`,
      fail,
    );
    assertUnique(
      configuration.presentationBindings.map((binding) => `${binding.capability}\0${binding.mode}`),
      `projectConfigurationRevision ${configuration.projectConfigurationRevisionId} Presentation capability/mode`,
      fail,
    );
    assertUnique(
      configuration.requiredReads,
      `projectConfigurationRevision ${configuration.projectConfigurationRevisionId} Required Read`,
      fail,
    );
    const project = entities.projects[configuration.projectId];
    const profile = entities.projectProfileRevisions[configuration.profileRevisionId];
    if (project === undefined || profile?.sha256 !== configuration.profileRevisionSha256) {
      fail(
        `projectConfigurationRevision ${configuration.projectConfigurationRevisionId} Project/Profile无效`,
      );
    }
    for (const participantId of configuration.participantIds) {
      if (entities.projectParticipants[participantId]?.projectId !== configuration.projectId) {
        fail(
          `projectConfigurationRevision ${configuration.projectConfigurationRevisionId} Participant无效`,
        );
      }
    }
    for (const binding of configuration.resourceBindings) {
      if (
        entities.projectResources[binding.projectResourceId]?.projectId !== configuration.projectId
      ) {
        fail(
          `projectConfigurationRevision ${configuration.projectConfigurationRevisionId} Resource无效`,
        );
      }
    }
    if (
      configuration.adoptedByDecisionId !== undefined &&
      entities.projectDecisions[configuration.adoptedByDecisionId]?.projectId !==
        configuration.projectId
    ) {
      fail(
        `projectConfigurationRevision ${configuration.projectConfigurationRevisionId} Decision无效`,
      );
    }
    const expectedHash = computeProjectConfigurationRevisionSha256({
      projectConfigurationRevisionId: configuration.projectConfigurationRevisionId,
      projectId: configuration.projectId,
      version: configuration.version,
      profileRevisionId: configuration.profileRevisionId,
      profileRevisionSha256: configuration.profileRevisionSha256,
      status: configuration.status,
      objective: configuration.objective,
      scopeIn: configuration.scopeIn,
      scopeOut: configuration.scopeOut,
      successCriteria: configuration.successCriteria,
      timezone: configuration.timezone,
      schedulePolicy: configuration.schedulePolicy,
      participantIds: configuration.participantIds,
      resourceBindings: configuration.resourceBindings,
      presentationBindings: configuration.presentationBindings,
      terminology: configuration.terminology,
      requiredReads: configuration.requiredReads,
      ...(configuration.effectiveFrom === undefined
        ? {}
        : { effectiveFrom: configuration.effectiveFrom }),
      ...(configuration.effectiveTo === undefined
        ? {}
        : { effectiveTo: configuration.effectiveTo }),
      ...(configuration.supersedesConfigurationRevisionId === undefined
        ? {}
        : {
            supersedesConfigurationRevisionId: configuration.supersedesConfigurationRevisionId,
          }),
      ...(configuration.adoptedByDecisionId === undefined
        ? {}
        : { adoptedByDecisionId: configuration.adoptedByDecisionId }),
    });
    if (expectedHash !== configuration.sha256) {
      fail(
        `projectConfigurationRevision ${configuration.projectConfigurationRevisionId} Hash不一致`,
      );
    }
    const supersededId = configuration.supersedesConfigurationRevisionId;
    if (supersededId !== undefined) {
      const predecessor = entities.projectConfigurationRevisions[supersededId];
      if (
        configuration.status !== "adopted" ||
        predecessor?.projectId !== configuration.projectId ||
        predecessor.status !== "adopted" ||
        predecessor.version >= configuration.version ||
        successorByConfigurationId.has(supersededId)
      ) {
        fail(
          `projectConfigurationRevision ${configuration.projectConfigurationRevisionId} Supersedes链无效`,
        );
      }
      successorByConfigurationId.set(supersededId, configuration.projectConfigurationRevisionId);
    }
  }
  for (const configuration of Object.values(entities.projectConfigurationRevisions)) {
    const visited = new Set<string>();
    let cursor: string | undefined = configuration.projectConfigurationRevisionId;
    while (cursor !== undefined) {
      if (visited.has(cursor)) {
        fail(
          `projectConfigurationRevision ${configuration.projectConfigurationRevisionId} Supersedes链成环`,
        );
      }
      visited.add(cursor);
      cursor = successorByConfigurationId.get(cursor);
    }
  }
  for (const configuration of Object.values(entities.projectConfigurationRevisions)) {
    if (configuration.status !== "adopted") continue;
    if (!successorByConfigurationId.has(configuration.projectConfigurationRevisionId)) {
      if (adoptedConfigurations.has(configuration.projectId)) {
        fail(`project ${configuration.projectId} 存在多个当前已采用Configuration`);
      }
      adoptedConfigurations.add(configuration.projectId);
    }
  }

  for (const need of Object.values(entities.projectNeeds)) {
    if (
      entities.projects[need.projectId] === undefined ||
      (need.commitmentDecisionId !== undefined &&
        entities.projectDecisions[need.commitmentDecisionId]?.projectId !== need.projectId)
    ) {
      fail(`projectNeed ${need.projectNeedId} Project/Decision无效`);
    }
  }

  for (const requirement of Object.values(entities.projectRequirements)) {
    if (
      entities.projects[requirement.projectId] === undefined ||
      requirement.needIds.some(
        (needId) => entities.projectNeeds[needId]?.projectId !== requirement.projectId,
      ) ||
      (requirement.acceptanceDecisionId !== undefined &&
        entities.projectDecisions[requirement.acceptanceDecisionId]?.projectId !==
          requirement.projectId)
    ) {
      fail(`projectRequirement ${requirement.projectRequirementId} Project/Need/Decision无效`);
    }
  }

  const eventStreams = new Map<string, (typeof entities.projectEvents)[string][]>();
  for (const event of Object.values(entities.projectEvents)) {
    if (
      entities.projects[event.projectId] === undefined ||
      (event.source.participantId !== undefined &&
        entities.projectParticipants[event.source.participantId]?.projectId !== event.projectId) ||
      event.evidenceIds.some(
        (evidenceId) => entities.projectEvidence[evidenceId]?.projectId !== event.projectId,
      )
    ) {
      fail(`projectEvent ${event.projectEventId} Project/Participant/Evidence无效`);
    }
    const persisted = persistedEventSubject(snapshot, event, fail);
    if (event.subject.revision !== undefined && event.subject.revision > persisted.revision) {
      fail(`projectEvent ${event.projectEventId} Subject Revision超出当前对象`);
    }
    const streamKey = `${event.subject.kind}\0${event.subject.objectId}`;
    const stream = eventStreams.get(streamKey) ?? [];
    stream.push(event);
    eventStreams.set(streamKey, stream);
  }
  for (const stream of eventStreams.values()) {
    const current = persistedEventSubject(snapshot, stream[0]!, fail);
    const anchors = stream
      .map((event) => event.subject.revision)
      .filter((revision): revision is number => revision !== undefined);
    const transitions = stream
      .filter(
        (event): event is typeof event & { beforeRevision: number; afterRevision: number } =>
          event.beforeRevision !== undefined && event.afterRevision !== undefined,
      )
      .sort(
        (left, right) =>
          left.beforeRevision - right.beforeRevision ||
          left.projectEventId.localeCompare(right.projectEventId),
      );
    for (let index = 0; index < transitions.length; index += 1) {
      const event = transitions[index]!;
      const previous = transitions[index - 1];
      if (
        event.afterRevision > current.revision ||
        (event.subject.revision !== undefined && event.subject.revision !== event.afterRevision) ||
        (previous !== undefined && event.beforeRevision !== previous.afterRevision)
      ) {
        fail(`projectEvent ${event.projectEventId} Subject Revision历史链断裂`);
      }
    }
    if (transitions.length > 0) {
      const first = transitions[0]!;
      const last = transitions.at(-1)!;
      const latestAnchorAtOrBeforeFirst = anchors
        .filter((revision) => revision <= first.beforeRevision)
        .sort((left, right) => right - left)[0];
      if (
        (latestAnchorAtOrBeforeFirst !== undefined &&
          latestAnchorAtOrBeforeFirst !== first.beforeRevision) ||
        last.afterRevision !== current.revision
      ) {
        fail(`projectEvent ${last.projectEventId} Subject Revision历史链不能与当前对象对齐`);
      }
    }
  }

  for (const artifact of Object.values(entities.projectArtifactRefs)) {
    if (
      entities.projects[artifact.projectId] === undefined ||
      entities.projectResources[artifact.resourceId]?.projectId !== artifact.projectId ||
      artifact.provenanceEventIds.some(
        (eventId) => entities.projectEvents[eventId]?.projectId !== artifact.projectId,
      )
    ) {
      fail(`projectArtifactRef ${artifact.projectArtifactRefId} Project/Resource/Provenance无效`);
    }
  }

  for (const metric of Object.values(entities.projectMetricObservations)) {
    if (
      entities.projects[metric.projectId] === undefined ||
      metric.evidenceIds.some(
        (evidenceId) => entities.projectEvidence[evidenceId]?.projectId !== metric.projectId,
      )
    ) {
      fail(`projectMetricObservation ${metric.projectMetricObservationId} Project/Evidence无效`);
    }
  }
}
