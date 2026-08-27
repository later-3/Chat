import { z } from "zod";
import { sha256Schema } from "./hash.js";
import {
  principalIdSchema,
  projectArtifactRefIdSchema,
  projectConfigurationRevisionIdSchema,
  projectDecisionIdSchema,
  projectEventIdSchema,
  projectEvidenceIdSchema,
  projectIdSchema,
  projectMetricObservationIdSchema,
  projectNeedIdSchema,
  projectParticipantIdSchema,
  projectProfileRevisionIdSchema,
  projectRequirementIdSchema,
  projectResourceIdSchema,
} from "./ids.js";

const isoDateTimeSchema = z.iso.datetime();
const shortText = z.string().trim().min(1).max(500);
const longText = z.string().trim().min(1).max(8_000);
const stableKeySchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,119}$/u);
const entityBase = {
  revision: z.number().int().positive(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
};

/** Profile key不携带版本；精确版本由Profile Revision身份、version和sha256共同冻结。 */
export const projectProfileKeySchema = stableKeySchema;

/**
 * 这是四类Project共同的概念目录，不表示每个概念都必须成为独立Store集合。
 * Profile通过Object Catalog选择当前类型实际使用的对象；Domain/Application仍拥有明确用例。
 */
export const projectManagedObjectKindSchema = z.enum([
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
  "case",
  "lesson",
  "practice",
  "metric",
  "event",
  "capture",
  "competency",
  "assessment",
  "publication",
  "daily_entry",
  "report",
]);

export const projectObjectPolicySchema = z
  .object({
    kind: projectManagedObjectKindSchema,
    required: z.boolean(),
    description: shortText,
    lifecycleKey: stableKeySchema.optional(),
    evidenceGateKey: stableKeySchema.optional(),
  })
  .strict();

export const projectViewCapabilitySchema = z.enum([
  "project_home",
  "work",
  "timeline",
  "calendar",
  "object_detail",
  "document",
  "code",
  "media",
  "review",
  "report",
  "relation",
  "attention",
]);

/** View Requirement只声明用户必须看见什么，不写死具体前端或Viewer。 */
export const projectViewRequirementSchema = z
  .object({
    capability: projectViewCapabilitySchema,
    required: z.boolean(),
    objectKinds: z.array(projectManagedObjectKindSchema).min(1).max(20),
    fields: z.array(stableKeySchema).min(1).max(40),
    actions: z.array(stableKeySchema).max(20),
    freshness: z.enum(["live", "snapshot", "eventual"]),
    fallbackIntent: z.enum(["embedded", "open_resource", "unsupported"]),
  })
  .strict();

export const projectContextPurposeSchema = z.enum([
  "project_opening",
  "work_execution",
  "delta",
  "review",
  "handoff",
  "maintenance",
]);

export const projectContextPolicySchema = z
  .object({
    purpose: projectContextPurposeSchema,
    objectKinds: z.array(projectManagedObjectKindSchema).min(1).max(24),
    resourceRoles: z.array(stableKeySchema).max(24),
    recentEventLimit: z.number().int().nonnegative().max(500),
    maxObjects: z.number().int().positive().max(1_000),
    maxCharacters: z.number().int().positive().max(500_000),
    includeHistory: z.boolean(),
  })
  .strict();

export const projectCadenceSchema = z
  .object({
    key: stableKeySchema,
    trigger: z.enum([
      "agent_started",
      "agent_finished",
      "resource_changed",
      "provider_changed",
      "deadline",
      "daily",
      "weekly",
      "monthly",
      "manual",
    ]),
    action: z.enum(["observe", "reconcile", "attention", "report", "review"]),
    required: z.boolean(),
  })
  .strict();

/** Profile只提供类别级默认时间能力；具体期限和节奏由Project Configuration选择。 */
export const projectTimePolicySchema = z
  .object({
    mode: z.enum(["delivery", "continuous", "deadline", "cadence"]),
    historyRequired: z.literal(true),
    distinguishObservedAndRecorded: z.literal(true),
    plannedActualComparison: z.boolean(),
    recurrenceEnabled: z.boolean(),
  })
  .strict();

export const projectConfigurationSchedulePolicySchema = z
  .object({
    mode: z.enum(["delivery", "continuous", "deadline", "cadence"]),
    targetAt: isoDateTimeSchema.optional(),
    plannedActualComparison: z.boolean(),
    recurrenceEnabled: z.boolean(),
    cadences: z.array(projectCadenceSchema).max(20),
  })
  .strict()
  .superRefine((policy, context) => {
    if ((policy.mode === "deadline") !== (policy.targetAt !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["targetAt"],
        message: "只有deadline模式必须且可以设置Project目标时间",
      });
    }
    const recurring = policy.cadences.some((cadence) =>
      ["daily", "weekly", "monthly"].includes(cadence.trigger),
    );
    if (recurring && !policy.recurrenceEnabled) {
      context.addIssue({
        code: "custom",
        path: ["recurrenceEnabled"],
        message: "包含日/周/月Cadence时必须启用recurrence",
      });
    }
  });

