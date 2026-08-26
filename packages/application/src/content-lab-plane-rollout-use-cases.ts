import {
  contentLabPlaneRolloutExecutionSchema,
  contentLabPlaneRolloutDryRunSchema,
  type ContentLabContextSelection,
  type ContentLabJob,
  type ContentLabPlaneRolloutDryRun,
  type ContentLabPlaneRolloutDryRunQuery,
  type ContentLabPlaneRolloutExecution,
  type ContentLabPlaneRolloutOperation,
  type ContentLabPlaneRolloutSample,
  type PrincipalId,
} from "@chat/contracts";
import { computeProjectObservationSha256, hashCanonical } from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import { notFound, revisionConflict } from "./errors.js";
import type { PlaneProjectRolloutInspection } from "./plane-project-rollout-ports.js";

const MAPPING_VERSION = "content-lab-plane-mapping.v1" as const;
const PROJECT_DESCRIPTION =
  "将感兴趣的视频内容转译、重构为适合中文平台发布的内容，并通过真实案例持续改进生产工作流。Plane用于查看与协作；Content Lab保存正文和媒体；Chat保存项目语义、决定、证据引用和Agent协调。";
const MANAGED_DESCRIPTION_PREFIX = `[managed:${MAPPING_VERSION}:`;

const DESIRED_STATES = [
  ["Intake", "backlog", "#60646C", 10],
  ["Proposed", "backlog", "#8B5CF6", 20],
  ["Selected", "unstarted", "#3B82F6", 30],
  ["Producing", "started", "#0EA5E9", 40],
  ["Experimenting", "started", "#8B5CF6", 50],
  ["Needs Review", "started", "#F59E0B", 60],
  ["Ready", "started", "#14B8A6", 70],
  ["Blocked", "started", "#EF4444", 80],
  ["Published", "completed", "#22C55E", 90],
  ["Adopted", "completed", "#16A34A", 100],
  ["Dropped", "cancelled", "#6B7280", 110],
  ["Rejected", "cancelled", "#9F1239", 120],
] as const;
const DESIRED_MODULES = [
  ["xiaohongshu-delivery", "小红书内容交付"],
  ["bilibili-delivery", "B站内容交付"],
  ["workflow-improvement", "工作流持续改进"],
] as const;
const BASE_LABELS = [
  ["kind:content", "#2563EB"],
  ["kind:practice", "#7C3AED"],
  ["platform:xiaohongshu", "#E11D48"],
  ["platform:bilibili", "#00A1D6"],
  ["executor:codex", "#111827"],
  ["executor:pi", "#F59E0B"],
  ["executor:chat", "#10B981"],
] as const;
const DESIRED_VIEWS = [
  view("01 当前执行", { state: ["Producing", "Experimenting"] }, "list", "module"),
  view("02 待我审核", { state: ["Needs Review"] }, "list", null),
  view("03 待发布", { state: ["Ready"] }, "calendar", null),
  view("04 阻塞与恢复", { state: ["Blocked"] }, "list", "module"),
  view("05 最近确认发布", { state: ["Published"] }, "list", null, "-updated_at"),
  view("06 内容流水线", { labels: ["kind:content"] }, "kanban", "state"),
  view("07 工作流改进", { labels: ["kind:practice"] }, "kanban", "state"),
  view("08 按系列观察", { labelPrefix: "series:" }, "list", "labels"),
  view("09 全部历史", {}, "spreadsheet", null, "-updated_at"),
] as const;
const DESIRED_PAGES = [
  managedPage("navigation", "Content Lab 项目导航"),
  managedPage("publication-history", "发布历史"),
  managedPage("practice-index", "工作流版本索引"),
  managedPage("series-case-index", "系列与案例索引"),
  humanPage("quality-review", "质量与审核清单"),
  humanPage("xiaohongshu-rules", "平台规则：小红书"),
  humanPage("bilibili-rules", "平台规则：B站"),
  humanPage("weekly-review", "周度复盘"),
] as const;

