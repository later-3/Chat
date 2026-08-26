import { hashCanonical } from "./canonical-hash.js";

export type BuiltInProjectProfileKey =
  "software-delivery" | "content-production" | "learning" | "personal-journal";
export type ProjectProfileKey = string;
export type ProjectManagedObjectKind =
  | "project"
  | "profile"
  | "configuration"
  | "objective"
  | "need"
  | "requirement"
  | "scope"
  | "commitment"
  | "work"
  | "action"
  | "dependency"
  | "activity"
  | "claim"
  | "handoff"
  | "risk"
  | "issue"
  | "block"
  | "review"
  | "acceptance"
  | "resource"
  | "artifact"
  | "evidence"
  | "decision"
  | "change"
  | "knowledge"
  | "case"
  | "lesson"
  | "practice"
  | "metric"
  | "event"
  | "capture"
  | "competency"
  | "assessment"
  | "publication"
  | "daily_entry"
  | "report";
export type ProjectViewCapability =
  | "project_home"
  | "work"
  | "timeline"
  | "calendar"
  | "object_detail"
  | "document"
  | "code"
  | "media"
  | "review"
  | "report"
  | "relation"
  | "attention";

export interface ProjectObjectPolicy {
  readonly kind: ProjectManagedObjectKind;
  readonly required: boolean;
  readonly description: string;
  readonly lifecycleKey?: string | undefined;
  readonly evidenceGateKey?: string | undefined;
}

export interface ProjectViewRequirement {
  readonly capability: ProjectViewCapability;
  readonly required: boolean;
  readonly objectKinds: readonly ProjectManagedObjectKind[];
  readonly fields: readonly string[];
  readonly actions: readonly string[];
  readonly freshness: "live" | "snapshot" | "eventual";
  readonly fallbackIntent: "embedded" | "open_resource" | "unsupported";
}

export interface ProjectContextPolicy {
  readonly purpose:
    "project_opening" | "work_execution" | "delta" | "review" | "handoff" | "maintenance";
  readonly objectKinds: readonly ProjectManagedObjectKind[];
  readonly resourceRoles: readonly string[];
  readonly recentEventLimit: number;
  readonly maxObjects: number;
  readonly maxCharacters: number;
  readonly includeHistory: boolean;
}

export interface ProjectProfileDefinition {
  readonly profileKey: ProjectProfileKey;
  readonly title: string;
  readonly purpose: string;
  readonly objectCatalog: readonly ProjectObjectPolicy[];
  readonly lifecycle: readonly {
    readonly key: string;
    readonly label: string;
    readonly activities: readonly string[];
    readonly terminal: boolean;
  }[];
  readonly defaultTimePolicy: {
    readonly mode: "delivery" | "continuous" | "deadline" | "cadence";
    readonly historyRequired: true;
    readonly distinguishObservedAndRecorded: true;
    readonly plannedActualComparison: boolean;
    readonly recurrenceEnabled: boolean;
  };
  readonly authorityPolicy: {
    readonly policyVersion: string;
    readonly agentMayPropose: true;
    readonly agentMayCommit: readonly string[];
    readonly humanDecisionActions: readonly string[];
    readonly prohibitedAutomationActions: readonly string[];
  };
  readonly evidencePolicy: {
    readonly policyVersion: string;
    readonly terminalEvidenceRequired: boolean;
    readonly evidenceKinds: readonly string[];
    readonly agentSelfReportSufficient: false;
    readonly acceptanceRequiresHuman: boolean;
  };
  readonly contextPolicies: readonly ProjectContextPolicy[];
  readonly viewRequirements: readonly ProjectViewRequirement[];
  readonly maintenanceCadences: readonly ProjectCadenceShape[];
  readonly metrics: readonly {
    readonly key: string;
    readonly label: string;
    readonly unit: string;
    readonly interpretation: string;
    readonly successMetric: boolean;
  }[];
}

interface ProjectCadenceShape {
  readonly key: string;
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
  readonly action: "observe" | "reconcile" | "attention" | "report" | "review";
  readonly required: boolean;
}