export const projectAuthorityPolicySchema = z
  .object({
    policyVersion: stableKeySchema,
    agentMayPropose: z.literal(true),
    agentMayCommit: z.array(stableKeySchema).max(30),
    humanDecisionActions: z.array(stableKeySchema).min(1).max(30),
    prohibitedAutomationActions: z.array(stableKeySchema).min(1).max(30),
  })
  .strict();

export const projectEvidencePolicySchema = z
  .object({
    policyVersion: stableKeySchema,
    terminalEvidenceRequired: z.boolean(),
    evidenceKinds: z.array(stableKeySchema).min(1).max(30),
    agentSelfReportSufficient: z.literal(false),
    acceptanceRequiresHuman: z.boolean(),
  })
  .strict();

export const projectMetricPolicySchema = z
  .object({
    key: stableKeySchema,
    label: z.string().trim().min(1).max(160),
    unit: z.string().trim().min(1).max(80),
    interpretation: shortText,
    successMetric: z.boolean(),
  })
  .strict();

export const projectLifecyclePhaseSchema = z
  .object({
    key: stableKeySchema,
    label: z.string().trim().min(1).max(120),
    activities: z
      .array(
        z.enum([
          "capture",
          "understand",
          "shape",
          "decide",
          "plan",
          "execute",
          "observe",
          "review",
          "accept",
          "deliver",
          "learn",
          "evolve",
          "pause",
          "close",
        ]),
      )
      .min(1)
      .max(12),
    terminal: z.boolean(),
  })
  .strict();

export const projectProfileDefinitionSchema = z
  .object({
    profileKey: projectProfileKeySchema,
    title: z.string().trim().min(1).max(160),
    purpose: longText,
    objectCatalog: z.array(projectObjectPolicySchema).min(8).max(40),
    lifecycle: z.array(projectLifecyclePhaseSchema).min(2).max(20),
    defaultTimePolicy: projectTimePolicySchema,
    authorityPolicy: projectAuthorityPolicySchema,
    evidencePolicy: projectEvidencePolicySchema,
    contextPolicies: z.array(projectContextPolicySchema).length(6),
    viewRequirements: z.array(projectViewRequirementSchema).min(3).max(20),
    maintenanceCadences: z.array(projectCadenceSchema).min(2).max(20),
    metrics: z.array(projectMetricPolicySchema).max(20),
  })
  .strict();

export const projectProfileRevisionSchema = z
  .object({
    schemaVersion: z.literal("project-profile-revision.v1"),
    projectProfileRevisionId: projectProfileRevisionIdSchema,
    ...projectProfileDefinitionSchema.shape,
    version: z.number().int().positive(),
    status: z.enum(["active", "superseded"]),
    sha256: sha256Schema,
    adoptedByDecisionId: projectDecisionIdSchema.optional(),
    ...entityBase,
  })
  .strict();

export const projectResourceCapabilitySchema = z.enum([
  "discover",
  "read",
  "write",
  "version",
  "diff",
  "search",
  "watch",
  "render",
  "export",
]);

export const projectResourceBindingConfigSchema = z
  .object({
    projectResourceId: projectResourceIdSchema,
    role: stableKeySchema,
    required: z.boolean(),
    capabilities: z.array(projectResourceCapabilitySchema).min(1).max(9),
  })
  .strict();

/** Presentation Binding选择实现表面；providerKind是可替换标识，不进入Profile。 */
export const projectPresentationBindingConfigSchema = z
  .object({
    capability: projectViewCapabilitySchema,
    providerKind: stableKeySchema,
    bindingRef: z.string().trim().min(1).max(500),
    mode: z.enum(["primary", "fallback"]),
  })
  .strict();