export async function previewContentLabPlaneRollout(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly query: ContentLabPlaneRolloutDryRunQuery;
  },
): Promise<{ dryRun: ContentLabPlaneRolloutDryRun }> {
  const { snapshot: readonlySnapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const snapshot = structuredClone(readonlySnapshot);
  const project = snapshot.entities.projects[input.query.projectId];
  if (project === undefined || project.ownerPrincipalId !== input.principalId) {
    throw notFound("Content Lab Project不存在");
  }
  const method = snapshot.entities.projectMethodSnapshots[project.methodSnapshotId];
  if (method?.profileId !== "content-production.v1") {
    throw revisionConflict("P8 Dry Run只接受content-production.v1 Project");
  }
  const port = deps.planeProjectRolloutInspection;
  const roots = deps.projectRoots;
  if (port === undefined) throw revisionConflict("Plane管理员只读预检未配置");
  if (roots === undefined) throw revisionConflict("Project Root Registry未配置");
  if (!port.describe().allowedWorkspaceSlugs.includes(input.query.planeWorkspaceSlug)) {
    throw revisionConflict("Plane Workspace不在管理员预检白名单");
  }
  const resources = Object.values(snapshot.entities.projectResources).filter(
    (resource) =>
      resource.projectId === project.projectId &&
      resource.rootId === input.query.workspaceRootId &&
      resource.status === "active",
  );
  if (resources.length !== 1 || resources[0] === undefined) {
    throw revisionConflict("Content Lab Project没有唯一活动Resource");
  }
  const descriptor = roots.list().find((root) => root.rootId === input.query.workspaceRootId);
  if (descriptor === undefined || !descriptor.enabledAdapters.includes("content-lab-resource.v1")) {
    throw revisionConflict("Workspace Root未启用Content Lab只读Adapter");
  }

  const [observed, inspection] = await Promise.all([
    roots.observe(input.query.workspaceRootId),
    port.inspectProject({
      workspaceSlug: input.query.planeWorkspaceSlug,
      projectIdentifier: input.query.planeProjectIdentifier,
    }),
  ]);
  const contentLab = observed.data.contentLab;
  if (contentLab === undefined) throw revisionConflict("Content Lab观察结果缺失");
  const observationSha256 = computeProjectObservationSha256(observed.data);
  const samples = await selectSamples(deps, {
    rootId: input.query.workspaceRootId,
    observationSha256,
    observation: contentLab,
  });
  const operations = compileOperations(inspection, contentLab.jobs, samples);
  const warnings = extraObjectWarnings(inspection);
  const blockers = operations
    .filter((operation) => operation.action === "manual_review")
    .map((operation) => `${operation.targetKind}:${operation.displayName}需要人工处置`);
  const summary = {
    noop: operations.filter((operation) => operation.action === "noop").length,
    create: operations.filter((operation) => operation.action === "create").length,
    update: operations.filter((operation) => operation.action === "update").length,
    manualReview: operations.filter((operation) => operation.action === "manual_review").length,
    destructive: 0 as const,
  };
  const generatedAt = deps.now();
  const inspectionSha256 = hashCanonical("plane-rollout-inspection.v1", inspection);
  const core = {
    schemaVersion: "content-lab-plane-rollout.v1" as const,
    mode: "dry_run" as const,
    mappingVersion: MAPPING_VERSION,
    project: {
      projectId: project.projectId,
      projectRevision: project.revision,
      methodProfileId: "content-production.v1" as const,
      workspaceRootId: input.query.workspaceRootId,
      resourceObservationSha256: observationSha256,
    },
    plane: {
      providerVersion: "1.4.1" as const,
      workspaceSlug: input.query.planeWorkspaceSlug,
      projectId: inspection.project.id,
      projectIdentifier: inspection.project.identifier,
      projectName: inspection.project.name,
      inspectionSha256,
      surfaceAvailability: inspection.surfaceAvailability,
      capturedAt: generatedAt,
    },
    currentCounts: {
      states: inspection.states.length,
      modules: inspection.modules.length,
      labels: inspection.labels.length,
      views: inspection.views.length,
      pages: inspection.pages.length,
      intakes: inspection.intakes.length,
      workItems: inspection.workItems.length,
    },
    samples,
    operations,
    summary,
    blockers,
    warnings,
    executionAuthorized: false as const,
    planeWrites: 0 as const,
    generatedAt,
  };
  const dryRun = contentLabPlaneRolloutDryRunSchema.parse({
    ...core,
    dryRunSha256: hashCanonical("content-lab-plane-rollout-dry-run.v1", rolloutHashInput(core)),
  });
  return { dryRun };
}

export async function executeContentLabPlaneRollout(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly query: ContentLabPlaneRolloutDryRunQuery;
    readonly approvedDryRunSha256: string;
    readonly resumeAfterProjectPatch?: {
      readonly approvedResourceObservationSha256: string;
      readonly approvedBeforeInspectionSha256: string;
    };
    readonly resumeAfterCandidatePlacementConflict?: {
      readonly approvedResourceObservationSha256: string;
      readonly approvedBeforeInspectionSha256: string;
    };
    readonly reconcileCompletedRollout?: {
      readonly approvedResourceObservationSha256: string;
      readonly approvedBeforeInspectionSha256: string;
    };
  },
): Promise<{ execution: ContentLabPlaneRolloutExecution }> {
  const { dryRun } = await previewContentLabPlaneRollout(deps, {
    principalId: input.principalId,
    query: input.query,
  });
  const resumedAfterProjectPatch =
    dryRun.dryRunSha256 !== input.approvedDryRunSha256 &&
    input.resumeAfterProjectPatch !== undefined &&
    isRecognizedProjectPatchRecovery(dryRun, input.resumeAfterProjectPatch);
  const resumedAfterCandidatePlacementConflict =
    dryRun.dryRunSha256 !== input.approvedDryRunSha256 &&
    input.resumeAfterCandidatePlacementConflict !== undefined &&
    isRecognizedCandidatePlacementRecovery(dryRun, input.resumeAfterCandidatePlacementConflict);
  const reconciledCompletedRollout =
    dryRun.dryRunSha256 !== input.approvedDryRunSha256 &&
    input.reconcileCompletedRollout !== undefined &&
    isRecognizedCompletedRollout(dryRun, input.reconcileCompletedRollout);
  if (
    dryRun.dryRunSha256 !== input.approvedDryRunSha256 &&
    !resumedAfterProjectPatch &&
    !resumedAfterCandidatePlacementConflict &&
    !reconciledCompletedRollout
  ) {
    throw revisionConflict("P8批准Hash已失效，拒绝任何Plane写入");
  }
  const approvedOperationSet = reconciledCompletedRollout
    ? dryRun.summary.create === 0 &&
      dryRun.summary.update === 1 &&
      dryRun.summary.noop === 30 &&
      dryRun.summary.manualReview === 18
    : resumedAfterCandidatePlacementConflict
      ? dryRun.summary.create === 4 &&
        dryRun.summary.update === 1 &&
        dryRun.summary.noop === 26 &&
        dryRun.summary.manualReview === 18
      : dryRun.summary.create === 28 &&
        dryRun.summary.update === 1 &&
        dryRun.summary.noop === 2 &&
        dryRun.summary.manualReview === 18;
  if (!approvedOperationSet || dryRun.summary.destructive !== 0) {
    throw revisionConflict("P8批准的Operation集合已漂移，拒绝任何Plane写入");
  }
  const executionPort = deps.planeProjectRolloutExecution;
  const inspectionPort = deps.planeProjectRolloutInspection;
  if (executionPort === undefined) throw revisionConflict("Plane管理员执行Port未配置");
  if (inspectionPort === undefined) throw revisionConflict("Plane管理员预检Port未配置");
  if (!executionPort.describe().allowedWorkspaceSlugs.includes(dryRun.plane.workspaceSlug)) {
    throw revisionConflict("Plane Workspace不在管理员执行白名单");
  }

  const desiredLabels = dryRun.operations
    .filter((operation) => operation.targetKind === "label")
    .map((operation) => {
      const color =
        BASE_LABELS.find(([name]) => name === operation.displayName)?.[1] ??
        (operation.displayName.startsWith("series:") ? "#64748B" : undefined);
      if (color === undefined) throw revisionConflict("P8获批Label颜色不在固定映射中");
      return {
        stableKey: operation.stableKey,
        name: operation.displayName,
        color,
        externalId: `${MAPPING_VERSION}:label:${operation.displayName}`,
      };
    });
  if (desiredLabels.length !== 10) {
    throw revisionConflict("P8获批Label数量漂移，拒绝任何Plane写入");
  }
  const outcome = await executionPort.executeApprovedRollout({
    workspaceSlug: dryRun.plane.workspaceSlug,
    projectId: dryRun.plane.projectId,
    approvedDryRunSha256: input.approvedDryRunSha256,
    project: {
      stableKey: "project:content-lab",
      displayName: dryRun.plane.projectName,
      description: PROJECT_DESCRIPTION,
      // Plane CE 1.4.1的ProjectUpdateSerializer不接收network；首次尝试只更新了描述。
      // 恢复时保留已回读的Public值，避免重复发送一个已知无法满足的PATCH。
      network:
        resumedAfterProjectPatch ||
        resumedAfterCandidatePlacementConflict ||
        reconciledCompletedRollout
          ? 2
          : 0,
      moduleView: true,
      cycleView: false,
      issueViewsView: false,
      pageView: true,
      intakeView: false,
    },
    states: DESIRED_STATES.map(([name, group, color, sequence]) => ({
      stableKey: `state:${slug(name)}`,
      name,
      group,
      color,
      sequence,
    })),
    modules: DESIRED_MODULES.map(([key, name]) => ({
      stableKey: `module:${key}`,
      name,
      description: `Content Lab · ${name}`,
      externalId: `${MAPPING_VERSION}:module:${key}`,
    })),
    labels: desiredLabels,
    workItems: dryRun.samples.map((sample) => {
      const desiredState = DESIRED_STATES.find(([name]) => name === sample.desiredState);
      if (desiredState === undefined) throw revisionConflict("P8样本State不在固定映射中");
      const stateGroup = desiredState[1];
      if (stateGroup !== "backlog" && stateGroup !== "started") {
        throw revisionConflict("P8 Candidate不能进入终态或未开始State");
      }
      return {
        targetKind:
          sample.sampleKind === "workflow_improvement"
            ? ("workflow_improvement" as const)
            : ("history_work" as const),
        stableKey: `sample:${sample.sampleKind}`,
        name: sample.title,
        description: candidateDescription(sample),
        externalId: `chat-work:content-lab:${sample.workKey}`,
        stateName: sample.desiredState,
        stateGroup,
        moduleName: sample.moduleName,
        labelNames: sample.labels,
        priority: "medium" as const,
      };
    }),
  });
  const after = await inspectionPort.inspectProject({
    workspaceSlug: dryRun.plane.workspaceSlug,
    projectIdentifier: dryRun.plane.projectIdentifier,
  });
  const afterInspectionSha256 = hashCanonical("plane-rollout-inspection.v1", after);
  const objects = [...outcome.objects];
  return {
    execution: contentLabPlaneRolloutExecutionSchema.parse({
      schemaVersion: "content-lab-plane-rollout.v1",
      mode: "executed",
      approvedDryRunSha256: input.approvedDryRunSha256,
      beforeInspectionSha256:
        input.reconcileCompletedRollout?.approvedBeforeInspectionSha256 ??
        input.resumeAfterCandidatePlacementConflict?.approvedBeforeInspectionSha256 ??
        input.resumeAfterProjectPatch?.approvedBeforeInspectionSha256 ??
        dryRun.plane.inspectionSha256,
      afterInspectionSha256,
      planeWorkspaceSlug: dryRun.plane.workspaceSlug,
      planeProjectId: dryRun.plane.projectId,
      objects,
      summary: {
        created: objects.filter((item) => item.outcome === "created").length,
        updated: objects.filter((item) => item.outcome === "updated").length,
        reused: objects.filter((item) => item.outcome === "reused").length,
        writes: outcome.writes,
        destructive: 0,
        skippedManualReview: 18,
      },
      completedAt: deps.now(),
    }),
  };
}

