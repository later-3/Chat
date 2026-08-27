import { z } from "zod";
import { contentLabContextBundleSchema } from "./content-lab-project.js";
import {
  productSessionIdSchema,
  projectIdSchema,
  projectMethodSnapshotIdSchema,
  projectObservationIdSchema,
  projectParticipantIdSchema,
  projectResourceIdSchema,
  projectWorkIdSchema,
} from "./ids.js";
import {
  projectMethodProfileIdSchema,
  projectWorkKeySchema,
  projectWorkKindSchema,
  projectWorkStatusSchema,
} from "./project.js";
import { promptWorkspaceRootIdSchema } from "./prompt-fragment.js";
import {
  projectAgentContextDtoSchema,
  projectAgentContextV2DtoSchema,
  projectMaintenancePlanDtoSchema,
} from "./project-management-api.js";

export const PROJECT_AGENT_COORDINATION_V2_SCHEMA_VERSION = "project-agent-coordination.v2";
export const PROJECT_AGENT_COORDINATION_V3_SCHEMA_VERSION = "project-agent-coordination.v3";

const queryBooleanSchema = z.enum(["true", "false"]).transform((value) => value === "true");

/** 路由只接受稳定产品/Root身份；本机绝对路径由服务端Root Registry拥有。 */
export const projectAgentOpeningPacketV2QuerySchema = z
  .object({
    projectId: projectIdSchema.optional(),
    productSessionId: productSessionIdSchema.optional(),
    workspaceRootId: promptWorkspaceRootIdSchema.optional(),
    workKey: projectWorkKeySchema.optional(),
    participantId: projectParticipantIdSchema.optional(),
    includeResourceContext: queryBooleanSchema.default(false),
  })
  .strict()
  .superRefine((query, context) => {
    if (
      query.projectId === undefined &&
      query.productSessionId === undefined &&
      query.workspaceRootId === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["projectId"],
        message: "Project Resolver至少需要Project、Product Session或Workspace Root之一",
      });
    }
  });

const projectAgentWorkBriefSchema = z
  .object({
    projectWorkId: projectWorkIdSchema,
    workKey: projectWorkKeySchema,
    kind: projectWorkKindSchema,
    status: projectWorkStatusSchema,
    title: z.string().min(1).max(200),
    objective: z.string().min(1).max(4_000),
    acceptanceCriteria: z.array(z.string().min(1).max(500)).min(1).max(20),
    ownerParticipantId: projectParticipantIdSchema,
    resourceRefs: z.array(z.string().min(1).max(500)).max(50),
    revision: z.number().int().positive(),
    activeClaim: z
      .object({
        participantId: projectParticipantIdSchema,
        leaseExpiresAt: z.iso.datetime(),
        ownedByRequester: z.boolean(),
      })
      .strict()
      .nullable(),
    activeBlock: z
      .object({
        reason: z.string().min(1).max(4_000),
        stoppedAt: z.string().min(1).max(4_000),
        recoveryConditions: z.array(z.string().min(1).max(500)).min(1).max(20),
      })
      .strict()
      .nullable(),
    latestHandoff: z
      .object({
        fromParticipantId: projectParticipantIdSchema,
        toParticipantId: projectParticipantIdSchema.optional(),
        completed: z.array(z.string().min(1).max(500)).max(20),
        remaining: z.array(z.string().min(1).max(500)).min(1).max(20),
        risks: z.array(z.string().min(1).max(500)).max(20),
        nextStep: z.string().min(1).max(500),
        requiredReads: z.array(z.string().min(1).max(500)).max(20),
        evidenceIds: z.array(z.string().min(1).max(120)).max(20),
        createdAt: z.iso.datetime(),
      })
      .strict()
      .nullable(),
  })
  .strict();

const projectAgentCompletionGateSchema = z
  .object({
    terminalState: z.enum(["done", "published", "adopted"]),
    requiredEvidenceRoles: z
      .array(
        z.enum([
          "content_revision",
          "qc_report",
          "publication_receipt",
          "practice_case",
          "practice_revision",
          "commit",
          "test",
        ]),
      )
      .max(10),
    humanDecisionRequired: z.boolean(),
    publicationOutcomeRequired: z.boolean(),
    automaticTerminalTransitionAllowed: z.literal(false),
    explanation: z.string().min(1).max(1_000),
  })
  .strict();