export const projectConfigurationRevisionSchema = z
  .object({
    schemaVersion: z.literal("project-configuration-revision.v1"),
    projectConfigurationRevisionId: projectConfigurationRevisionIdSchema,
    projectId: projectIdSchema,
    version: z.number().int().positive(),
    profileRevisionId: projectProfileRevisionIdSchema,
    profileRevisionSha256: sha256Schema,
    status: z.enum(["candidate", "adopted", "superseded"]),
    objective: longText,
    scopeIn: z.array(shortText).min(1).max(40),
    scopeOut: z.array(shortText).max(40),
    successCriteria: z.array(shortText).min(1).max(40),
    timezone: z.string().trim().min(1).max(80),
    schedulePolicy: projectConfigurationSchedulePolicySchema,
    participantIds: z.array(projectParticipantIdSchema).min(1).max(100),
    resourceBindings: z.array(projectResourceBindingConfigSchema).max(100),
    presentationBindings: z.array(projectPresentationBindingConfigSchema).max(30),
    terminology: z.record(stableKeySchema, z.string().trim().min(1).max(160)),
    requiredReads: z.array(z.string().trim().min(1).max(500)).max(50),
    effectiveFrom: isoDateTimeSchema.optional(),
    effectiveTo: isoDateTimeSchema.optional(),
    supersedesConfigurationRevisionId: projectConfigurationRevisionIdSchema.optional(),
    adoptedByDecisionId: projectDecisionIdSchema.optional(),
    sha256: sha256Schema,
    ...entityBase,
  })
  .strict()
  .superRefine((configuration, context) => {
    const adopted = configuration.status === "adopted";
    if (adopted !== (configuration.adoptedByDecisionId !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["adoptedByDecisionId"],
        message: "只有已采用Configuration必须且可以绑定采用Decision",
      });
    }
    if (adopted !== (configuration.effectiveFrom !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["effectiveFrom"],
        message: "只有已采用Configuration必须且可以开始生效",
      });
    }
    if (
      configuration.effectiveFrom !== undefined &&
      configuration.effectiveTo !== undefined &&
      Date.parse(configuration.effectiveTo) <= Date.parse(configuration.effectiveFrom)
    ) {
      context.addIssue({
        code: "custom",
        path: ["effectiveTo"],
        message: "Configuration结束时间必须晚于开始时间",
      });
    }
  });

export const projectManagedObjectRefSchema = z
  .object({
    kind: projectManagedObjectKindSchema,
    objectId: z.string().trim().min(1).max(200),
    revision: z.number().int().positive().optional(),
  })
  .strict();

export const projectEventSourceSchema = z
  .object({
    kind: z.enum(["user", "agent", "automation", "resource", "provider", "clock"]),
    principalId: principalIdSchema.optional(),
    participantId: projectParticipantIdSchema.optional(),
    sourceRef: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/** Event保存发生、观察、记录三个时间，View和Context从同一历史派生。 */
export const projectEventSchema = z
  .object({
    schemaVersion: z.literal("project-event.v1"),
    projectEventId: projectEventIdSchema,
    projectId: projectIdSchema,
    eventType: stableKeySchema,
    subject: projectManagedObjectRefSchema,
    source: projectEventSourceSchema,
    occurredAt: isoDateTimeSchema,
    observedAt: isoDateTimeSchema,
    recordedAt: isoDateTimeSchema,
    beforeRevision: z.number().int().positive().optional(),
    afterRevision: z.number().int().positive().optional(),
    payloadSha256: sha256Schema,
    evidenceIds: z.array(projectEvidenceIdSchema).max(20),
    ...entityBase,
  })
  .strict()
  .superRefine((event, context) => {
    if (
      Date.parse(event.observedAt) < Date.parse(event.occurredAt) ||
      Date.parse(event.recordedAt) < Date.parse(event.observedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["recordedAt"],
        message: "Project Event必须满足occurredAt <= observedAt <= recordedAt",
      });
    }
    if (
      (event.beforeRevision === undefined) !== (event.afterRevision === undefined) ||
      (event.beforeRevision !== undefined && event.afterRevision !== event.beforeRevision + 1)
    ) {
      context.addIssue({
        code: "custom",
        path: ["afterRevision"],
        message: "对象Revision变化必须同时记录连续before/after Revision",
      });
    }
  });

export const projectNeedSchema = z
  .object({
    schemaVersion: z.literal("project-need.v1"),
    projectNeedId: projectNeedIdSchema,
    projectId: projectIdSchema,
    statement: longText,
    origin: z.enum(["user", "resource", "agent_candidate", "external"]),
    status: z.enum(["captured", "shaped", "committed", "rejected", "superseded"]),
    occurredAt: isoDateTimeSchema,
    sourceRef: z.string().trim().min(1).max(500).optional(),
    commitmentDecisionId: projectDecisionIdSchema.optional(),
    ...entityBase,
  })
  .strict()
  .superRefine((need, context) => {
    if ((need.status === "committed") !== (need.commitmentDecisionId !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["commitmentDecisionId"],
        message: "只有Committed Need必须且可以绑定承诺Decision",
      });
    }
  });