function compileOperations(
  inspection: PlaneProjectRolloutInspection,
  jobs: readonly ContentLabJob[],
  samples: readonly ContentLabPlaneRolloutSample[],
): ContentLabPlaneRolloutOperation[] {
  const operations: ContentLabPlaneRolloutOperation[] = [];
  operations.push(projectManagedOperation(inspection));
  operations.push(projectManualConfigurationOperation(inspection));
  for (const desired of DESIRED_STATES) operations.push(stateOperation(inspection, desired));
  for (const desired of DESIRED_MODULES) operations.push(moduleOperation(inspection, desired));
  const series = [
    ...new Set(jobs.flatMap((job) => (job.seriesKey === undefined ? [] : [job.seriesKey]))),
  ]
    .sort()
    .map((key) => [`series:${key}`, "#64748B"] as const);
  for (const label of [...BASE_LABELS, ...series])
    operations.push(labelOperation(inspection, label));
  for (const desired of DESIRED_VIEWS) operations.push(viewOperation(inspection, desired));
  for (const desired of DESIRED_PAGES) operations.push(pageOperation(inspection, desired));
  operations.push(intakeOperation(inspection));
  for (const sample of samples) operations.push(sampleOperation(inspection, sample));
  return operations.sort(
    (left, right) =>
      left.targetKind.localeCompare(right.targetKind) ||
      left.stableKey.localeCompare(right.stableKey),
  );
}