export interface ProjectProfileRevision extends ProjectProfileDefinition {
  readonly schemaVersion: "project-profile-revision.v1";
  readonly projectProfileRevisionId: string;
  readonly version: number;
  readonly status: "active" | "superseded";
  readonly sha256: string;
  readonly adoptedByDecisionId?: string | undefined;
  readonly revision: 1;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const CORE_OBJECTS: readonly ProjectManagedObjectKind[] = [
  "project",
  "profile",
  "configuration",
  "objective",
  "need",
  "requirement",
  "scope",
  "commitment",
  "work",
  "action",
  "dependency",
  "activity",
  "claim",
  "handoff",
  "risk",
  "issue",
  "block",
  "review",
  "acceptance",
  "resource",
  "artifact",
  "evidence",
  "decision",
  "change",
  "knowledge",
  "lesson",
  "practice",
  "metric",
  "event",
] as const;

const REQUIRED_OBJECTS = new Set<ProjectManagedObjectKind>([
  "project",
  "profile",
  "configuration",
  "objective",
  "need",
  "resource",
  "artifact",
  "evidence",
  "decision",
  "event",
]);

const VIEW_DEFAULTS: Record<
  ProjectViewCapability,
  Pick<
    ProjectViewRequirement,
    "objectKinds" | "fields" | "actions" | "freshness" | "fallbackIntent"
  >
> = {
  project_home: {
    objectKinds: ["project", "objective", "work", "risk", "decision", "event"],
    fields: ["goal", "health", "commitments", "attention", "recent_changes", "next_steps"],
    actions: ["open_object", "request_review"],
    freshness: "snapshot",
    fallbackIntent: "embedded",
  },
  work: {
    objectKinds: ["work", "action", "dependency", "claim", "block", "handoff", "review"],
    fields: ["status", "owner", "priority", "due_at", "dependencies", "evidence"],
    actions: ["claim", "progress", "block", "review", "handoff"],
    freshness: "eventual",
    fallbackIntent: "open_resource",
  },
  timeline: {
    objectKinds: ["event", "work", "artifact", "decision", "metric"],
    fields: ["occurred_at", "observed_at", "recorded_at", "planned_at", "actual_at"],
    actions: ["open_object"],
    freshness: "snapshot",
    fallbackIntent: "embedded",
  },
  calendar: {
    objectKinds: ["work", "action", "event", "review"],
    fields: ["planned_start", "planned_end", "due_at", "review_at", "recurrence"],
    actions: ["open_object"],
    freshness: "eventual",
    fallbackIntent: "open_resource",
  },
  object_detail: {
    objectKinds: ["project", "need", "requirement", "work", "artifact", "decision", "evidence"],
    fields: ["identity", "revision", "relations", "history", "evidence", "provenance"],
    actions: ["open_revision", "review"],
    freshness: "snapshot",
    fallbackIntent: "embedded",
  },
  document: {
    objectKinds: ["requirement", "artifact", "knowledge", "case", "lesson", "report"],
    fields: ["title", "body", "revision", "source", "relations"],
    actions: ["open_resource", "compare_revision"],
    freshness: "snapshot",
    fallbackIntent: "open_resource",
  },
  code: {
    objectKinds: ["artifact", "evidence", "review"],
    fields: ["repository", "path", "revision", "diff", "commit", "tests"],
    actions: ["open_resource", "compare_revision"],
    freshness: "live",
    fallbackIntent: "open_resource",
  },
  media: {
    objectKinds: ["artifact", "publication", "evidence"],
    fields: ["preview", "media_type", "revision", "source", "publication"],
    actions: ["open_resource", "review"],
    freshness: "snapshot",
    fallbackIntent: "open_resource",
  },
  review: {
    objectKinds: ["review", "acceptance", "decision", "artifact", "evidence"],
    fields: ["candidate", "previous_revision", "changes", "requirements", "evidence", "risk"],
    actions: ["approve", "reject", "request_revision"],
    freshness: "live",
    fallbackIntent: "embedded",
  },
  report: {
    objectKinds: ["report", "metric", "event", "work", "evidence"],
    fields: ["window", "source", "trend", "exceptions", "interpretation"],
    actions: ["open_object", "export"],
    freshness: "snapshot",
    fallbackIntent: "embedded",
  },
  relation: {
    objectKinds: ["objective", "need", "requirement", "work", "artifact", "evidence", "knowledge"],
    fields: ["source", "target", "relation", "revision"],
    actions: ["open_object"],
    freshness: "snapshot",
    fallbackIntent: "embedded",
  },
  attention: {
    objectKinds: ["work", "block", "review", "decision", "event"],
    fields: ["reason", "severity", "due_at", "project", "next_action"],
    actions: ["open_object", "resolve"],
    freshness: "live",
    fallbackIntent: "embedded",
  },
};

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function objectCatalog(extra: readonly ProjectManagedObjectKind[]): ProjectObjectPolicy[] {
  return unique([...CORE_OBJECTS, ...extra]).map((kind) => ({
    kind,
    required: REQUIRED_OBJECTS.has(kind),
    description: `${kind}在当前Profile中的受管语义与关系。`,
    ...(kind === "work" || kind === "artifact" || kind === "knowledge"
      ? { lifecycleKey: `${kind}.lifecycle.v1` }
      : {}),
    ...(kind === "work" || kind === "acceptance" || kind === "publication"
      ? { evidenceGateKey: `${kind}.evidence.v1` }
      : {}),
  }));
}

function viewRequirements(
  requiredCapabilities: readonly ProjectViewCapability[],
): ProjectViewRequirement[] {
  return unique(requiredCapabilities).map((capability) => ({
    capability,
    required: true,
    ...VIEW_DEFAULTS[capability],
  }));
}

function contextPolicies(
  resourceRoles: readonly string[],
  executionObjects: readonly ProjectManagedObjectKind[],
): ProjectContextPolicy[] {
  return [
    {
      purpose: "project_opening",
      objectKinds: ["project", "objective", "commitment", "work", "risk", "decision", "event"],
      resourceRoles: ["governance", "project_map"],
      recentEventLimit: 40,
      maxObjects: 120,
      maxCharacters: 120_000,
      includeHistory: true,
    },
    {
      purpose: "work_execution",
      objectKinds: unique([
        "need",
        "requirement",
        "scope",
        "work",
        "action",
        "dependency",
        "artifact",
        "evidence",
        "decision",
        ...executionObjects,
      ]),
      resourceRoles: [...resourceRoles],
      recentEventLimit: 30,
      maxObjects: 160,
      maxCharacters: 180_000,
      includeHistory: false,
    },
    {
      purpose: "delta",
      objectKinds: ["event", "work", "artifact", "decision", "block", "review"],
      resourceRoles: [],
      recentEventLimit: 200,
      maxObjects: 300,
      maxCharacters: 100_000,
      includeHistory: true,
    },
    {
      purpose: "review",
      objectKinds: ["requirement", "work", "artifact", "review", "acceptance", "evidence", "risk"],
      resourceRoles: [...resourceRoles],
      recentEventLimit: 80,
      maxObjects: 200,
      maxCharacters: 200_000,
      includeHistory: true,
    },
    {
      purpose: "handoff",
      objectKinds: [
        "work",
        "action",
        "claim",
        "block",
        "handoff",
        "artifact",
        "evidence",
        "decision",
        "event",
      ],
      resourceRoles: ["governance", ...resourceRoles],
      recentEventLimit: 100,
      maxObjects: 180,
      maxCharacters: 140_000,
      includeHistory: true,
    },
    {
      purpose: "maintenance",
      objectKinds: ["project", "work", "block", "review", "decision", "metric", "event", "report"],
      resourceRoles: ["project_map"],
      recentEventLimit: 300,
      maxObjects: 500,
      maxCharacters: 160_000,
      includeHistory: true,
    },
  ];
}

const COMMON_LIFECYCLE = [
  {
    key: "shape",
    label: "理解与塑形",
    activities: ["capture", "understand", "shape", "decide"] as const,
    terminal: false,
  },
  {
    key: "deliver",
    label: "计划、执行与验收",
    activities: ["plan", "execute", "observe", "review", "accept", "deliver"] as const,
    terminal: false,
  },
  {
    key: "evolve",
    label: "学习与演进",
    activities: ["learn", "evolve", "pause", "close"] as const,
    terminal: true,
  },
];

const COMMON_MAINTENANCE = [
  { key: "agent-start", trigger: "agent_started", action: "observe", required: true },
  { key: "agent-finish", trigger: "agent_finished", action: "attention", required: true },
  { key: "resource-change", trigger: "resource_changed", action: "observe", required: true },
  { key: "provider-change", trigger: "provider_changed", action: "reconcile", required: true },
] as const;

function validateProjectProfileDefinition(
  input: ProjectProfileDefinition,
): ProjectProfileDefinition {
  if (
    !/^[a-z0-9][a-z0-9._-]{0,119}$/u.test(input.profileKey) ||
    input.title.trim() === "" ||
    input.purpose.trim() === ""
  ) {
    throw new Error("Project Profile身份、标题或目的非法");
  }
  if (input.objectCatalog.length < 8 || input.contextPolicies.length !== 6) {
    throw new Error("Project Profile对象目录或六类Context不完整");
  }
  if (input.lifecycle.length < 2 || input.viewRequirements.length < 3) {
    throw new Error("Project Profile生命周期或用户View不完整");
  }
  if (input.maintenanceCadences.length < 2) {
    throw new Error("Project Profile缺少持续维护政策");
  }
  return structuredClone(input);
}

function definitionFor(profileKey: BuiltInProjectProfileKey): ProjectProfileDefinition {
  const common = {
    profileKey,
    lifecycle: COMMON_LIFECYCLE,
    authorityPolicy: {
      policyVersion: `${profileKey}.authority.v1`,
      agentMayPropose: true as const,
      agentMayCommit: ["observation", "draft", "progress", "handoff"],
      humanDecisionActions: ["commitment", "acceptance", "profile_adoption"],
      prohibitedAutomationActions: ["publish", "delete", "change_authority"],
    },
    evidencePolicy: {
      policyVersion: `${profileKey}.evidence.v1`,
      terminalEvidenceRequired: true,
      evidenceKinds: ["artifact_revision", "user_decision"],
      agentSelfReportSufficient: false as const,
      acceptanceRequiresHuman: true,
    },
    maintenanceCadences: COMMON_MAINTENANCE,
  } as const;

  if (profileKey === "software-delivery") {
    return validateProjectProfileDefinition({
      ...common,
      title: "软件交付",
      purpose: "管理需求、方案、代码、测试、发布、维护与多Agent开发交接。",
      objectCatalog: objectCatalog([]),
      defaultTimePolicy: {
        mode: "delivery",
        historyRequired: true,
        distinguishObservedAndRecorded: true,
        plannedActualComparison: true,
        recurrenceEnabled: false,
      },
      contextPolicies: contextPolicies(
        ["governance", "requirements", "architecture", "source", "tests"],
        ["review", "acceptance"],
      ),
      viewRequirements: viewRequirements([
        "project_home",
        "work",
        "document",
        "code",
        "timeline",
        "review",
        "report",
        "attention",
      ]),
      metrics: [
        {
          key: "accepted-outcomes",
          label: "已验收结果",
          unit: "outcome",
          interpretation: "只有满足Requirement、质量门和用户验收的结果才计入。",
          successMetric: true,
        },
      ],
    });
  }

  if (profileKey === "content-production") {
    return validateProjectProfileDefinition({
      ...common,
      title: "内容生产",
      purpose: "管理来源、内容多Revision、媒体、审核、发布、案例与工作方法演进。",
      objectCatalog: objectCatalog(["case", "publication"]),
      defaultTimePolicy: {
        mode: "continuous",
        historyRequired: true,
        distinguishObservedAndRecorded: true,
        plannedActualComparison: true,
        recurrenceEnabled: true,
      },
      authorityPolicy: {
        ...common.authorityPolicy,
        humanDecisionActions: ["commitment", "publication", "practice_adoption", "acceptance"],
      },
      evidencePolicy: {
        ...common.evidencePolicy,
        evidenceKinds: [
          "source_revision",
          "content_revision",
          "quality_check",
          "publication_receipt",
        ],
      },
      contextPolicies: contextPolicies(
        ["governance", "source", "content", "media", "case", "practice"],
        ["publication", "case", "practice"],
      ),
      viewRequirements: viewRequirements([
        "project_home",
        "work",
        "document",
        "media",
        "timeline",
        "review",
        "report",
        "attention",
      ]),
      metrics: [
        {
          key: "accepted-publications",
          label: "已确认发布",
          unit: "publication",
          interpretation: "必须具有用户采用和外部发布回执，不把草稿数量算作发布。",
          successMetric: true,
        },
      ],
    });
  }

  if (profileKey === "learning") {
    return validateProjectProfileDefinition({
      ...common,
      title: "学习",
      purpose: "管理知识、能力差距、资料、练习、测评、掌握证据与方法演进。",
      objectCatalog: objectCatalog(["competency", "assessment"]),
      defaultTimePolicy: {
        mode: "continuous",
        historyRequired: true,
        distinguishObservedAndRecorded: true,
        plannedActualComparison: true,
        recurrenceEnabled: false,
      },
      authorityPolicy: {
        ...common.authorityPolicy,
        humanDecisionActions: ["commitment", "mastery", "goal_acceptance", "profile_adoption"],
      },
      evidencePolicy: {
        ...common.evidencePolicy,
        evidenceKinds: [
          "assessment",
          "independent_explanation",
          "exercise",
          "portfolio",
          "feedback",
        ],
      },
      contextPolicies: contextPolicies(
        ["goal", "competency_map", "learning_material", "notes", "exercises", "assessments"],
        ["competency", "assessment"],
      ),
      viewRequirements: viewRequirements([
        "project_home",
        "work",
        "document",
        "calendar",
        "timeline",
        "report",
        "relation",
        "attention",
      ]),
      metrics: [
        {
          key: "validated-competencies",
          label: "经验证能力",
          unit: "competency",
          interpretation: "只计入具有独立回忆、应用或测评Evidence的能力，不按课程完成量推断掌握。",
          successMetric: true,
        },
      ],
    });
  }

  return validateProjectProfileDefinition({
    ...common,
    title: "个人记录与复盘",
    purpose: "低摩擦捕获个人事实，管理跨项目引用、行动候选、隐私和周期复盘。",
    objectCatalog: objectCatalog(["capture", "daily_entry", "report"]),
    defaultTimePolicy: {
      mode: "continuous",
      historyRequired: true,
      distinguishObservedAndRecorded: true,
      plannedActualComparison: true,
      recurrenceEnabled: false,
    },
    authorityPolicy: {
      ...common.authorityPolicy,
      humanDecisionActions: ["commitment", "publish", "delete", "privacy_change"],
      prohibitedAutomationActions: ["publish", "delete", "change_privacy", "convert_all_to_work"],
    },
    evidencePolicy: {
      ...common.evidencePolicy,
      evidenceKinds: ["source_entry", "user_revision", "linked_project_event"],
    },
    contextPolicies: contextPolicies(
      ["governance", "daily_entries", "weekly_reports", "linked_projects"],
      ["capture", "daily_entry", "report"],
    ),
    viewRequirements: viewRequirements([
      "project_home",
      "document",
      "calendar",
      "timeline",
      "report",
      "relation",
      "attention",
    ]),
    metrics: [
      {
        key: "review-continuity",
        label: "复盘连续性",
        unit: "review_window",
        interpretation: "只描述数据窗口是否完整，不把记录数量解释为生产力或成长。",
        successMetric: false,
      },
    ],
  });
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label}不能重复`);
}

export function computeProjectProfileRevisionSha256(input: {
  readonly projectProfileRevisionId: string;
  readonly version: number;
  readonly definition: ProjectProfileDefinition;
  readonly status: "active" | "superseded";
  readonly adoptedByDecisionId?: string | undefined;
}): string {
  return hashCanonical("project-profile-revision.v1", input);
}

export function computeProjectConfigurationRevisionSha256(input: {
  readonly projectConfigurationRevisionId: string;
  readonly projectId: string;
  readonly version: number;
  readonly profileRevisionId: string;
  readonly profileRevisionSha256: string;
  readonly status: "candidate" | "adopted" | "superseded";
  readonly objective: string;
  readonly scopeIn: readonly string[];
  readonly scopeOut: readonly string[];
  readonly successCriteria: readonly string[];
  readonly timezone: string;
  readonly schedulePolicy: Readonly<Record<string, unknown>>;
  readonly participantIds: readonly string[];
  readonly resourceBindings: readonly unknown[];
  readonly presentationBindings: readonly unknown[];
  readonly terminology: Readonly<Record<string, string>>;
  readonly requiredReads: readonly string[];
  readonly effectiveFrom?: string | undefined;
  readonly effectiveTo?: string | undefined;
  readonly supersedesConfigurationRevisionId?: string | undefined;
  readonly adoptedByDecisionId?: string | undefined;
}): string {
  return hashCanonical("project-configuration-revision.v1", input);
}

/**
 * 任意Profile定义都通过同一个纯编译器；合成第五Profile也无需修改Router、Store或此函数分支。
 * 内置四种Profile只是受测输入，不是核心类型判断。
 */
export function compileProjectProfileRevision(input: {
  readonly projectProfileRevisionId: string;
  readonly version: number;
  readonly definition: ProjectProfileDefinition;
  readonly status?: "active" | "superseded" | undefined;
  readonly adoptedByDecisionId?: string | undefined;
  readonly now: string;
}): ProjectProfileRevision {
  const definition = validateProjectProfileDefinition(input.definition);
  assertUnique(
    definition.objectCatalog.map((item) => item.kind),
    "Profile Object Catalog",
  );
  assertUnique(
    definition.contextPolicies.map((item) => item.purpose),
    "Profile Context Purpose",
  );
  assertUnique(
    definition.viewRequirements.map((item) => item.capability),
    "Profile View Requirement",
  );
  assertUnique(
    definition.maintenanceCadences.map((item) => item.key),
    "Profile Maintenance Cadence",
  );
  for (const kind of REQUIRED_OBJECTS) {
    const policy = definition.objectCatalog.find((item) => item.kind === kind);
    if (policy?.required !== true) throw new Error(`Profile缺少必需对象:${kind}`);
  }
  const hashInput = {
    projectProfileRevisionId: input.projectProfileRevisionId,
    version: input.version,
    definition,
    status: input.status ?? "active",
    ...(input.adoptedByDecisionId === undefined
      ? {}
      : { adoptedByDecisionId: input.adoptedByDecisionId }),
  };
  if (!/^pfr_[A-Za-z0-9]+$/u.test(input.projectProfileRevisionId)) {
    throw new Error("Project Profile Revision ID非法");
  }
  if (
    !Number.isInteger(input.version) ||
    input.version < 1 ||
    Number.isNaN(Date.parse(input.now))
  ) {
    throw new Error("Project Profile Revision版本或时间非法");
  }
  return {
    schemaVersion: "project-profile-revision.v1",
    projectProfileRevisionId: input.projectProfileRevisionId,
    ...definition,
    version: input.version,
    status: input.status ?? "active",
    sha256: computeProjectProfileRevisionSha256(hashInput),
    ...(input.adoptedByDecisionId === undefined
      ? {}
      : { adoptedByDecisionId: input.adoptedByDecisionId }),
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function getBuiltInProjectProfileDefinition(
  profileKey: BuiltInProjectProfileKey,
): ProjectProfileDefinition {
  return structuredClone(definitionFor(profileKey));
}

export function compileBuiltInProjectProfileRevision(input: {
  readonly profileKey: BuiltInProjectProfileKey;
  readonly now: string;
}): ProjectProfileRevision {
  const ids: Record<BuiltInProjectProfileKey, string> = {
    "software-delivery": "pfr_softwaredelivery1",
    "content-production": "pfr_contentproduction1",
    learning: "pfr_learning1",
    "personal-journal": "pfr_personaljournal1",
  };
  return compileProjectProfileRevision({
    projectProfileRevisionId: ids[input.profileKey],
    version: 1,
    definition: definitionFor(input.profileKey),
    now: input.now,
  });
}
