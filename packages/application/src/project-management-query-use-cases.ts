import {
  PROJECT_MANAGEMENT_API_VERSION,
  projectAgentContextDtoSchema,
  projectHomeDtoSchema,
  projectMaintenancePlanDtoSchema,
  projectObjectQueryResultDtoSchema,
  projectObjectQuerySchema,
  type PrincipalId,
  type ProjectAgentContextDto,
  type ProjectContextPurpose,
  type ProjectHomeDto,
  type ProjectMaintenancePlanDto,
  type ProjectManagedObjectKind,
  type ProjectObjectQuery,
  type ProjectObjectQueryResultDto,
  type ProjectObjectSummaryDto,
} from "@chat/contracts";
import { hashCanonical } from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import { forbidden, notFound } from "./errors.js";

type Snapshot = Awaited<ReturnType<ApplicationDeps["store"]["read"]>>["snapshot"];

function ownedProject(snapshot: Snapshot, projectId: string, principalId: PrincipalId) {
  const project = snapshot.entities.projects[projectId];
  if (project === undefined) throw notFound("Project不存在");
  if (project.ownerPrincipalId !== principalId) throw forbidden("无权查看该Project");
  return project;
}

function currentConfiguration(snapshot: Snapshot, projectId: string) {
  const configurations = Object.values(snapshot.entities.projectConfigurationRevisions).filter(
    (configuration) => configuration.projectId === projectId,
  );
  const superseded = new Set(
    configurations.flatMap((configuration) =>
      configuration.supersedesConfigurationRevisionId === undefined
        ? []
        : [configuration.supersedesConfigurationRevisionId],
    ),
  );
  const configuration = configurations
    .filter(
      (candidate) =>
        candidate.status === "adopted" && !superseded.has(candidate.projectConfigurationRevisionId),
    )
    .sort((a, b) => b.version - a.version)[0];
  if (configuration === undefined) throw notFound("Project尚未采用管理Configuration");
  const profile = snapshot.entities.projectProfileRevisions[configuration.profileRevisionId];
  if (profile === undefined || profile.sha256 !== configuration.profileRevisionSha256) {
    throw notFound("Project采用的Profile Revision不存在");
  }
  return { configuration, profile };
}

function summary(input: {
  kind: ProjectManagedObjectKind;
  objectId: string;
  title: string;
  revision: number;
  status?: string | undefined;
  occurredAt?: string | undefined;
  updatedAt?: string | undefined;
  dueAt?: string | undefined;
  relationIds?: readonly string[] | undefined;
  evidenceIds?: readonly string[] | undefined;
  attentionReasons?: readonly string[] | undefined;
}): ProjectObjectSummaryDto {
  return {
    kind: input.kind,
    objectId: input.objectId,
    title: input.title,
    revision: input.revision,
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
    ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
    relationIds: [...(input.relationIds ?? [])],
    evidenceIds: [...(input.evidenceIds ?? [])],
    attentionReasons: [...(input.attentionReasons ?? [])],
  };
}