export const projectRequirementSchema = z
  .object({
    schemaVersion: z.literal("project-requirement.v1"),
    projectRequirementId: projectRequirementIdSchema,
    projectId: projectIdSchema,
    needIds: z.array(projectNeedIdSchema).min(1).max(20),
    kind: z.enum(["outcome", "behavior", "quality", "constraint"]),
    statement: longText,
    acceptanceCriteria: z.array(shortText).min(1).max(30),
    status: z.enum(["proposed", "accepted", "superseded", "rejected"]),
    acceptanceDecisionId: projectDecisionIdSchema.optional(),
    ...entityBase,
  })
  .strict();

/** Artifact正文仍由Resource拥有；Chat只保存稳定Revision、Hash和Provenance入口。 */
export const projectArtifactRefSchema = z
  .object({
    schemaVersion: z.literal("project-artifact-ref.v1"),
    projectArtifactRefId: projectArtifactRefIdSchema,
    projectId: projectIdSchema,
    resourceId: projectResourceIdSchema,
    role: stableKeySchema,
    locator: z.string().trim().min(1).max(1_000),
    revisionRef: z.string().trim().min(1).max(500),
    contentSha256: sha256Schema,
    mediaType: z.string().trim().min(1).max(160),
    status: z.enum(["current", "superseded", "withdrawn"]),
    provenanceEventIds: z.array(projectEventIdSchema).min(1).max(50),
    observedAt: isoDateTimeSchema,
    ...entityBase,
  })
  .strict();

export const projectMetricObservationSchema = z
  .object({
    schemaVersion: z.literal("project-metric-observation.v1"),
    projectMetricObservationId: projectMetricObservationIdSchema,
    projectId: projectIdSchema,
    metricKey: stableKeySchema,
    value: z.number().finite(),
    unit: z.string().trim().min(1).max(80),
    windowStart: isoDateTimeSchema,
    windowEnd: isoDateTimeSchema,
    observedAt: isoDateTimeSchema,
    sourceRef: z.string().trim().min(1).max(500),
    evidenceIds: z.array(projectEvidenceIdSchema).max(20),
    ...entityBase,
  })
  .strict()
  .superRefine((observation, context) => {
    if (Date.parse(observation.windowEnd) <= Date.parse(observation.windowStart)) {
      context.addIssue({
        code: "custom",
        path: ["windowEnd"],
        message: "Metric观察窗口结束时间必须晚于开始时间",
      });
    }
  });

export type ProjectProfileKey = z.infer<typeof projectProfileKeySchema>;
export type ProjectManagedObjectKind = z.infer<typeof projectManagedObjectKindSchema>;
export type ProjectObjectPolicy = z.infer<typeof projectObjectPolicySchema>;
export type ProjectViewCapability = z.infer<typeof projectViewCapabilitySchema>;
export type ProjectViewRequirement = z.infer<typeof projectViewRequirementSchema>;
export type ProjectContextPurpose = z.infer<typeof projectContextPurposeSchema>;
export type ProjectContextPolicy = z.infer<typeof projectContextPolicySchema>;
export type ProjectCadence = z.infer<typeof projectCadenceSchema>;
export type ProjectProfileDefinition = z.infer<typeof projectProfileDefinitionSchema>;
export type ProjectTimePolicy = z.infer<typeof projectTimePolicySchema>;
export type ProjectConfigurationSchedulePolicy = z.infer<
  typeof projectConfigurationSchedulePolicySchema
>;
export type ProjectAuthorityPolicy = z.infer<typeof projectAuthorityPolicySchema>;
export type ProjectEvidencePolicy = z.infer<typeof projectEvidencePolicySchema>;
export type ProjectMetricPolicy = z.infer<typeof projectMetricPolicySchema>;
export type ProjectLifecyclePhase = z.infer<typeof projectLifecyclePhaseSchema>;
export type ProjectProfileRevision = z.infer<typeof projectProfileRevisionSchema>;
export type ProjectConfigurationRevision = z.infer<typeof projectConfigurationRevisionSchema>;
export type ProjectEvent = z.infer<typeof projectEventSchema>;
export type ProjectNeed = z.infer<typeof projectNeedSchema>;
export type ProjectRequirement = z.infer<typeof projectRequirementSchema>;
export type ProjectArtifactRef = z.infer<typeof projectArtifactRefSchema>;
export type ProjectMetricObservation = z.infer<typeof projectMetricObservationSchema>;
