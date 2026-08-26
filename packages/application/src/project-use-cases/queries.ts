import {
  type PrincipalId,
  type ProjectSummaryDto,
  type ProjectTimelineItemDto,
  type ProjectWorkspaceDto,
} from "@chat/contracts";
import { projectTimelineItemDtoSchema } from "@chat/contracts";
import { type ApplicationDeps } from "../deps.js";
import { forbidden, notFound } from "../errors.js";
import { projectSummary, projectWorkspace } from "./shared.js";

export async function listProjects(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId },
): Promise<{ projects: ProjectSummaryDto[] }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  return {
    projects: Object.values(snapshot.entities.projects)
      .filter((project) => project.ownerPrincipalId === input.principalId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((project) => projectSummary(snapshot, project)),
  };
}

export async function getProjectWorkspace(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId; readonly projectId: string },
): Promise<{ project: ProjectWorkspaceDto }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const project = projectWorkspace(snapshot, input.projectId, input.principalId);
  const disabled = new Set(deps.disabledProjectProviderKinds ?? []);
  const providerBindings = project.providerBindings.filter(
    (binding) => !disabled.has(binding.providerKind),
  );
  const visibleBindingIds = new Set(
    providerBindings.map((binding) => binding.projectProviderBindingId),
  );
  return {
    project: {
      ...project,
      providerBindings,
      providerProjections: project.providerProjections.filter((projection) =>
        visibleBindingIds.has(projection.bindingId),
      ),
    },
  };
}

export async function getProjectTimeline(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId; readonly projectId: string },
): Promise<{ items: ProjectTimelineItemDto[] }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const project = snapshot.entities.projects[input.projectId];
  if (project === undefined) throw notFound("Project不存在");
  if (project.ownerPrincipalId !== input.principalId) throw forbidden("无权查看该Project");
  const items: ProjectTimelineItemDto[] = [
    {
      id: project.projectId,
      kind: "project_created",
      title: "项目已建立",
      occurredAt: project.createdAt,
      objectRevision: 1,
    },
    ...Object.values(snapshot.entities.projectDecisions)
      .filter((item) => item.projectId === project.projectId)
      .map((item) => ({
        id: item.projectDecisionId,
        kind: "decision" as const,
        actorParticipantId: item.decidedByParticipantId,
        title: item.question,
        occurredAt: item.createdAt,
        objectRevision: item.revision,
      })),
    ...Object.values(snapshot.entities.projectContributions)
      .filter((item) => item.projectId === project.projectId)
      .map((item) => ({
        id: item.projectContributionId,
        kind: "contribution" as const,
        actorParticipantId: item.participantId,
        title: item.summary,
        occurredAt: item.occurredAt,
        objectRevision: item.revision,
      })),
    ...Object.values(snapshot.entities.projectObservations)
      .filter((item) => item.projectId === project.projectId)
      .map((item) => ({
        id: item.projectObservationId,
        kind: "resource_observation" as const,
        title: "资源观察已更新",
        occurredAt: item.observedAt,
        objectRevision: item.revision,
      })),
    ...Object.values(snapshot.entities.projectActions)
      .filter((item) => item.projectId === project.projectId)
      .map((item) => ({
        id: item.projectActionId,
        kind: "action" as const,
        actorParticipantId: item.ownerParticipantId,
        title: item.title,
        occurredAt: item.updatedAt,
        objectRevision: item.revision,
      })),
    ...Object.values(snapshot.entities.projectStateTransitions)
      .filter((item) => item.projectId === project.projectId)
      .map((item) => ({
        id: item.projectStateTransitionId,
        kind: "state_transition" as const,
        actorParticipantId: item.actorParticipantId,
        title:
          item.objectType === "stage"
            ? `阶段：${item.from} → ${item.to}`
            : item.objectType === "milestone"
              ? `里程碑：${item.from} → ${item.to}`
              : item.objectType === "work"
                ? `工作：${item.from} → ${item.to}`
                : `项目：${item.from} → ${item.to}`,
        occurredAt: item.occurredAt,
        objectRevision: item.revision,
      })),
    ...Object.values(snapshot.entities.projectUpdates)
      .filter((item) => item.projectId === project.projectId)
      .map((item) => ({
        id: item.projectUpdateId,
        kind: "project_update" as const,
        actorParticipantId: item.authorParticipantId,
        title: `项目更新 · ${item.health}`,
        occurredAt: item.publishedAt,
        objectRevision: item.revision,
      })),
    ...Object.values(snapshot.entities.projectEvents)
      .filter((item) => item.projectId === project.projectId)
      .map((item) => ({
        id: item.projectEventId,
        kind: "project_event" as const,
        ...(item.source.participantId === undefined
          ? {}
          : { actorParticipantId: item.source.participantId }),
        title: item.eventType,
        occurredAt: item.occurredAt,
        objectRevision: item.revision,
      })),
  ];
  return {
    items: items
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .map((item) => projectTimelineItemDtoSchema.parse(item)),
  };
}
