import type { ProductSnapshot } from "@chat/contracts";
import {
  computeProjectConfigurationRevisionSha256,
  computeProjectProfileRevisionSha256,
  type ProjectProfileDefinition,
} from "@chat/domain";
import type { Fail } from "./shared.js";

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
  const supersededConfigurations = new Set<string>();
  for (const configuration of Object.values(entities.projectConfigurationRevisions)) {
    const versionKey = `${configuration.projectId}\0${String(configuration.version)}`;
    if (configurationVersions.has(versionKey)) {
      fail(
        `projectConfigurationRevision ${configuration.projectConfigurationRevisionId} Project/version重复`,
      );
    }
    configurationVersions.add(versionKey);
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
    if (configuration.status === "adopted") {
      const supersededId = configuration.supersedesConfigurationRevisionId;
      if (supersededId !== undefined) {
        const superseded = entities.projectConfigurationRevisions[supersededId];
        if (
          superseded?.projectId !== configuration.projectId ||
          superseded.status !== "adopted" ||
          superseded.version >= configuration.version ||
          supersededConfigurations.has(supersededId)
        ) {
          fail(
            `projectConfigurationRevision ${configuration.projectConfigurationRevisionId} Supersedes链无效`,
          );
        }
        supersededConfigurations.add(supersededId);
      }
    }
  }
  for (const configuration of Object.values(entities.projectConfigurationRevisions)) {
    if (configuration.status !== "adopted") continue;
    if (!supersededConfigurations.has(configuration.projectConfigurationRevisionId)) {
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
    const subject =
      event.subject.kind === "need"
        ? entities.projectNeeds[event.subject.objectId]
        : event.subject.kind === "requirement"
          ? entities.projectRequirements[event.subject.objectId]
          : event.subject.kind === "work"
            ? entities.projectWorks[event.subject.objectId]
            : event.subject.kind === "action"
              ? entities.projectActions[event.subject.objectId]
              : event.subject.kind === "claim"
                ? entities.projectWorkClaims[event.subject.objectId]
                : event.subject.kind === "block"
                  ? entities.projectWorkBlocks[event.subject.objectId]
                  : event.subject.kind === "handoff"
                    ? entities.projectWorkHandoffs[event.subject.objectId]
                    : event.subject.kind === "review" || event.subject.kind === "activity"
                      ? entities.projectContributions[event.subject.objectId]
                      : event.subject.kind === "resource"
                        ? entities.projectResources[event.subject.objectId]
                        : event.subject.kind === "artifact"
                          ? entities.projectArtifactRefs[event.subject.objectId]
                          : event.subject.kind === "evidence"
                            ? entities.projectEvidence[event.subject.objectId]
                            : event.subject.kind === "decision"
                              ? entities.projectDecisions[event.subject.objectId]
                              : event.subject.kind === "event"
                                ? entities.projectEvents[event.subject.objectId]
                                : event.subject.kind === "profile"
                                  ? entities.projectProfileRevisions[event.subject.objectId]
                                  : event.subject.kind === "configuration"
                                    ? entities.projectConfigurationRevisions[event.subject.objectId]
                                    : undefined;
    const subjectMustExist = [
      "need",
      "profile",
      "configuration",
      "requirement",
      "work",
      "action",
      "claim",
      "block",
      "handoff",
      "review",
      "activity",
      "resource",
      "artifact",
      "evidence",
      "decision",
      "event",
    ].includes(event.subject.kind);
    const subjectProjectId =
      subject !== undefined && "projectId" in subject ? subject.projectId : undefined;
    if (
      (subjectMustExist && subject === undefined) ||
      (subject !== undefined &&
        ((event.subject.kind !== "profile" && subjectProjectId !== event.projectId) ||
          (event.subject.revision !== undefined && subject.revision !== event.subject.revision)))
    ) {
      fail(`projectEvent ${event.projectEventId} Subject无效`);
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