function projectManagedOperation(
  inspection: PlaneProjectRolloutInspection,
): ContentLabPlaneRolloutOperation {
  const desired = {
    description: PROJECT_DESCRIPTION,
    moduleView: true,
    cycleView: false,
    pageView: true,
  };
  const changes = Object.entries(desired)
    .filter(([field, value]) => inspection.project[field as keyof typeof desired] !== value)
    .map(([field, value]) => ({
      field,
      before: inspection.project[field as keyof typeof desired] as string | number | boolean,
      after: value,
    }));
  return operation({
    targetKind: "project_configuration",
    stableKey: "project:content-lab:managed-fields",
    displayName: inspection.project.name,
    action: changes.length === 0 ? "noop" : "update",
    changes,
    reason: "只更新CE ProjectUpdateSerializer真实接收的受管字段；不创建同名Project。",
  });
}

function projectManualConfigurationOperation(
  inspection: PlaneProjectRolloutInspection,
): ContentLabPlaneRolloutOperation {
  const changes = [
    ...(inspection.project.network === 0
      ? []
      : [{ field: "network", before: inspection.project.network, after: 0 }]),
    ...(inspection.project.issueViewsView
      ? []
      : [{ field: "issueViewsView", before: false, after: true }]),
    ...(inspection.project.intakeView ? [] : [{ field: "intakeView", before: false, after: true }]),
  ];
  return operation({
    targetKind: "project_configuration",
    stableKey: "project:content-lab:manual-surfaces",
    displayName: `${inspection.project.name} · 可见性与可选表面`,
    action: changes.length === 0 ? "noop" : "manual_review",
    changes,
    reason:
      "真实CE证明Project API不接收network；Views与Intake按用户授权明确暂不执行，必须在登录态UI单独复核。",
  });
}

function stateOperation(
  inspection: PlaneProjectRolloutInspection,
  desired: (typeof DESIRED_STATES)[number],
): ContentLabPlaneRolloutOperation {
  const [name, group, color, sequence] = desired;
  const matches = inspection.states.filter((state) => state.name === name);
  if (matches.length === 0) {
    return operation({
      targetKind: "state",
      stableKey: `state:${slug(name)}`,
      displayName: name,
      action: "create",
      changes: [
        { field: "group", before: null, after: group },
        { field: "color", before: null, after: color },
        { field: "sequence", before: null, after: sequence },
      ],
      reason: "P3内容/方法生命周期需要该State。",
    });
  }
  if (matches.length > 1 || matches[0]?.group !== group) {
    return operation({
      targetKind: "state",
      stableKey: `state:${slug(name)}`,
      displayName: name,
      action: "manual_review",
      changes: [{ field: "group", before: matches[0]?.group ?? null, after: group }],
      reason: "同名State重复或Group冲突，自动修改可能改变现有人类Work语义。",
    });
  }
  return operation({
    targetKind: "state",
    stableKey: `state:${slug(name)}`,
    displayName: name,
    action: "noop",
    changes: [],
    reason: "同名同Group State直接复用，保留人类已有颜色、顺序和对象身份。",
  });
}

function moduleOperation(
  inspection: PlaneProjectRolloutInspection,
  desired: (typeof DESIRED_MODULES)[number],
): ContentLabPlaneRolloutOperation {
  const [key, name] = desired;
  const matches = inspection.modules.filter((module) => module.name === name);
  return operation({
    targetKind: "module",
    stableKey: `module:${key}`,
    displayName: name,
    action: matches.length === 0 ? "create" : matches.length === 1 ? "noop" : "manual_review",
    changes: matches.length === 0 ? [{ field: "name", before: null, after: name }] : [],
    reason:
      matches.length <= 1
        ? "Module表达稳定业务流；现有同名Module直接复用。"
        : "同名Module重复，必须先由用户选择保留对象。",
  });
}

function labelOperation(
  inspection: PlaneProjectRolloutInspection,
  desired: readonly [string, string],
): ContentLabPlaneRolloutOperation {
  const [name, color] = desired;
  const matches = inspection.labels.filter((label) => label.name === name);
  return operation({
    targetKind: "label",
    stableKey: `label:${name.replaceAll(":", "-")}`,
    displayName: name,
    action: matches.length === 0 ? "create" : matches.length === 1 ? "noop" : "manual_review",
    changes:
      matches.length === 0
        ? [
            { field: "name", before: null, after: name },
            { field: "color", before: null, after: color },
          ]
        : [],
    reason:
      matches.length <= 1
        ? "低基数受管分类；已有同名Label不被改色或重建。"
        : "同名Label重复会使投影不唯一。",
  });
}

function viewOperation(
  inspection: PlaneProjectRolloutInspection,
  desired: (typeof DESIRED_VIEWS)[number],
): ContentLabPlaneRolloutOperation {
  if (inspection.surfaceAvailability.views === "unavailable") {
    return operation({
      targetKind: "view",
      stableKey: desired.stableKey,
      displayName: desired.name,
      action: "manual_review",
      changes: [],
      reason: "当前CE实例的Project Views API不可读，必须通过真实浏览器确认后再配置。",
    });
  }
  const matches = inspection.views.filter(
    (viewItem) => viewItem.name === desired.name && !viewItem.archived,
  );
  const current = matches[0];
  const managed = current?.description.includes(desired.marker) === true;
  const exact =
    managed &&
    current?.filtersJson === desired.filtersJson &&
    current.displayFiltersJson === desired.displayFiltersJson;
  return operation({
    targetKind: "view",
    stableKey: desired.stableKey,
    displayName: desired.name,
    action:
      matches.length === 0
        ? "create"
        : matches.length > 1 || !managed
          ? "manual_review"
          : exact
            ? "noop"
            : "update",
    changes:
      matches.length === 0 || (managed && !exact)
        ? [
            { field: "filters", before: current?.filtersJson ?? null, after: desired.filtersJson },
            {
              field: "displayFilters",
              before: current?.displayFiltersJson ?? null,
              after: desired.displayFiltersJson,
            },
          ]
        : [],
    reason:
      matches.length === 0 || managed
        ? "创建或校正带受管标记的默认观察视角。"
        : "同名View属于人类配置，不能静默覆盖过滤/布局。",
  });
}

