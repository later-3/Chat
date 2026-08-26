import type { ProductSnapshot } from "@chat/contracts";
import {
  assertPlaneProjectOperationIdentityUniqueness,
  assertPlaneProjectOperationIntegrity,
  hashCanonical,
} from "@chat/domain";
import type { Fail } from "./shared.js";

export function assertProjectCoordination(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const activeProjectKeys = new Set<string>();

  for (const binding of Object.values(entities.projectProviderBindings)) {
    const project = entities.projects[binding.projectId];
    const root =
      binding.workspaceRootId === undefined
        ? undefined
        : Object.values(entities.projectResources).find(
            (resource) =>
              resource.projectId === binding.projectId &&
              resource.rootId === binding.workspaceRootId,
          );
    const agent =
      binding.coordinationAgentParticipantId === undefined
        ? undefined
        : entities.projectParticipants[binding.coordinationAgentParticipantId];
    if (
      project?.ownerPrincipalId !== binding.ownerPrincipalId ||
      (binding.workspaceRootId !== undefined && root === undefined) ||
      (binding.status === "active" && root === undefined) ||
      (binding.coordinationAgentParticipantId !== undefined &&
        (agent?.projectId !== binding.projectId ||
          agent.kind !== "agent" ||
          agent.status !== "active"))
    ) {
      fail(`projectProviderBinding ${binding.projectProviderBindingId} Project/Root/Agent无效`);
    }
    if (new Set(binding.humanActorExternalIds).size !== binding.humanActorExternalIds.length) {
      fail(`projectProviderBinding ${binding.projectProviderBindingId} 人类Actor重复`);
    }
    const mappingKeys = new Set<string>();
    const providerMappingKeys = new Set<string>();
    for (const mapping of binding.stateMappings) {
      const key = `${mapping.workKind}\0${mapping.chatState}`;
      const providerKey = `${mapping.workKind}\0${mapping.providerStateId}`;
      if (mappingKeys.has(key) || providerMappingKeys.has(providerKey)) {
        fail(`projectProviderBinding ${binding.projectProviderBindingId} State映射不是双向唯一`);
      }
      mappingKeys.add(key);
      providerMappingKeys.add(providerKey);
    }
    const moduleKeys = new Set<string>();
    const moduleIds = new Set<string>();
    for (const mapping of binding.moduleMappings) {
      if (moduleKeys.has(mapping.mappingKey) || moduleIds.has(mapping.providerModuleId)) {
        fail(`projectProviderBinding ${binding.projectProviderBindingId} Module映射不唯一`);
      }
      moduleKeys.add(mapping.mappingKey);
      moduleIds.add(mapping.providerModuleId);
    }
    const labelKeys = new Set<string>();
    const labelIds = new Set<string>();
    for (const mapping of binding.labelMappings) {
      if (labelKeys.has(mapping.mappingKey) || labelIds.has(mapping.providerLabelId)) {
        fail(`projectProviderBinding ${binding.projectProviderBindingId} Label映射不唯一`);
      }
      labelKeys.add(mapping.mappingKey);
      labelIds.add(mapping.providerLabelId);
    }
    if (binding.status !== "archived") {
      const projectKey = `${binding.ownerPrincipalId}\0${binding.projectKey}`;
      if (activeProjectKeys.has(projectKey)) {
        fail(`projectProviderBinding ${binding.projectProviderBindingId} projectKey重复`);
      }
      activeProjectKeys.add(projectKey);
    }
  }

  for (const projection of Object.values(entities.projectProviderProjections)) {
    if (projection.providerSnapshot !== undefined) {
      const expected = hashCanonical("plane-work-item-projection.v1", projection.providerSnapshot);
      if (projection.providerFingerprint !== expected) {
        fail(
          `projectProviderProjection ${projection.projectProviderProjectionId} Provider Snapshot Hash无效`,
        );
      }
    }
  }

  const operations = Object.values(entities.projectCoordinationOperations);
  try {
    assertPlaneProjectOperationIdentityUniqueness(operations);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  for (const operation of operations) {
    try {
      assertPlaneProjectOperationIntegrity(operation);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    const binding = entities.projectProviderBindings[operation.planeProjectBindingId];
    const work = entities.projectWorks[operation.projectWorkId];
    const actor = entities.projectParticipants[operation.actorParticipantId];
    const projection =
      operation.projectProviderProjectionId === undefined
        ? undefined
        : entities.projectProviderProjections[operation.projectProviderProjectionId];
    const evidenceIds =
      operation.intent.kind === "block" ||
      operation.intent.kind === "request_review" ||
      operation.intent.kind === "progress" ||
      operation.intent.kind === "evidence"
        ? operation.intent.evidenceIds
        : [];
    if (
      binding?.projectId !== operation.projectId ||
      binding.ownerPrincipalId !== operation.ownerPrincipalId ||
      work?.projectId !== operation.projectId ||
      work.revision < operation.boundWorkRevision ||
      work.workKey !== operation.intent.externalId ||
      actor?.projectId !== operation.projectId ||
      actor.kind !== "agent" ||
      operation.providerExternalId !== `chat-work:${binding.projectKey}:${work.workKey}` ||
      evidenceIds.some((id) => {
        const evidence = entities.projectEvidence[id];
        return (
          evidence?.projectId !== operation.projectId || evidence.workId !== work.projectWorkId
        );
      })
    ) {
      fail(`projectCoordinationOperation ${operation.planeProjectOperationId} Chat绑定无效`);
    }
    if (
      projection !== undefined &&
      (projection.bindingId !== operation.planeProjectBindingId ||
        projection.projectId !== operation.projectId ||
        projection.objectType !== "work" ||
        projection.objectId !== operation.projectWorkId)
    ) {
      fail(`projectCoordinationOperation ${operation.planeProjectOperationId} Projection绑定无效`);
    }
    if (
      operation.status === "completed" &&
      (projection === undefined || projection.providerObjectId !== operation.planeWorkItemId)
    ) {
      fail(
        `projectCoordinationOperation ${operation.planeProjectOperationId} Receipt未收敛Projection`,
      );
    }
  }

  for (const change of Object.values(entities.projectInboundChanges)) {
    const binding = entities.projectProviderBindings[change.bindingId];
    const projection = entities.projectProviderProjections[change.projectionId];
    const work = entities.projectWorks[change.workId];
    if (
      binding?.projectId !== change.projectId ||
      projection?.bindingId !== change.bindingId ||
      projection.objectType !== "work" ||
      projection.objectId !== change.workId ||
      projection.providerObjectId !== change.providerObjectId ||
      work?.projectId !== change.projectId ||
      work.revision < change.observedWorkRevision ||
      change.beforeFingerprint === change.afterFingerprint
    ) {
      fail(`projectInboundChange ${change.projectInboundChangeId} 绑定或Fingerprint无效`);
    }
    if (
      change.status === "adopted" &&
      (change.classification !== "adoptable" ||
        (change.before.providerStateId !== change.after.providerStateId &&
          change.resolutionDecisionId === undefined))
    ) {
      fail(`projectInboundChange ${change.projectInboundChangeId} Adopted分类或State Decision无效`);
    }
    if (
      change.resolutionDecisionId !== undefined &&
      entities.projectDecisions[change.resolutionDecisionId]?.boundWorkId !== change.workId
    ) {
      fail(`projectInboundChange ${change.projectInboundChangeId} Decision绑定无效`);
    }
  }
}