function allProjectObjectSummaries(
  snapshot: Snapshot,
  projectId: string,
): ProjectObjectSummaryDto[] {
  const project = snapshot.entities.projects[projectId];
  const projectConfigurations = Object.values(
    snapshot.entities.projectConfigurationRevisions,
  ).filter((item) => item.projectId === projectId);
  const latestAdoptedConfigurationVersion = Math.max(
    0,
    ...projectConfigurations
      .filter((item) => item.status === "adopted")
      .map((item) => item.version),
  );
  return [
    ...(project === undefined
      ? []
      : [
          summary({
            kind: "project",
            objectId: project.projectId,
            title: project.name,
            revision: project.revision,
            status: project.status,
            occurredAt: project.createdAt,
            updatedAt: project.updatedAt,
          }),
        ]),
    ...Object.values(snapshot.entities.projectProfileRevisions)
      .filter((item) =>
        Object.values(snapshot.entities.projectConfigurationRevisions).some(
          (configuration) =>
            configuration.projectId === projectId &&
            configuration.profileRevisionId === item.projectProfileRevisionId,
        ),
      )
      .map((item) =>
        summary({
          kind: "profile",
          objectId: item.projectProfileRevisionId,
          title: `${item.title} · v${String(item.version)}`,
          revision: item.revision,
          status: item.status,
          occurredAt: item.createdAt,
          updatedAt: item.updatedAt,
        }),
      ),
    ...projectConfigurations.map((item) =>
      summary({
        kind: "configuration",
        objectId: item.projectConfigurationRevisionId,
        title: `管理配置 · v${String(item.version)}`,
        revision: item.revision,
        status: item.status,
        occurredAt: item.createdAt,
        updatedAt: item.updatedAt,
        relationIds: [item.profileRevisionId, ...item.participantIds],
        attentionReasons:
          item.status === "candidate" && item.version > latestAdoptedConfigurationVersion
            ? ["Configuration等待用户采用或拒绝"]
            : [],
      }),
    ),
    ...Object.values(snapshot.entities.projectNeeds)
      .filter((item) => item.projectId === projectId)
      .map((item) =>
        summary({
          kind: "need",
          objectId: item.projectNeedId,
          title: item.statement,
          revision: item.revision,
          status: item.status,
          occurredAt: item.occurredAt,
          updatedAt: item.updatedAt,
          ...(item.commitmentDecisionId === undefined
            ? {}
            : { relationIds: [item.commitmentDecisionId] }),
        }),
      ),
    ...Object.values(snapshot.entities.projectRequirements)
      .filter((item) => item.projectId === projectId)
      .map((item) =>
        summary({
          kind: "requirement",
          objectId: item.projectRequirementId,
          title: item.statement,
          revision: item.revision,
          status: item.status,
          updatedAt: item.updatedAt,
          relationIds: item.needIds,
          attentionReasons: item.status === "proposed" ? ["Requirement等待用户接受或修订"] : [],
        }),
      ),
    ...Object.values(snapshot.entities.projectWorks)
      .filter((item) => item.projectId === projectId)
      .map((item) =>
        summary({
          kind: "work",
          objectId: item.projectWorkId,
          title: item.title,
          revision: item.revision,
          status: item.status,
          updatedAt: item.updatedAt,
          relationIds: [...item.dependsOn, ...item.resourceRefs],
          attentionReasons:
            item.status === "blocked" || item.activeBlockId !== undefined
              ? ["Work存在活动Block"]
              : item.status === "review" ||
                  item.status === "needs_review" ||
                  item.status === "proposed"
                ? ["Work等待用户确认或审核"]
                : [],
        }),
      ),
    ...Object.values(snapshot.entities.projectActions)
      .filter((item) => item.projectId === projectId)
      .map((item) =>
        summary({
          kind: "action",
          objectId: item.projectActionId,
          title: item.title,
          revision: item.revision,
          status: item.status,
          updatedAt: item.updatedAt,
          ...(item.dueAt === undefined ? {} : { dueAt: item.dueAt }),
          relationIds: [item.workId, item.ownerParticipantId],
          evidenceIds: item.completedEvidenceIds,
          attentionReasons: item.status === "blocked" ? [item.blockedReason ?? "Action阻塞"] : [],
        }),
      ),
    ...Object.values(snapshot.entities.projectWorkClaims)
      .filter((item) => item.projectId === projectId)
      .map((item) =>
        summary({
          kind: "claim",
          objectId: item.projectWorkClaimId,
          title: `Agent Claim: ${item.workId}`,
          revision: item.revision,
          status: item.status,
          occurredAt: item.acquiredAt,
          updatedAt: item.updatedAt,
          dueAt: item.leaseExpiresAt,
          relationIds: [item.workId, item.participantId],
        }),
      ),
    ...Object.values(snapshot.entities.projectWorkBlocks)
      .filter((item) => item.projectId === projectId)
      .map((item) =>
        summary({
          kind: "block",
          objectId: item.projectWorkBlockId,
          title: item.reason,
          revision: item.revision,
          status: item.status,
          occurredAt: item.createdAt,
          updatedAt: item.updatedAt,
          relationIds: [item.workId, item.reportedByParticipantId],
          evidenceIds: item.resolvedEvidenceIds,
          attentionReasons: item.status === "active" ? [item.reason] : [],
        }),
      ),
    ...Object.values(snapshot.entities.projectWorkHandoffs)
      .filter((item) => item.projectId === projectId)
      .map((item) =>
        summary({
          kind: "handoff",
          objectId: item.projectWorkHandoffId,
          title: `Handoff: ${item.nextStep}`,
          revision: item.revision,
          status: "recorded",
          occurredAt: item.createdAt,
          updatedAt: item.updatedAt,
          relationIds: [
            item.workId,
            item.fromParticipantId,
            ...(item.toParticipantId === undefined ? [] : [item.toParticipantId]),
          ],
          evidenceIds: item.evidenceIds,
        }),
      ),
    ...Object.values(snapshot.entities.projectContributions)
      .filter((item) => item.projectId === projectId)
      .map((item) =>
        summary({
          kind: item.kind === "review" ? "review" : "activity",
          objectId: item.projectContributionId,
          title: item.summary,
          revision: item.revision,
          status: item.evidenceStatus,
          occurredAt: item.occurredAt,
          updatedAt: item.updatedAt,
          relationIds: [item.participantId, ...(item.workId === undefined ? [] : [item.workId])],
          evidenceIds: item.evidenceIds,
        }),
      ),
    ...Object.values(snapshot.entities.projectResources)
      .filter((item) => item.projectId === projectId)
      .map((item) =>
        summary({
          kind: "resource",
          objectId: item.projectResourceId,
          title: item.displayName,
          revision: item.revision,
          status: item.status,
          updatedAt: item.updatedAt,
          attentionReasons: item.status === "unavailable" ? ["Resource当前不可用"] : [],
        }),
      ),
    ...Object.values(snapshot.entities.projectArtifactRefs)
      .filter((item) => item.projectId === projectId)
      .map((item) =>
        summary({
          kind: "artifact",
          objectId: item.projectArtifactRefId,
          title: `${item.role}: ${item.locator}`,
          revision: item.revision,
          status: item.status,
          occurredAt: item.observedAt,
          updatedAt: item.updatedAt,
          relationIds: [item.resourceId, ...item.provenanceEventIds],
        }),
      ),
    ...Object.values(snapshot.entities.projectEvidence)
      .filter((item) => item.projectId === projectId)
      .map((item) =>
        summary({
          kind: "evidence",
          objectId: item.projectEvidenceId,
          title: item.label,
          revision: item.revision,
          status: item.verification,
          occurredAt: item.observedAt,
          updatedAt: item.updatedAt,
          relationIds: [
            ...(item.workId === undefined ? [] : [item.workId]),
            ...(item.resourceId === undefined ? [] : [item.resourceId]),
          ],
        }),
      ),
    ...Object.values(snapshot.entities.projectDecisions)
      .filter((item) => item.projectId === projectId)
      .map((item) =>
        summary({
          kind: "decision",
          objectId: item.projectDecisionId,
          title: `${item.question} → ${item.choice}`,
          revision: item.revision,
          status: item.status,
          occurredAt: item.createdAt,
          updatedAt: item.updatedAt,
          relationIds: [item.decidedByParticipantId],
        }),
      ),
    ...Object.values(snapshot.entities.projectPracticeRevisions)
      .filter((item) => item.projectId === projectId)
      .map((item) =>
        summary({
          kind: "practice",
          objectId: item.projectPracticeRevisionId,
          title: `${item.practiceKey} · v${String(item.version)}`,
          revision: item.revision,
          status: item.status,
          occurredAt: item.createdAt,
          updatedAt: item.updatedAt,
          evidenceIds: [item.artifactEvidenceId],
        }),
      ),
    ...Object.values(snapshot.entities.projectWorkOutcomes)
      .filter((item) => item.projectId === projectId)
      .map((item) =>
        summary({
          kind: "publication",
          objectId: item.projectWorkOutcomeId,
          title: `${item.platform} · ${item.workId}`,
          revision: item.revision,
          status: item.status,
          occurredAt: item.publishedAt,
          updatedAt: item.updatedAt,
          relationIds: [item.workId],
          evidenceIds: [item.contentRevisionEvidenceId, item.publicationEvidenceId],
        }),
      ),
    ...Object.values(snapshot.entities.projectMetricObservations)
      .filter((item) => item.projectId === projectId)
      .map((item) =>
        summary({
          kind: "metric",
          objectId: item.projectMetricObservationId,
          title: `${item.metricKey}: ${String(item.value)} ${item.unit}`,
          revision: item.revision,
          occurredAt: item.observedAt,
          updatedAt: item.updatedAt,
          evidenceIds: item.evidenceIds,
        }),
      ),
    ...Object.values(snapshot.entities.projectEvents)
      .filter((item) => item.projectId === projectId)
      .map((item) =>
        summary({
          kind: "event",
          objectId: item.projectEventId,
          title: item.eventType,
          revision: item.revision,
          occurredAt: item.occurredAt,
          updatedAt: item.recordedAt,
          relationIds: [item.subject.objectId],
          evidenceIds: item.evidenceIds,
        }),
      ),
  ];
}

