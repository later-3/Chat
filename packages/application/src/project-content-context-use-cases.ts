import type {
  ContentLabContextBundle,
  ContentLabContextSelection,
  PrincipalId,
  ProjectDecision,
  ProjectEvidence,
  ProjectWork,
} from "@chat/contracts";
import type { ApplicationDeps } from "./deps.js";
import { forbidden, notFound, revisionConflict } from "./errors.js";

export interface ContentLabProjectContextBundle {
  readonly schemaVersion: "content-lab-project-context.v1";
  readonly project: {
    readonly projectId: string;
    readonly revision: number;
    readonly methodSnapshotId: string;
    readonly contextMapId: string;
    readonly contextMapRevision: number;
    readonly contextMapSha256: string;
  };
  readonly work: {
    readonly projectWorkId: string;
    readonly workKey: string;
    readonly kind: "content_delivery" | "workflow_improvement";
    readonly status: string;
    readonly title: string;
    readonly objective: string;
    readonly acceptanceCriteria: readonly string[];
    readonly resourceRefs: readonly string[];
    readonly revision: number;
  };
  readonly resource: {
    readonly projectResourceId: string;
    readonly projectObservationId: string;
    readonly observationSha256: string;
    readonly changeCandidateClassification: "baseline" | "none" | "review_required";
  };
  readonly decisions: readonly Pick<
    ProjectDecision,
    | "projectDecisionId"
    | "choice"
    | "rationale"
    | "status"
    | "boundProjectRevision"
    | "boundWorkRevision"
  >[];
  readonly evidence: readonly Pick<
    ProjectEvidence,
    | "projectEvidenceId"
    | "role"
    | "verification"
    | "label"
    | "revisionRef"
    | "sha256"
    | "observedAt"
  >[];
  readonly resourceContext: ContentLabContextBundle;
}

/**
 * Agent上下文由Chat权威事实和只读Resource快照共同编译；这里不发外部请求，
 * 也不把目录变化自动解释为Published/Adopted。
 */
