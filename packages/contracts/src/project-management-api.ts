import { z } from "zod";
import {
  commandIdSchema,
  principalIdSchema,
  projectIdSchema,
  projectProfileRevisionIdSchema,
  projectWorkIdSchema,
} from "./ids.js";
import {
  projectConfigurationRevisionIdSchema,
  projectEventIdSchema,
  projectNeedIdSchema,
  projectParticipantIdSchema,
} from "./ids.js";
import {
  projectContextPurposeSchema,
  projectConfigurationSchedulePolicySchema,
  projectManagedObjectKindSchema,
  projectPresentationBindingConfigSchema,
  projectProfileKeySchema,
  projectResourceBindingConfigSchema,
  projectViewCapabilitySchema,
} from "./project-management.js";
import { sha256Schema } from "./hash.js";

export const PROJECT_MANAGEMENT_API_VERSION = "project-management-api.v1";
export const PROJECT_AGENT_CONTEXT_V2_VERSION = "project-agent-context.v2";

const isoDateTimeSchema = z.iso.datetime();
const shortText = z.string().trim().min(1).max(500);
const longText = z.string().trim().min(1).max(8_000);

export const proposeProjectConfigurationPayloadSchema = z
  .object({
    profileKey: projectProfileKeySchema,
    objective: longText,
    scopeIn: z.array(shortText).min(1).max(40),
    scopeOut: z.array(shortText).max(40),
    successCriteria: z.array(shortText).min(1).max(40),
    timezone: z.string().trim().min(1).max(80),
    schedulePolicy: projectConfigurationSchedulePolicySchema,
    participantIds: z.array(projectParticipantIdSchema).min(1).max(100),
    resourceBindings: z.array(projectResourceBindingConfigSchema).max(100),
    presentationBindings: z.array(projectPresentationBindingConfigSchema).max(30),
    terminology: z.record(z.string().min(1).max(120), z.string().trim().min(1).max(160)),
    requiredReads: z.array(z.string().trim().min(1).max(500)).max(50),
  })
  .strict();

export const adoptProjectConfigurationPayloadSchema = z
  .object({
    candidateConfigurationRevisionId: projectConfigurationRevisionIdSchema,
    candidateRevision: z.number().int().positive(),
    candidateSha256: sha256Schema,
    decidedByParticipantId: projectParticipantIdSchema,
    rationale: z.string().trim().min(1).max(2_000),
  })
  .strict();

/** 用户已经明确目标与类型时，直接建立Project并采用首个Configuration。 */
export const createManagedProjectPayloadSchema = z
  .object({
    rootId: z.string().regex(/^root_[A-Za-z0-9]+$/u),
    profileKey: projectProfileKeySchema,
    name: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(1_000),
    objective: longText,
    scopeIn: z.array(shortText).min(1).max(40),
    scopeOut: z.array(shortText).max(40),
    successCriteria: z.array(shortText).min(1).max(40),
    initialStage: z
      .object({
        name: z.string().trim().min(1).max(120),
        goal: longText,
      })
      .strict(),
    timezone: z.string().trim().min(1).max(80),
    schedulePolicy: projectConfigurationSchedulePolicySchema,
    presentationBindings: z.array(projectPresentationBindingConfigSchema).max(30),
    requiredReads: z.array(z.string().trim().min(1).max(500)).max(50),
  })
  .strict();

export const captureProjectNeedPayloadSchema = z
  .object({
    statement: longText,
    origin: z.enum(["user", "resource", "agent_candidate", "external"]),
    occurredAt: isoDateTimeSchema,
    sourceRef: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const proposeProjectRequirementPayloadSchema = z
  .object({
    needIds: z.array(projectNeedIdSchema).min(1).max(20),
    kind: z.enum(["outcome", "behavior", "quality", "constraint"]),
    statement: longText,
    acceptanceCriteria: z.array(shortText).min(1).max(30),
  })
  .strict();

export const projectObjectSummaryDtoSchema = z
  .object({
    kind: projectManagedObjectKindSchema,
    objectId: z.string().min(1).max(200),
    title: z.string().min(1).max(500),
    revision: z.number().int().positive(),
    status: z.string().min(1).max(120).optional(),
    occurredAt: isoDateTimeSchema.optional(),
    updatedAt: isoDateTimeSchema.optional(),
    dueAt: isoDateTimeSchema.optional(),
    relationIds: z.array(z.string().min(1).max(200)).max(100),
    evidenceIds: z.array(z.string().min(1).max(200)).max(100),
    attentionReasons: z.array(shortText).max(20),
  })
  .strict();

/**
 * Project Query是同一权威对象集合的只读筛选，不建立第二套搜索索引。
 * `review`只返回当前需要人确认、验收或采用的对象；`attention`包含阻塞与异常。
 */
export const projectObjectQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200).optional(),
    kind: projectManagedObjectKindSchema.optional(),
    status: z.string().trim().min(1).max(120).optional(),
    view: z.enum(["all", "review", "attention"]).default("all"),
    limit: z.number().int().positive().max(500).default(100),
  })
  .strict();

export const projectObjectQueryResultDtoSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_MANAGEMENT_API_VERSION),
    projectId: projectIdSchema,
    query: projectObjectQuerySchema,
    total: z.number().int().nonnegative(),
    items: z.array(projectObjectSummaryDtoSchema).max(500),
    generatedAt: isoDateTimeSchema,
  })
  .strict();

export const projectPresentationSurfaceDtoSchema = z
  .object({
    capability: projectViewCapabilitySchema,
    required: z.boolean(),
    objectKinds: z.array(projectManagedObjectKindSchema).min(1).max(40),
    fields: z.array(z.string().min(1).max(120)).min(1).max(40),
    actions: z.array(z.string().min(1).max(120)).max(20),
    freshness: z.enum(["live", "snapshot", "eventual"]),
    fallbackIntent: z.enum(["embedded", "open_resource", "unsupported"]),
    binding: z
      .object({
        providerKind: z.string().min(1).max(120),
        bindingRef: z.string().min(1).max(500),
        mode: z.enum(["primary", "fallback"]),
      })
      .strict()
      .nullable(),
    availability: z.enum(["bound", "fallback", "unavailable"]),
  })
  .strict();

export const projectHomeDtoSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_MANAGEMENT_API_VERSION),
    projectId: projectIdSchema,
    name: z.string().min(1).max(120),
    status: z.string().min(1).max(120),
    revision: z.number().int().positive(),
    objective: longText,
    profile: z
      .object({
        profileKey: projectProfileKeySchema,
        title: z.string().min(1).max(160),
        version: z.number().int().positive(),
        sha256: sha256Schema,
      })
      .strict(),
    configuration: z
      .object({
        projectConfigurationRevisionId: projectConfigurationRevisionIdSchema,
        version: z.number().int().positive(),
        sha256: sha256Schema,
        effectiveFrom: isoDateTimeSchema,
        timezone: z.string().trim().min(1).max(80),
        schedulePolicy: projectConfigurationSchedulePolicySchema,
      })
      .strict(),
    objectCounts: z.partialRecord(projectManagedObjectKindSchema, z.number().int().nonnegative()),
    attention: z.array(projectObjectSummaryDtoSchema).max(100),
    recentEvents: z.array(projectObjectSummaryDtoSchema).max(100),
    presentationSurfaces: z.array(projectPresentationSurfaceDtoSchema).max(20),
    generatedAt: isoDateTimeSchema,
  })
  .strict();

export const projectAgentContextItemDtoSchema = projectObjectSummaryDtoSchema.extend({
  summary: z.string().max(8_000),
});

export const projectAgentContextDtoSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_MANAGEMENT_API_VERSION),
    purpose: projectContextPurposeSchema,
    projectId: projectIdSchema,
    profileRevisionId: z.string().min(1).max(200),
    profileRevisionSha256: sha256Schema,
    configurationRevisionId: projectConfigurationRevisionIdSchema,
    configurationRevisionSha256: sha256Schema,
    objective: longText,
    timezone: z.string().trim().min(1).max(80),
    schedulePolicy: projectConfigurationSchedulePolicySchema,
    items: z.array(projectAgentContextItemDtoSchema).max(1_000),
    resourceBindings: z.array(projectResourceBindingConfigSchema).max(100),
    recentEventIds: z.array(projectEventIdSchema).max(500),
    requiredReads: z.array(z.string().min(1).max(500)).max(50),
    omissions: z.array(shortText).max(100),
    compiledAt: isoDateTimeSchema,
    sha256: sha256Schema,
  })
  .strict();

export const projectAgentContextV2TargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project") }).strict(),
  z
    .object({
      kind: z.literal("work"),
      workId: projectWorkIdSchema,
      workRevision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("review"),
      workId: projectWorkIdSchema,
      workRevision: z.number().int().positive(),
      subject: z
        .object({
          kind: projectManagedObjectKindSchema,
          objectId: z.string().trim().min(1).max(200),
          revision: z.number().int().positive(),
          sha256: sha256Schema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("delta"),
      watermark: z
        .object({
          projectEventId: projectEventIdSchema,
          recordedAt: isoDateTimeSchema,
          payloadSha256: sha256Schema,
        })
        .strict(),
    })
    .strict(),
]);