function isReviewObject(item: ProjectObjectSummaryDto): boolean {
  return (
    (item.kind === "configuration" && item.attentionReasons.length > 0) ||
    (item.kind === "requirement" && item.status === "proposed") ||
    (item.kind === "work" &&
      (item.status === "review" || item.status === "needs_review" || item.status === "proposed"))
  );
}

/** 用户View与Agent Context共享同一对象投影；筛选只发生在Application读模型。 */
export async function queryProjectObjects(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly projectId: string;
    readonly query: ProjectObjectQuery;
  },
): Promise<{ result: ProjectObjectQueryResultDto }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const project = ownedProject(snapshot, input.projectId, input.principalId);
  const query = projectObjectQuerySchema.parse(input.query);
  const needle = query.q?.toLocaleLowerCase("zh-CN");
  const filtered = allProjectObjectSummaries(snapshot, project.projectId)
    .filter((item) => query.kind === undefined || item.kind === query.kind)
    .filter((item) => query.status === undefined || item.status === query.status)
    .filter((item) => query.view !== "review" || isReviewObject(item))
    .filter((item) => query.view !== "attention" || item.attentionReasons.length > 0)
    .filter(
      (item) =>
        needle === undefined ||
        item.title.toLocaleLowerCase("zh-CN").includes(needle) ||
        item.objectId.toLocaleLowerCase("zh-CN").includes(needle) ||
        item.status?.toLocaleLowerCase("zh-CN").includes(needle) === true,
    )
    .sort((a, b) =>
      (b.updatedAt ?? b.occurredAt ?? "").localeCompare(a.updatedAt ?? a.occurredAt ?? ""),
    );
  return {
    result: projectObjectQueryResultDtoSchema.parse({
      schemaVersion: PROJECT_MANAGEMENT_API_VERSION,
      projectId: project.projectId,
      query,
      total: filtered.length,
      items: filtered.slice(0, query.limit),
      generatedAt: deps.now(),
    }),
  };
}