function pageOperation(
  inspection: PlaneProjectRolloutInspection,
  desired: (typeof DESIRED_PAGES)[number],
): ContentLabPlaneRolloutOperation {
  if (inspection.surfaceAvailability.pages === "unavailable") {
    return operation({
      targetKind: "page",
      stableKey: desired.stableKey,
      displayName: desired.name,
      action: "manual_review",
      changes: [],
      reason: "当前CE实例的Project Pages API不可读，不能把404解释为空集合或覆盖页面。",
    });
  }
  const byExternalId = inspection.pages.filter(
    (page) => page.externalSource === "later-agent" && page.externalId === desired.externalId,
  );
  const byName = inspection.pages.filter((page) => page.name === desired.name && !page.archived);
  if (!desired.managed) {
    return operation({
      targetKind: "page",
      stableKey: desired.stableKey,
      displayName: desired.name,
      action: byName.length === 0 ? "create" : byName.length === 1 ? "noop" : "manual_review",
      changes: byName.length === 0 ? [{ field: "name", before: null, after: desired.name }] : [],
      reason: "只创建人类协作Page入口；创建后Chat不拥有正文。",
    });
  }
  if (byExternalId.length > 1 || (byExternalId.length === 0 && byName.length > 0)) {
    return operation({
      targetKind: "page",
      stableKey: desired.stableKey,
      displayName: desired.name,
      action: "manual_review",
      changes: [],
      reason: "受管Page外部身份重复，或同名Page缺少受管身份，不能覆盖人类正文。",
    });
  }
  const current = byExternalId[0];
  const changes =
    current === undefined
      ? [
          { field: "name", before: null, after: desired.name },
          { field: "access", before: null, after: 1 },
          { field: "locked", before: null, after: true },
        ]
      : [
          ...(current.name === desired.name
            ? []
            : [{ field: "name", before: current.name, after: desired.name }]),
          ...(current.access === 1 ? [] : [{ field: "access", before: current.access, after: 1 }]),
          ...(current.locked ? [] : [{ field: "locked", before: current.locked, after: true }]),
        ];
  return operation({
    targetKind: "page",
    stableKey: desired.stableKey,
    displayName: desired.name,
    action: current === undefined ? "create" : changes.length === 0 ? "noop" : "update",
    changes,
    reason: "受管读模型Page使用稳定external ID、私有访问和锁定标记。",
  });
}

function intakeOperation(
  inspection: PlaneProjectRolloutInspection,
): ContentLabPlaneRolloutOperation {
  if (inspection.surfaceAvailability.intakes === "unavailable") {
    return operation({
      targetKind: "intake",
      stableKey: "intake:default",
      displayName: "Content Lab Intake",
      action: "manual_review",
      changes: [],
      reason: "当前CE实例的Intake API不可读，必须先用浏览器验证功能开关和默认对象关系。",
    });
  }
  const defaults = inspection.intakes.filter((intake) => intake.isDefault);
  return operation({
    targetKind: "intake",
    stableKey: "intake:default",
    displayName: defaults[0]?.name ?? "Content Lab Intake",
    action: defaults.length === 1 ? "noop" : "manual_review",
    changes:
      defaults.length === 0
        ? [{ field: "defaultIntake", before: null, after: "启用后由Plane创建/选择" }]
        : [],
    reason:
      defaults.length === 1
        ? "复用Plane唯一默认Intake。"
        : "CE 1.4.1启用Intake后的默认对象关系必须先回读/浏览器验证，不能猜测创建。",
  });
}

function sampleOperation(
  inspection: PlaneProjectRolloutInspection,
  sample: ContentLabPlaneRolloutSample,
): ContentLabPlaneRolloutOperation {
  const externalId = `chat-work:content-lab:${sample.workKey}`;
  const byExternalId = inspection.workItems.filter(
    (workItem) => workItem.externalSource === "later-agent" && workItem.externalId === externalId,
  );
  const byName = inspection.workItems.filter((workItem) => workItem.name === sample.title);
  const conflict = byExternalId.length > 1 || (byExternalId.length === 0 && byName.length > 0);
  return operation({
    targetKind:
      sample.sampleKind === "workflow_improvement" ? "workflow_improvement" : "history_work",
    stableKey: `sample:${sample.sampleKind}`,
    displayName: sample.title,
    action: conflict ? "manual_review" : byExternalId.length === 1 ? "noop" : "create",
    changes:
      byExternalId.length === 0 && !conflict
        ? [
            { field: "externalId", before: null, after: externalId },
            { field: "state", before: null, after: sample.desiredState },
            { field: "module", before: null, after: sample.moduleName },
            { field: "sourceRef", before: null, after: sample.sourceRef },
          ]
        : [],
    reason: conflict
      ? "现有Work Item名称或external ID冲突，必须先人工核对。"
      : "用户批准后先创建Chat Work Candidate，再由日常Operation确保唯一Plane投影。",
  });
}