/** v2把Context目的与精确目标绑定；v1只保留历史读取，不能承载新写语义。 */
export const projectAgentContextV2RequestSchema = z
  .object({
    purpose: projectContextPurposeSchema,
    target: projectAgentContextV2TargetSchema,
  })
  .strict()
  .superRefine((request, context) => {
    const expected =
      request.purpose === "project_opening" || request.purpose === "maintenance"
        ? "project"
        : request.purpose === "work_execution" || request.purpose === "handoff"
          ? "work"
          : request.purpose === "review"
            ? "review"
            : "delta";
    if (request.target.kind !== expected) {
      context.addIssue({
        code: "custom",
        path: ["target", "kind"],
        message: `${request.purpose}必须使用${expected}目标`,
      });
    }
  });

export const projectAgentContextV2DtoSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_AGENT_CONTEXT_V2_VERSION),
    purpose: projectContextPurposeSchema,
    target: projectAgentContextV2TargetSchema,
    projectId: projectIdSchema,
    profileRevisionId: projectProfileRevisionIdSchema,
    profileRevisionSha256: sha256Schema,
    configurationRevisionId: projectConfigurationRevisionIdSchema,
    configurationRevisionSha256: sha256Schema,
    objective: longText,
    timezone: z.string().trim().min(1).max(80),
    schedulePolicy: projectConfigurationSchedulePolicySchema,
    items: z.array(projectAgentContextItemDtoSchema).max(1_000),
    resourceBindings: z.array(projectResourceBindingConfigSchema).max(100),
    recentEventIds: z.array(projectEventIdSchema).max(500),
    requiredReads: z.array(z.string().min(1).max(500)).max(50),
    omissions: z.array(shortText).max(100),
    compiledAt: isoDateTimeSchema,
    sha256: sha256Schema,
  })
  .strict();

export const projectMaintenanceItemDtoSchema = z
  .object({
    cadenceKey: z.string().min(1).max(120),
    action: z.enum(["observe", "reconcile", "attention", "report", "review"]),
    reason: shortText,
    dueAt: isoDateTimeSchema.optional(),
    requiresHumanDecision: z.boolean(),
    proposedCommandType: z.string().min(1).max(160).optional(),
  })
  .strict();

export const projectMaintenancePlanDtoSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_MANAGEMENT_API_VERSION),
    projectId: projectIdSchema,
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
    items: z.array(projectMaintenanceItemDtoSchema).max(100),
    evaluatedAt: isoDateTimeSchema,
  })
  .strict();

export const projectManagementCommandContextSchema = z
  .object({
    principalId: principalIdSchema,
    commandId: commandIdSchema,
    projectId: projectIdSchema,
  })
  .strict();

export type ProposeProjectConfigurationPayload = z.infer<
  typeof proposeProjectConfigurationPayloadSchema
>;
export type AdoptProjectConfigurationPayload = z.infer<
  typeof adoptProjectConfigurationPayloadSchema
>;
export type CreateManagedProjectPayload = z.infer<typeof createManagedProjectPayloadSchema>;
export type CaptureProjectNeedPayload = z.infer<typeof captureProjectNeedPayloadSchema>;
export type ProposeProjectRequirementPayload = z.infer<
  typeof proposeProjectRequirementPayloadSchema
>;
export type ProjectObjectSummaryDto = z.infer<typeof projectObjectSummaryDtoSchema>;
export type ProjectObjectQuery = z.infer<typeof projectObjectQuerySchema>;
export type ProjectObjectQueryResultDto = z.infer<typeof projectObjectQueryResultDtoSchema>;
export type ProjectPresentationSurfaceDto = z.infer<typeof projectPresentationSurfaceDtoSchema>;
export type ProjectHomeDto = z.infer<typeof projectHomeDtoSchema>;
export type ProjectAgentContextDto = z.infer<typeof projectAgentContextDtoSchema>;
export type ProjectAgentContextV2Target = z.infer<typeof projectAgentContextV2TargetSchema>;
export type ProjectAgentContextV2Request = z.infer<typeof projectAgentContextV2RequestSchema>;
export type ProjectAgentContextV2Dto = z.infer<typeof projectAgentContextV2DtoSchema>;
export type ProjectMaintenancePlanDto = z.infer<typeof projectMaintenancePlanDtoSchema>;