function objectCounts(
  catalog: readonly { kind: ProjectManagedObjectKind }[],
  summaries: readonly ProjectObjectSummaryDto[],
): Record<ProjectManagedObjectKind, number> {
  const counts = Object.fromEntries(catalog.map((item) => [item.kind, 0])) as Record<
    ProjectManagedObjectKind,
    number
  >;
  for (const item of summaries) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  counts.project = 1;
  counts.profile = 1;
  return counts;
}

export async function getProjectHome(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId; readonly projectId: string },
): Promise<{ projectHome: ProjectHomeDto }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const project = ownedProject(snapshot, input.projectId, input.principalId);
  const { configuration, profile } = currentConfiguration(snapshot, input.projectId);
  const objects = allProjectObjectSummaries(snapshot, input.projectId);
  const eventObjects = objects
    .filter((item) => item.kind === "event")
    .sort((a, b) => (b.occurredAt ?? "").localeCompare(a.occurredAt ?? ""))
    .slice(0, 40);
  const attention = objects
    .filter((item) => item.attentionReasons.length > 0)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, 100);
  const projectHome = projectHomeDtoSchema.parse({
    schemaVersion: PROJECT_MANAGEMENT_API_VERSION,
    projectId: project.projectId,
    name: project.name,
    status: project.status,
    revision: project.revision,
    objective: configuration.objective,
    profile: {
      profileKey: profile.profileKey,
      title: profile.title,
      version: profile.version,
      sha256: profile.sha256,
    },
    configuration: {
      projectConfigurationRevisionId: configuration.projectConfigurationRevisionId,
      version: configuration.version,
      sha256: configuration.sha256,
      effectiveFrom: configuration.effectiveFrom,
      timezone: configuration.timezone,
      schedulePolicy: configuration.schedulePolicy,
    },
    objectCounts: objectCounts(profile.objectCatalog, objects),
    attention,
    recentEvents: eventObjects,
    presentationSurfaces: profile.viewRequirements.map((requirement) => {
      const disabled = new Set(deps.disabledProjectProviderKinds ?? []);
      const binding = configuration.presentationBindings.find(
        (candidate) =>
          candidate.capability === requirement.capability &&
          candidate.mode === "primary" &&
          !disabled.has(candidate.providerKind),
      );
      const fallback = configuration.presentationBindings.find(
        (candidate) =>
          candidate.capability === requirement.capability &&
          candidate.mode === "fallback" &&
          !disabled.has(candidate.providerKind),
      );
      const selected = binding ?? fallback;
      return {
        ...requirement,
        binding:
          selected === undefined
            ? null
            : {
                providerKind: selected.providerKind,
                bindingRef: selected.bindingRef,
                mode: selected.mode,
              },
        availability:
          binding !== undefined
            ? "bound"
            : fallback !== undefined || requirement.fallbackIntent !== "unsupported"
              ? "fallback"
              : "unavailable",
      };
    }),
    generatedAt: deps.now(),
  });
  return { projectHome };
}