async function selectSamples(
  deps: ApplicationDeps,
  input: {
    readonly rootId: string;
    readonly observationSha256: string;
    readonly observation: NonNullable<
      Awaited<
        ReturnType<NonNullable<ApplicationDeps["projectRoots"]>["observe"]>
      >["data"]["contentLab"]
    >;
  },
): Promise<readonly ContentLabPlaneRolloutSample[]> {
  const eligible = (job: ContentLabJob) =>
    job.source !== undefined && job.publish !== undefined && job.qc !== undefined;
  const xhs = latest(
    input.observation.jobs.filter(
      (job) =>
        job.platform === "xiaohongshu" &&
        job.seriesKey === undefined &&
        job.readiness !== "blocked" &&
        eligible(job),
    ),
  );
  const series = latest(
    input.observation.jobs.filter(
      (job) => job.platform === "xiaohongshu" && job.seriesKey !== undefined && eligible(job),
    ),
  );
  const bilibili = latest(
    input.observation.jobs.filter((job) => job.platform === "bilibili" && eligible(job)),
  );
  const blocked = latest(input.observation.jobs.filter((job) => job.readiness === "blocked"));
  const caseRef =
    input.observation.catalog.cases.find(
      (item) =>
        item.relativePath === "cases/2026-07-05_xhs_burned_in_english_caption_replacement_case.md",
    ) ??
    [...input.observation.catalog.cases]
      .filter((item) => item.relativePath !== "cases/README.md")
      .sort((left, right) => right.relativePath.localeCompare(left.relativePath))[0];
  if (
    xhs === undefined ||
    series === undefined ||
    bilibili === undefined ||
    blocked === undefined
  ) {
    throw revisionConflict("Content Lab缺少P8规定的四类代表性历史");
  }
  if (caseRef === undefined) throw revisionConflict("Content Lab缺少Workflow改进案例");
  const jobSamples = await Promise.all([
    jobSample(deps, input, "xiaohongshu_independent", xhs),
    jobSample(deps, input, "series_content", series),
    jobSample(deps, input, "bilibili_content", bilibili),
    jobSample(deps, input, "blocked_content", blocked),
  ]);
  const practiceTitle =
    caseRef.relativePath === "cases/2026-07-05_xhs_burned_in_english_caption_replacement_case.md"
      ? "烧录英文字幕替换质量门"
      : await contextTitle(deps, input, {
          workKind: "workflow_improvement",
          targetPlatforms: [],
          resourceRefs: [caseRef.relativePath],
        });
  return [
    ...jobSamples,
    {
      sampleKind: "workflow_improvement",
      sourceRef: caseRef.relativePath,
      workKey: stableWorkKey("practice-history", caseRef.relativePath),
      title: `[流程改进] ${practiceTitle ?? humanizePath(caseRef.relativePath)}`,
      desiredState: "Proposed",
      moduleName: "工作流持续改进",
      labels: ["kind:practice"],
      authority: "candidate_only",
      authoritativeRefs: [caseRef.relativePath],
      selectionReason: "P3指定的字幕替换质量门案例；只导入为Proposed，不自动采用方法。",
    },
  ];
}

async function jobSample(
  deps: ApplicationDeps,
  input: Parameters<typeof selectSamples>[1],
  sampleKind: Exclude<ContentLabPlaneRolloutSample["sampleKind"], "workflow_improvement">,
  job: ContentLabJob,
): Promise<ContentLabPlaneRolloutSample> {
  const title = await contextTitle(deps, input, {
    workKind: "content_delivery",
    targetPlatforms: [job.platform],
    sourceRef: job.jobKey,
    ...(job.seriesKey === undefined ? {} : { seriesKey: job.seriesKey }),
    resourceRefs: [],
  });
  const desiredState: ContentLabPlaneRolloutSample["desiredState"] =
    job.readiness === "blocked"
      ? "Blocked"
      : job.readiness === "review_ready"
        ? "Ready"
        : job.readiness === "needs_review"
          ? "Needs Review"
          : "Intake";
  return {
    sampleKind,
    sourceRef: job.jobKey,
    workKey: stableWorkKey("content-history", job.jobKey),
    title: `[${job.platform === "xiaohongshu" ? "小红书" : "B站"}] ${title ?? humanizePath(job.jobKey)}`,
    desiredState,
    moduleName: job.platform === "xiaohongshu" ? "小红书内容交付" : "B站内容交付",
    labels: [
      "kind:content",
      `platform:${job.platform}`,
      ...(job.seriesKey === undefined ? [] : [`series:${job.seriesKey}`]),
    ],
    authority: "candidate_only",
    authoritativeRefs: [
      job.jobKey,
      ...(job.source === undefined ? [] : [job.source.relativePath]),
      ...(job.publish === undefined ? [] : [job.publish.relativePath]),
      ...(job.qc === undefined ? [] : [job.qc.relativePath]),
    ],
    selectionReason:
      job.readiness === "blocked"
        ? "唯一真实Blocked样本，用于验证恢复条件和交接显示。"
        : "满足P8平台/系列代表性要求且具备source、publish与QC；文件存在不代表已发布。",
  };
}

function candidateDescription(sample: ContentLabPlaneRolloutSample): string {
  return [
    "Authority: candidate_only",
    `Source: ${sample.sourceRef}`,
    `Reason: ${sample.selectionReason}`,
    "Evidence:",
    ...sample.authoritativeRefs.map((reference) => `- ${reference}`),
    "",
    "该对象只表示候选工作与人类协作状态；文件存在不代表已发布或已采用。",
  ].join("\n");
}

