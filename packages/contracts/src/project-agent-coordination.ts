import { z } from "zod";
import { contentLabContextBundleSchema } from "./content-lab-project.js";
import {
  productSessionIdSchema,
  projectCoordinationOperationIdSchema,
  projectIdSchema,
  projectInboundChangeIdSchema,
  projectMethodSnapshotIdSchema,
  projectObservationIdSchema,
  projectParticipantIdSchema,
  projectProviderBindingIdSchema,
  projectResourceIdSchema,
  projectWorkIdSchema,
} from "./ids.js";
import {
  projectMethodProfileIdSchema,
  projectWorkKeySchema,
  projectWorkKindSchema,
  projectWorkStatusSchema,
} from "./project.js";
import {
  planeProjectOperationStatusSchema,
  planeStateGroupSchema,
} from "./plane-project-coordination.js";
import { promptWorkspaceRootIdSchema } from "./prompt-fragment.js";
import {
  projectAgentContextDtoSchema,
  projectMaintenancePlanDtoSchema,
} from "./project-management-api.js";

export const PROJECT_AGENT_COORDINATION_SCHEMA_VERSION = "project-agent-coordination.v1";
export const PROJECT_AGENT_COORDINATION_V2_SCHEMA_VERSION = "project-agent-coordination.v2";

const queryBooleanSchema = z.enum(["true", "false"]).transform((value) => value === "true");

/** 路由只接受稳定产品/Root身份；本机绝对路径由服务端Root Registry拥有。 */
export const projectAgentOpeningPacketQuerySchema = z
  .object({
    projectId: projectIdSchema.optional(),
    productSessionId: productSessionIdSchema.optional(),
    workspaceRootId: promptWorkspaceRootIdSchema.optional(),
    workKey: projectWorkKeySchema.optional(),
    participantId: projectParticipantIdSchema.optional(),
    includeResourceContext: queryBooleanSchema.default(false),
    refreshPlane: queryBooleanSchema.default(true),
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

const projectAgentPlaneProjectionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_bound") }).strict(),
  z
    .object({
      status: z.enum(["unavailable", "needs_attention"]),
      planeProjectBindingId: projectProviderBindingIdSchema,
      errorCode: z.string().min(1).max(120),
    })
    .strict(),
  z
    .object({
      status: z.literal("ready"),
      planeProjectBindingId: projectProviderBindingIdSchema,
      planeWorkspaceSlug: z.string().min(1).max(80),
      planeProjectId: z.uuid(),
      planeProjectIdentifier: z.string().min(1).max(12),
      planeProjectName: z.string().min(1).max(255),
      currentWorkItem: z
        .object({
          planeWorkItemId: z.uuid(),
          sequenceId: z.number().int().positive(),
          name: z.string().min(1).max(255),
          priority: z.enum(["none", "urgent", "high", "medium", "low"]),
          stateName: z.string().min(1).max(100),
          stateGroup: planeStateGroupSchema,
          updatedAt: z.iso.datetime(),
        })
        .strict()
        .nullable(),
      totalWorkItemCount: z.number().int().nonnegative(),
      unresolvedOperationCount: z.number().int().nonnegative(),
      pendingInboundChangeCount: z.number().int().nonnegative(),
      capturedAt: z.iso.datetime(),
    })
    .strict(),
]);

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

export const projectAgentOpeningPacketSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_AGENT_COORDINATION_SCHEMA_VERSION),
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
    permissions: z
      .object({
        allowedActions: z
          .array(
            z.enum([
              "select_work",
              "claim",
              "progress",
              "block",
              "resume",
              "request_review",
              "record_evidence",
              "handoff",
              "reconcile",
            ]),
          )
          .max(9),
        planeWritesThroughChatOnly: z.literal(true),
        rawPlaneCredentialAvailable: z.literal(false),
      })
      .strict(),
    completionGate: projectAgentCompletionGateSchema.nullable(),
    plane: projectAgentPlaneProjectionSchema,
    pendingOperations: z
      .array(
        z
          .object({
            planeProjectOperationId: projectCoordinationOperationIdSchema,
            projectWorkId: projectWorkIdSchema,
            kind: z.enum([
              "ensure_work_item",
              "start",
              "block",
              "request_review",
              "progress",
              "evidence",
            ]),
            status: planeProjectOperationStatusSchema,
            errorCode: z.string().max(120).optional(),
            revision: z.number().int().positive(),
            updatedAt: z.iso.datetime(),
          })
          .strict(),
      )
      .max(100),
    pendingInboundChanges: z
      .array(
        z
          .object({
            projectInboundChangeId: projectInboundChangeIdSchema,
            projectWorkId: projectWorkIdSchema,
            classification: z.enum([
              "display_only",
              "adoptable",
              "candidate_required",
              "provider_owned",
              "forbidden_conflict",
            ]),
            status: z.enum([
              "observed",
              "adopted",
              "candidate",
              "ignored",
              "needs_attention",
              "resolved",
            ]),
            revision: z.number().int().positive(),
            updatedAt: z.iso.datetime(),
          })
          .strict(),
      )
      .max(100),
    resourceContext: projectAgentResourceContextSchema,
    /** 新Agent自动获得工具无关Opening Context和Maintenance计划；optional只用于旧客户端兼容。 */
    management: z
      .discriminatedUnion("status", [
        z
          .object({
            status: z.literal("not_configured"),
            reason: z.string().min(1).max(500),
          })
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
    generatedAt: z.iso.datetime(),
  })
  .strict();

export const projectAgentOpeningPacketResponseSchema = z
  .object({ packet: projectAgentOpeningPacketSchema })
  .strict();

/**
 * 普通Agent开工只消费Chat权威Project事实。v1永久保留历史Plane投影的读取合同；
 * v2用新literal删除Provider专用查询和响应字段，避免同代Schema原地变形。
 */
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

export const projectAgentOpeningPacketV2Schema = projectAgentOpeningPacketSchema
  .omit({
    schemaVersion: true,
    permissions: true,
    plane: true,
    pendingOperations: true,
    pendingInboundChanges: true,
  })
  .extend({
    schemaVersion: z.literal(PROJECT_AGENT_COORDINATION_V2_SCHEMA_VERSION),
    permissions: z
      .object({
        allowedActions: projectAgentOpeningPacketSchema.shape.permissions.shape.allowedActions,
      })
      .strict(),
  })
  .strict();

export const projectAgentOpeningPacketV2ResponseSchema = z
  .object({ packet: projectAgentOpeningPacketV2Schema })
  .strict();

export type ProjectAgentOpeningPacketQuery = z.infer<typeof projectAgentOpeningPacketQuerySchema>;
export type ProjectAgentOpeningPacket = z.infer<typeof projectAgentOpeningPacketSchema>;
export type ProjectAgentOpeningPacketV2Query = z.infer<
  typeof projectAgentOpeningPacketV2QuerySchema
>;
export type ProjectAgentOpeningPacketV2 = z.infer<typeof projectAgentOpeningPacketV2Schema>;