function contextSummary(item: ProjectObjectSummaryDto): string {
  const parts = [item.title];
  if (item.status !== undefined) parts.push(`status=${item.status}`);
  if (item.dueAt !== undefined) parts.push(`dueAt=${item.dueAt}`);
  if (item.attentionReasons.length > 0) parts.push(`attention=${item.attentionReasons.join("；")}`);
  return parts.join(" | ");
}

export async function compileProjectAgentContext(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly projectId: string;
    readonly purpose: ProjectContextPurpose;
  },
): Promise<{ context: ProjectAgentContextDto }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const project = ownedProject(snapshot, input.projectId, input.principalId);
  const { configuration, profile } = currentConfiguration(snapshot, input.projectId);
  const policy = profile.contextPolicies.find((candidate) => candidate.purpose === input.purpose);
  if (policy === undefined) throw notFound(`Profile缺少Context政策:${input.purpose}`);
  const allObjects = allProjectObjectSummaries(snapshot, input.projectId)
    .filter((item) => policy.objectKinds.includes(item.kind))
    .sort((a, b) =>
      (b.updatedAt ?? b.occurredAt ?? "").localeCompare(a.updatedAt ?? a.occurredAt ?? ""),
    );
  const omissions: string[] = [];
  const selected: Array<ProjectObjectSummaryDto & { summary: string }> = [];
  let usedCharacters = 0;
  for (const item of allObjects) {
    if (selected.length >= policy.maxObjects) {
      omissions.push(`达到maxObjects=${String(policy.maxObjects)}，省略剩余对象`);
      break;
    }
    const text = contextSummary(item);
    if (usedCharacters + text.length > policy.maxCharacters) {
      omissions.push(`达到maxCharacters=${String(policy.maxCharacters)}，省略对象${item.objectId}`);
      continue;
    }
    usedCharacters += text.length;
    selected.push({ ...item, summary: text });
  }
  const recentEventIds = Object.values(snapshot.entities.projectEvents)
    .filter((event) => event.projectId === input.projectId)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, policy.recentEventLimit)
    .map((event) => event.projectEventId);
  const compiledAt = deps.now();
  const hashInput = {
    purpose: input.purpose,
    projectId: project.projectId,
    profileRevisionId: profile.projectProfileRevisionId,
    profileRevisionSha256: profile.sha256,
    configurationRevisionId: configuration.projectConfigurationRevisionId,
    configurationRevisionSha256: configuration.sha256,
    objective: configuration.objective,
    timezone: configuration.timezone,
    schedulePolicy: configuration.schedulePolicy,
    items: selected,
    resourceBindings: configuration.resourceBindings,
    recentEventIds,
    requiredReads: configuration.requiredReads,
    omissions,
    compiledAt,
  };
  const context = projectAgentContextDtoSchema.parse({
    schemaVersion: PROJECT_MANAGEMENT_API_VERSION,
    ...hashInput,
    sha256: hashCanonical("project-agent-context.v1", hashInput),
  });
  return { context };
}