function isRecognizedProjectPatchRecovery(
  dryRun: ContentLabPlaneRolloutDryRun,
  recovery: {
    readonly approvedResourceObservationSha256: string;
    readonly approvedBeforeInspectionSha256: string;
  },
): boolean {
  if (
    dryRun.project.resourceObservationSha256 !== recovery.approvedResourceObservationSha256 ||
    dryRun.plane.inspectionSha256 === recovery.approvedBeforeInspectionSha256 ||
    dryRun.currentCounts.states !== 7 ||
    dryRun.currentCounts.modules !== 5 ||
    dryRun.currentCounts.labels !== 0 ||
    dryRun.currentCounts.workItems !== 8
  ) {
    return false;
  }
  const project = dryRun.operations.find(
    (operation) => operation.targetKind === "project_configuration",
  );
  const projectChanges = Object.fromEntries(
    project?.changes.map((change) => [change.field, [change.before, change.after]]) ?? [],
  );
  if (
    project?.action !== "update" ||
    JSON.stringify(projectChanges) !==
      JSON.stringify({
        network: [2, 0],
        issueViewsView: [false, true],
        intakeView: [false, true],
      })
  ) {
    return false;
  }
  const count = (targetKind: ContentLabPlaneRolloutOperation["targetKind"], action: string) =>
    dryRun.operations.filter(
      (operation) => operation.targetKind === targetKind && operation.action === action,
    ).length;
  return (
    count("state", "create") === 10 &&
    count("state", "noop") === 2 &&
    count("module", "create") === 3 &&
    count("label", "create") === 10 &&
    count("history_work", "create") === 4 &&
    count("workflow_improvement", "create") === 1 &&
    count("view", "manual_review") === 9 &&
    count("page", "manual_review") === 8 &&
    count("intake", "manual_review") === 1
  );
}

function isRecognizedCandidatePlacementRecovery(
  dryRun: ContentLabPlaneRolloutDryRun,
  recovery: {
    readonly approvedResourceObservationSha256: string;
    readonly approvedBeforeInspectionSha256: string;
  },
): boolean {
  if (
    dryRun.project.resourceObservationSha256 !== recovery.approvedResourceObservationSha256 ||
    dryRun.plane.inspectionSha256 === recovery.approvedBeforeInspectionSha256 ||
    dryRun.currentCounts.states !== 17 ||
    dryRun.currentCounts.modules !== 8 ||
    dryRun.currentCounts.labels !== 10 ||
    dryRun.currentCounts.workItems !== 9
  ) {
    return false;
  }
  const project = dryRun.operations.find(
    (operation) => operation.targetKind === "project_configuration",
  );
  const projectChanges = Object.fromEntries(
    project?.changes.map((change) => [change.field, [change.before, change.after]]) ?? [],
  );
  if (
    project?.action !== "update" ||
    JSON.stringify(projectChanges) !==
      JSON.stringify({
        network: [2, 0],
        issueViewsView: [false, true],
        intakeView: [false, true],
      })
  ) {
    return false;
  }
  const count = (targetKind: ContentLabPlaneRolloutOperation["targetKind"], action: string) =>
    dryRun.operations.filter(
      (operation) => operation.targetKind === targetKind && operation.action === action,
    ).length;
  const importedSample = dryRun.operations.find(
    (operation) => operation.stableKey === "sample:xiaohongshu_independent",
  );
  return (
    count("state", "noop") === 12 &&
    count("module", "noop") === 3 &&
    count("label", "noop") === 10 &&
    count("history_work", "create") === 3 &&
    count("history_work", "noop") === 1 &&
    count("workflow_improvement", "create") === 1 &&
    count("view", "manual_review") === 9 &&
    count("page", "manual_review") === 8 &&
    count("intake", "manual_review") === 1 &&
    importedSample?.action === "noop"
  );
}

function isRecognizedCompletedRollout(
  dryRun: ContentLabPlaneRolloutDryRun,
  recovery: {
    readonly approvedResourceObservationSha256: string;
    readonly approvedBeforeInspectionSha256: string;
  },
): boolean {
  if (
    dryRun.project.resourceObservationSha256 !== recovery.approvedResourceObservationSha256 ||
    dryRun.plane.inspectionSha256 === recovery.approvedBeforeInspectionSha256 ||
    dryRun.currentCounts.states !== 17 ||
    dryRun.currentCounts.modules !== 8 ||
    dryRun.currentCounts.labels !== 10 ||
    dryRun.currentCounts.workItems !== 13
  ) {
    return false;
  }
  const project = dryRun.operations.find(
    (operation) => operation.targetKind === "project_configuration",
  );
  const projectChanges = Object.fromEntries(
    project?.changes.map((change) => [change.field, [change.before, change.after]]) ?? [],
  );
  if (
    project?.action !== "update" ||
    JSON.stringify(projectChanges) !==
      JSON.stringify({
        network: [2, 0],
        issueViewsView: [false, true],
        intakeView: [false, true],
      })
  ) {
    return false;
  }
  const count = (targetKind: ContentLabPlaneRolloutOperation["targetKind"], action: string) =>
    dryRun.operations.filter(
      (operation) => operation.targetKind === targetKind && operation.action === action,
    ).length;
  return (
    count("state", "noop") === 12 &&
    count("module", "noop") === 3 &&
    count("label", "noop") === 10 &&
    count("history_work", "noop") === 4 &&
    count("workflow_improvement", "noop") === 1 &&
    count("view", "manual_review") === 9 &&
    count("page", "manual_review") === 8 &&
    count("intake", "manual_review") === 1
  );
}