const projectAgentResourceContextSchema = z.discriminatedUnion("status", [
  z.object({ status: z.enum(["not_requested", "not_applicable"]) }).strict(),
  z
    .object({
      status: z.literal("unavailable"),
      errorCode: z.string().min(1).max(120),
      message: z.string().min(1).max(500),
    })
    .strict(),
  z.object({ status: z.literal("ready"), bundle: contentLabContextBundleSchema }).strict(),
]);

const allowedActionSchema = z.enum([
  "select_work",
  "claim",
  "progress",
  "block",
  "resume",
  "request_review",
  "record_evidence",
  "handoff",
  "reconcile",
]);

const projectAgentOpeningPacketBaseShape = {
  resolution: z
    .object({
      projectId: projectIdSchema,
      sources: z
        .array(z.enum(["project_id", "product_session", "workspace_root"]))
        .min(1)
        .max(3),
      productSessionId: productSessionIdSchema.optional(),
      workspaceRootId: promptWorkspaceRootIdSchema.optional(),
    })
    .strict(),
  project: z
    .object({
      projectId: projectIdSchema,
      name: z.string().min(1).max(120),
      goal: z.string().min(1).max(4_000),
      status: z.enum(["active", "paused", "completed", "archived"]),
      revision: z.number().int().positive(),
      methodSnapshotId: projectMethodSnapshotIdSchema,
      methodProfileId: projectMethodProfileIdSchema,
      methodSnapshotRevision: z.number().int().positive(),
      contextMapId: z.string().optional(),
      contextMapRevision: z.number().int().positive().optional(),
      contextMapSha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/u)
        .optional(),
    })
    .strict(),
  participant: z
    .object({
      projectParticipantId: projectParticipantIdSchema,
      displayName: z.string().min(1).max(120),
      role: z.string().min(1).max(120),
    })
    .strict()
    .nullable(),
  resource: z
    .object({
      projectResourceId: projectResourceIdSchema,
      workspaceRootId: promptWorkspaceRootIdSchema,
      displayName: z.string().min(1).max(160),
      latestObservationId: projectObservationIdSchema.optional(),
      latestObservationAt: z.iso.datetime().optional(),
      changeCandidateClassification: z.enum(["baseline", "none", "review_required"]).optional(),
      observedJobCount: z.number().int().nonnegative().optional(),
    })
    .strict()
    .nullable(),
  currentWork: projectAgentWorkBriefSchema.nullable(),
  workCandidates: z.array(projectAgentWorkBriefSchema).max(100),
  requiresWorkSelection: z.boolean(),
  permissions: z.object({ allowedActions: z.array(allowedActionSchema).max(9) }).strict(),
  completionGate: projectAgentCompletionGateSchema.nullable(),
  resourceContext: projectAgentResourceContextSchema,
  generatedAt: z.iso.datetime(),
};

export const projectAgentOpeningPacketV2Schema = z
  .object({
    schemaVersion: z.literal(PROJECT_AGENT_COORDINATION_V2_SCHEMA_VERSION),
    ...projectAgentOpeningPacketBaseShape,
    management: z
      .discriminatedUnion("status", [
        z
          .object({ status: z.literal("not_configured"), reason: z.string().min(1).max(500) })
          .strict(),
        z
          .object({
            status: z.literal("ready"),
            context: projectAgentContextDtoSchema,
            maintenance: projectMaintenancePlanDtoSchema,
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();

export const projectAgentOpeningPacketV2ResponseSchema = z
  .object({ packet: projectAgentOpeningPacketV2Schema })
  .strict();

/** v3把普通Opening的管理Context升级为精确目标v2。 */
export const projectAgentOpeningPacketV3Schema = projectAgentOpeningPacketV2Schema
  .omit({ schemaVersion: true, management: true })
  .extend({
    schemaVersion: z.literal(PROJECT_AGENT_COORDINATION_V3_SCHEMA_VERSION),
    management: z
      .discriminatedUnion("status", [
        z
          .object({ status: z.literal("not_configured"), reason: z.string().min(1).max(500) })
          .strict(),
        z
          .object({
            status: z.literal("ready"),
            context: projectAgentContextV2DtoSchema,
            maintenance: projectMaintenancePlanDtoSchema,
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();

export const projectAgentOpeningPacketV3ResponseSchema = z
  .object({ packet: projectAgentOpeningPacketV3Schema })
  .strict();

export type ProjectAgentOpeningPacketV2Query = z.infer<
  typeof projectAgentOpeningPacketV2QuerySchema
>;
export type ProjectAgentOpeningPacketV2 = z.infer<typeof projectAgentOpeningPacketV2Schema>;
export type ProjectAgentOpeningPacketV3 = z.infer<typeof projectAgentOpeningPacketV3Schema>;