export async function evaluateProjectMaintenance(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly projectId: string;
    readonly trigger:
      | "agent_started"
      | "agent_finished"
      | "resource_changed"
      | "provider_changed"
      | "deadline"
      | "daily"
      | "weekly"
      | "monthly"
      | "manual";
  },
): Promise<{ maintenance: ProjectMaintenancePlanDto }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  ownedProject(snapshot, input.projectId, input.principalId);
  const { configuration, profile } = currentConfiguration(snapshot, input.projectId);
  const cadenceByKey = new Map<
    string,
    {
      cadence: (typeof profile.maintenanceCadences)[number];
      source: "Profile" | "Configuration";
    }
  >(
    profile.maintenanceCadences.map((cadence) => [
      cadence.key,
      { cadence, source: "Profile" as const },
    ]),
  );
  for (const cadence of configuration.schedulePolicy.cadences) {
    cadenceByKey.set(cadence.key, { cadence, source: "Configuration" });
  }
  const cadences = [...cadenceByKey.values()].filter(
    ({ cadence }) => cadence.trigger === input.trigger,
  );
  const objects = allProjectObjectSummaries(snapshot, input.projectId);
  const now = deps.now();
  const items = cadences.map(({ cadence, source }) => ({
    cadenceKey: cadence.key,
    action: cadence.action,
    reason:
      source === "Profile"
        ? `Profile ${profile.profileKey}@${String(profile.version)} 在${input.trigger}触发${cadence.action}`
        : `Project Configuration ${configuration.projectConfigurationRevisionId} 在${input.trigger}触发${cadence.action}`,
    ...(input.trigger === "deadline" && configuration.schedulePolicy.targetAt !== undefined
      ? { dueAt: configuration.schedulePolicy.targetAt }
      : {}),
    requiresHumanDecision: cadence.action === "review",
    proposedCommandType:
      cadence.action === "observe"
        ? "ObserveProjectResource"
        : cadence.action === "reconcile"
          ? "ReconcileProjectProvider"
          : cadence.action === "report"
            ? "PrepareProjectReportCandidate"
            : cadence.action === "review"
              ? "PrepareProjectReviewCandidate"
              : "RecordProjectAttention",
  }));
  for (const object of objects) {
    const overdue = object.dueAt !== undefined && object.dueAt < now && object.status !== "done";
    if (object.attentionReasons.length === 0 && !overdue) continue;
    items.push({
      cadenceKey: `attention-${object.objectId}`,
      action: "attention",
      reason: overdue
        ? `${object.kind} ${object.objectId} 已过期`
        : `${object.kind} ${object.objectId}: ${object.attentionReasons.join("；")}`,
      requiresHumanDecision: false,
      proposedCommandType: "RecordProjectAttention",
    });
  }
  const maintenance = projectMaintenancePlanDtoSchema.parse({
    schemaVersion: PROJECT_MANAGEMENT_API_VERSION,
    projectId: configuration.projectId,
    trigger: input.trigger,
    items,
    evaluatedAt: now,
  });
  return { maintenance };
}