async function contextTitle(
  deps: ApplicationDeps,
  input: Parameters<typeof selectSamples>[1],
  selection: ContentLabContextSelection,
): Promise<string | undefined> {
  const projectRoots = deps.projectRoots;
  const compile = projectRoots?.compileContentLabContext;
  if (compile === undefined || projectRoots === undefined) return undefined;
  const context = await compile.call(projectRoots, {
    rootId: input.rootId,
    observationSha256: input.observationSha256,
    observation: input.observation,
    selection,
  });
  const exactItems = context.items.filter((item) =>
    selection.workKind === "workflow_improvement"
      ? selection.resourceRefs.includes(item.relativePath)
      : selection.sourceRef !== undefined &&
        item.relativePath.startsWith(`${selection.sourceRef}/`),
  );
  const preferred = [...(exactItems.length > 0 ? exactItems : context.items)].sort(
    (left, right) => {
      const rank = (path: string) =>
        path.endsWith("publish.md") ? 0 : path.endsWith("source.md") ? 1 : 2;
      return (
        rank(left.relativePath) - rank(right.relativePath) ||
        left.relativePath.localeCompare(right.relativePath)
      );
    },
  );
  if (selection.workKind === "content_delivery") {
    const publish = preferred.find((item) => item.relativePath.endsWith("publish.md"));
    const mainTitle =
      publish === undefined ? undefined : markdownSectionValue(publish.content, "主标题");
    if (mainTitle !== undefined) return mainTitle.slice(0, 180);
  }
  for (const item of preferred) {
    const title = item.content
      .split(/\r?\n/u)
      .map((line) => /^#{1,3}\s+(.+)$/u.exec(line.trim())?.[1]?.trim())
      .find(
        (candidate) =>
          candidate !== undefined &&
          candidate.length > 2 &&
          !["小红书发布包", "B站发布包", "原视频信息卡", "Ziji Content Lab 指令"].includes(
            candidate,
          ),
      );
    if (title !== undefined) return title.slice(0, 180);
  }
  return undefined;
}

function markdownSectionValue(content: string, heading: string): string | undefined {
  const lines = content.split(/\r?\n/u);
  const index = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (index < 0) return undefined;
  for (const line of lines.slice(index + 1)) {
    const trimmed = line.trim();
    if (/^#{1,6}\s/u.test(trimmed)) return undefined;
    if (trimmed === "") continue;
    const value = trimmed
      .replace(/^[-*+]\s+/u, "")
      .replace(/^\d+[.)]\s+/u, "")
      .replaceAll(/^\*\*|\*\*$/gu, "")
      .trim();
    if (value.length > 2) return value;
  }
  return undefined;
}

function latest(jobs: readonly ContentLabJob[]): ContentLabJob | undefined {
  return [...jobs].sort(
    (left, right) => right.date.localeCompare(left.date) || right.jobKey.localeCompare(left.jobKey),
  )[0];
}

function stableWorkKey(prefix: string, sourceRef: string): string {
  const date = /\d{4}-\d{2}-\d{2}/u.exec(sourceRef)?.[0]?.replaceAll("-", "") ?? "undated";
  return `${prefix}-${date}-${hashCanonical("content-lab-rollout-sample.v1", sourceRef).slice(0, 12)}`;
}

function humanizePath(path: string): string {
  const filename = path.split("/").at(-1)?.replace(/\.md$/u, "") ?? path;
  return filename
    .replace(/^\d{4}-\d{2}-\d{2}_/u, "")
    .replaceAll("_", " ")
    .slice(0, 180);
}

function extraObjectWarnings(inspection: PlaneProjectRolloutInspection): string[] {
  const desiredStateNames = new Set<string>(DESIRED_STATES.map(([name]) => name));
  const desiredModules = new Set<string>(DESIRED_MODULES.map(([, name]) => name));
  const desiredViewNames = new Set<string>(DESIRED_VIEWS.map((item) => item.name));
  const desiredPageNames = new Set<string>(DESIRED_PAGES.map((item) => item.name));
  const warnings = [
    ...inspection.states
      .filter((item) => !desiredStateNames.has(item.name))
      .map((item) => `保留未知State，不删除：${item.name}`),
    ...inspection.modules
      .filter((item) => !desiredModules.has(item.name))
      .map((item) => `保留现有Module，不删除：${item.name}`),
    ...inspection.views
      .filter((item) => !item.archived && !desiredViewNames.has(item.name))
      .map((item) => `保留现有View，不删除：${item.name}`),
    ...inspection.pages
      .filter((item) => !item.archived && !desiredPageNames.has(item.name))
      .map((item) => `保留现有Page，不删除：${item.name}`),
  ];
  return warnings.slice(0, 50);
}

function operation(
  input: Omit<ContentLabPlaneRolloutOperation, "destructive" | "requiresExplicitApproval">,
): ContentLabPlaneRolloutOperation {
  return {
    ...input,
    destructive: false,
    requiresExplicitApproval: input.action !== "noop",
  };
}

function view(
  name: string,
  filters: Record<string, unknown>,
  layout: string,
  groupBy: string | null,
  orderBy = "-created_at",
) {
  const stableKey = `view:${slug(name)}`;
  const marker = `${MANAGED_DESCRIPTION_PREFIX}${stableKey}]`;
  return {
    stableKey,
    name,
    marker,
    filtersJson: canonicalJson(filters),
    displayFiltersJson: canonicalJson({ group_by: groupBy, layout, order_by: orderBy }),
  } as const;
}

function managedPage(key: string, name: string) {
  return {
    stableKey: `page:${key}`,
    name,
    managed: true,
    externalId: `${MAPPING_VERSION}:page:${key}`,
  } as const;
}

function humanPage(key: string, name: string) {
  return {
    stableKey: `page:${key}`,
    name,
    managed: false,
    externalId: `${MAPPING_VERSION}:human-page:${key}`,
  } as const;
}

function slug(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replaceAll(/[^A-Za-z0-9]+/gu, "-")
      .replaceAll(/^-|-$/gu, "")
      .toLowerCase() || hashCanonical("content-lab-rollout-slug.v1", value).slice(0, 12)
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function rolloutHashInput(core: object): unknown {
  const input = structuredClone(core) as Record<string, unknown>;
  delete input.generatedAt;
  const plane = input.plane;
  if (typeof plane !== "object" || plane === null || Array.isArray(plane)) {
    throw revisionConflict("P8 Dry Run Plane Hash输入非法");
  }
  delete (plane as Record<string, unknown>).capturedAt;
  return input;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}