export async function compileContentLabProjectContext(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly projectId: string;
    readonly resourceId: string;
    readonly workId: string;
  },
): Promise<ContentLabProjectContextBundle> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const project = snapshot.entities.projects[input.projectId];
  const resource = snapshot.entities.projectResources[input.resourceId];
  const work = snapshot.entities.projectWorks[input.workId];
  if (project === undefined) throw notFound("Project不存在");
  if (project.ownerPrincipalId !== input.principalId) throw forbidden("无权编译Project上下文");
  if (resource?.projectId !== project.projectId || resource.status !== "active") {
    throw notFound("Content Lab Project Resource不存在或不可用");
  }
  if (
    work?.projectId !== project.projectId ||
    (work.kind !== "content_delivery" && work.kind !== "workflow_improvement")
  ) {
    throw notFound("Content Lab Work不存在");
  }
  const method = snapshot.entities.projectMethodSnapshots[project.methodSnapshotId];
  if (method?.profileId !== "content-production.v1") {
    throw revisionConflict("只有content-production.v1 Project可以编译Content Lab上下文");
  }
  const contextMap = Object.values(snapshot.entities.projectContextMaps).find(
    (item) =>
      item.projectId === project.projectId &&
      item.methodSnapshotId === method.projectMethodSnapshotId &&
      item.status === "active",
  );
  if (contextMap === undefined) throw revisionConflict("Content Lab缺少活动Context Map");
  const observation = Object.values(snapshot.entities.projectObservations)
    .filter(
      (item) =>
        item.resourceId === resource.projectResourceId && item.data.contentLab !== undefined,
    )
    .sort((left, right) => right.observedAt.localeCompare(left.observedAt))[0];
  if (observation?.data.contentLab === undefined) {
    throw revisionConflict("Content Lab尚未建立资源Observation");
  }
  const compiler = deps.projectRoots?.compileContentLabContext;
  if (compiler === undefined) throw revisionConflict("Content Lab上下文Compiler未配置");
  const resourceContext = await compiler.call(deps.projectRoots, {
    rootId: resource.rootId,
    observationSha256: observation.sha256,
    observation: observation.data.contentLab,
    selection: contextSelection(work),
  });
  const decisions = Object.values(snapshot.entities.projectDecisions)
    .filter(
      (item) =>
        item.projectId === project.projectId &&
        item.status === "active" &&
        (item.boundWorkId === undefined || item.boundWorkId === work.projectWorkId),
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 20)
    .map((item) => ({
      projectDecisionId: item.projectDecisionId,
      choice: item.choice,
      rationale: item.rationale,
      status: item.status,
      boundProjectRevision: item.boundProjectRevision,
      ...(item.boundWorkRevision === undefined
        ? {}
        : { boundWorkRevision: item.boundWorkRevision }),
    }));
  const evidence = Object.values(snapshot.entities.projectEvidence)
    .filter(
      (item) =>
        item.projectId === project.projectId &&
        (item.workId === work.projectWorkId || item.resourceId === resource.projectResourceId),
    )
    .sort((left, right) => right.observedAt.localeCompare(left.observedAt))
    .slice(0, 20)
    .map((item) => ({
      projectEvidenceId: item.projectEvidenceId,
      role: item.role,
      verification: item.verification,
      label: item.label,
      revisionRef: item.revisionRef,
      sha256: item.sha256,
      observedAt: item.observedAt,
    }));
  return {
    schemaVersion: "content-lab-project-context.v1",
    project: {
      projectId: project.projectId,
      revision: project.revision,
      methodSnapshotId: method.projectMethodSnapshotId,
      contextMapId: contextMap.projectContextMapId,
      contextMapRevision: contextMap.revision,
      contextMapSha256: contextMap.sha256,
    },
    work: {
      projectWorkId: work.projectWorkId,
      workKey: work.workKey,
      kind: work.kind,
      status: work.status,
      title: work.title,
      objective: work.objective,
      acceptanceCriteria: work.acceptanceCriteria,
      resourceRefs: work.resourceRefs,
      revision: work.revision,
    },
    resource: {
      projectResourceId: resource.projectResourceId,
      projectObservationId: observation.projectObservationId,
      observationSha256: observation.sha256,
      changeCandidateClassification: observation.changeCandidate?.classification ?? "none",
    },
    decisions,
    evidence,
    resourceContext,
  };
}

function contextSelection(
  work: Extract<ProjectWork, { kind: "content_delivery" | "workflow_improvement" }>,
): ContentLabContextSelection {
  if (work.kind === "workflow_improvement") {
    return {
      workKind: work.kind,
      targetPlatforms: platformRefs(work.resourceRefs),
      resourceRefs: work.resourceRefs,
    };
  }
  const targetPlatforms = work.content.targetPlatforms
    .map(normalizePlatform)
    .filter((value): value is "xiaohongshu" | "bilibili" => value !== undefined);
  return {
    workKind: work.kind,
    targetPlatforms: [...new Set(targetPlatforms)],
    sourceRef: work.content.sourceRef,
    ...(work.content.seriesKey === undefined ? {} : { seriesKey: work.content.seriesKey }),
    resourceRefs: work.resourceRefs,
  };
}

function platformRefs(refs: readonly string[]): ("xiaohongshu" | "bilibili")[] {
  const platforms = new Set<"xiaohongshu" | "bilibili">();
  for (const ref of refs) {
    if (/(?:xiaohongshu|\bxhs\b)/iu.test(ref)) platforms.add("xiaohongshu");
    if (/bilibili/iu.test(ref)) platforms.add("bilibili");
  }
  return [...platforms];
}

function normalizePlatform(value: string): "xiaohongshu" | "bilibili" | undefined {
  if (value === "xiaohongshu" || value === "xhs") return "xiaohongshu";
  if (value === "bilibili") return "bilibili";
  return undefined;
}
