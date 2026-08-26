import { z } from "zod";
import { commandEnvelopeSchema } from "./command.js";
import {
  projectCoordinationOperationIdSchema,
  projectIdSchema,
  projectInboundChangeIdSchema,
  projectParticipantIdSchema,
  projectProviderBindingIdSchema,
} from "./ids.js";
import {
  planeProjectBindingSchema,
  planeProjectKeySchema,
  planeProjectOperationInputIntentSchema,
  planeProjectOperationSchema,
  planeProjectOperationManualDispositionKindSchema,
  planeProjectOperationManualDispositionReasonSchema,
  planeProjectOperationStatusSchema,
  planeProjectSnapshotSchema,
  planeWorkItemCommentsSnapshotSchema,
  projectInboundChangeSchema,
  projectInboundChangeStatusSchema,
} from "./plane-project-coordination.js";
import { planeCeProjectIdentifierSchema, planeCeWorkspaceSlugSchema } from "./project-bootstrap.js";
import { promptWorkspaceRootIdSchema } from "./prompt-fragment.js";

/**
 * 认领既有Plane项目只接受稳定业务键；Application必须先只读验证项目身份，
 * 再提交Chat Binding。浏览器永远不会得到Provider Token、Base URL或本机绝对路径。
 */
export const adoptExistingPlaneProjectPayloadSchema = z
  .object({
    projectId: projectIdSchema,
    projectKey: planeProjectKeySchema,
    workspaceRootId: promptWorkspaceRootIdSchema,
    coordinationAgentParticipantId: projectParticipantIdSchema,
    humanActorExternalIds: z.array(z.string().trim().min(1).max(200)).max(20),
    planeWorkspaceSlug: planeCeWorkspaceSlugSchema,
    planeProjectIdentifier: planeCeProjectIdentifierSchema,
    stateMappings: z
      .array(
        z
          .object({
            workKind: z.enum(["generic", "content_delivery", "workflow_improvement"]),
            chatState: z.string().trim().min(1).max(80),
            providerStateId: z.string().trim().min(1).max(200),
            providerStateName: z.string().trim().min(1).max(100),
            providerStateGroup: z.enum([
              "backlog",
              "unstarted",
              "started",
              "completed",
              "cancelled",
            ]),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    moduleMappings: z
      .array(
        z
          .object({
            mappingKey: z.string().regex(/^[a-z0-9][a-z0-9:._-]{0,119}$/u),
            providerModuleId: z.string().trim().min(1).max(200),
            providerModuleName: z.string().trim().min(1).max(255),
          })
          .strict(),
      )
      .max(100),
    labelMappings: z
      .array(
        z
          .object({
            mappingKey: z
              .string()
              .regex(/^(?:kind|platform|series|executor):[a-z0-9][a-z0-9._-]{0,119}$/u),
            providerLabelId: z.uuid(),
            providerLabelName: z.string().trim().min(1).max(255),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

export const adoptExistingPlaneProjectCommandSchema = commandEnvelopeSchema.extend({
  payload: adoptExistingPlaneProjectPayloadSchema,
});

export const adoptExistingPlaneProjectResponseSchema = z
  .object({
    binding: planeProjectBindingSchema,
    snapshot: planeProjectSnapshotSchema,
  })
  .strict();

export const getPlaneProjectBindingQuerySchema = z
  .object({ planeProjectBindingId: projectProviderBindingIdSchema })
  .strict();

export const getPlaneProjectBindingResponseSchema = z
  .object({ binding: planeProjectBindingSchema })
  .strict();

export const listPlaneProjectBindingsQuerySchema = z
  .object({
    status: z.enum(["active", "needs_attention", "archived"]).optional(),
    cursor: z.string().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const listPlaneProjectBindingsResponseSchema = z
  .object({
    bindings: z.array(planeProjectBindingSchema).max(100),
    nextCursor: z.string().min(1).max(500).optional(),
  })
  .strict();

export const getPlaneProjectSnapshotQuerySchema = z
  .object({ planeProjectBindingId: projectProviderBindingIdSchema })
  .strict();

export const getPlaneProjectSnapshotResponseSchema = z
  .object({ snapshot: planeProjectSnapshotSchema })
  .strict();

export const listPlaneWorkItemCommentsQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
  .strict();

export const listPlaneWorkItemCommentsResponseSchema = z
  .object({ snapshot: planeWorkItemCommentsSnapshotSchema })
  .strict();

export const listPlaneProjectInboundChangesQuerySchema = z
  .object({
    planeProjectBindingId: projectProviderBindingIdSchema.optional(),
    status: projectInboundChangeStatusSchema.optional(),
    cursor: projectInboundChangeIdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const listPlaneProjectInboundChangesResponseSchema = z
  .object({
    inboundChanges: z.array(projectInboundChangeSchema).max(100),
    nextCursor: projectInboundChangeIdSchema.optional(),
  })
  .strict();

export const resolvePlaneProjectInboundChangePayloadSchema = z
  .object({
    projectInboundChangeId: projectInboundChangeIdSchema,
    disposition: z.enum(["adopt_plane", "keep_chat"]),
    rationale: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const resolvePlaneProjectInboundChangeCommandSchema = commandEnvelopeSchema.extend({
  expectedRevision: z.number().int().positive(),
  payload: resolvePlaneProjectInboundChangePayloadSchema,
});

export const resolvePlaneProjectInboundChangeResponseSchema = z
  .object({ inboundChange: projectInboundChangeSchema })
  .strict();

export const preparePlaneProjectOperationPayloadSchema = z
  .object({
    planeProjectBindingId: projectProviderBindingIdSchema,
    intent: planeProjectOperationInputIntentSchema,
  })
  .strict();

export const preparePlaneProjectOperationCommandSchema = commandEnvelopeSchema.extend({
  payload: preparePlaneProjectOperationPayloadSchema,
});

export const executePlaneProjectOperationPayloadSchema = z
  .object({ planeProjectOperationId: projectCoordinationOperationIdSchema })
  .strict();

export const executePlaneProjectOperationCommandSchema = commandEnvelopeSchema.extend({
  payload: executePlaneProjectOperationPayloadSchema,
});

export const reconcilePlaneProjectOperationPayloadSchema = z
  .object({ planeProjectOperationId: projectCoordinationOperationIdSchema })
  .strict();

export const reconcilePlaneProjectOperationCommandSchema = commandEnvelopeSchema.extend({
  payload: reconcilePlaneProjectOperationPayloadSchema,
});

/**
 * 仅供已经证明人类Owner身份的产品命令面使用。scoped Plane client、Pi callback与
 * Runtime credential都不得把这个Schema自动变成可调用路由。
 */
export const manuallyDisposePlaneProjectOperationPayloadSchema = z
  .object({
    planeProjectOperationId: projectCoordinationOperationIdSchema,
    disposition: planeProjectOperationManualDispositionKindSchema,
    reason: planeProjectOperationManualDispositionReasonSchema,
  })
  .strict();

export const manuallyDisposePlaneProjectOperationCommandSchema = commandEnvelopeSchema.extend({
  /** 协议沿用Product Command信封；Router映射为Application expectedOperationRevision。 */
  expectedRevision: z.number().int().positive(),
  payload: manuallyDisposePlaneProjectOperationPayloadSchema,
});

export const planeProjectOperationResponseSchema = z
  .object({ operation: planeProjectOperationSchema })
  .strict();

/** 新Agent用这个Query发现跨Session留下的未决Operation，而不是依赖本地Task缓存。 */
export const listPlaneProjectOperationsQuerySchema = z
  .object({
    planeProjectBindingId: projectProviderBindingIdSchema.optional(),
    status: planeProjectOperationStatusSchema.optional(),
    cursor: projectCoordinationOperationIdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const listPlaneProjectOperationsResponseSchema = z
  .object({
    operations: z.array(planeProjectOperationSchema).max(100),
    nextCursor: projectCoordinationOperationIdSchema.optional(),
  })
  .strict();

export const syncPlaneProjectPayloadSchema = z
  .object({ planeProjectBindingId: projectProviderBindingIdSchema })
  .strict();

export const syncPlaneProjectResponseSchema = z
  .object({
    snapshot: planeProjectSnapshotSchema,
    inboundChanges: z.array(projectInboundChangeSchema).max(500),
  })
  .strict();

export type AdoptExistingPlaneProjectPayload = z.infer<
  typeof adoptExistingPlaneProjectPayloadSchema
>;
export type AdoptExistingPlaneProjectResponse = z.infer<
  typeof adoptExistingPlaneProjectResponseSchema
>;
export type ListPlaneProjectBindingsQuery = z.infer<typeof listPlaneProjectBindingsQuerySchema>;
export type ListPlaneProjectBindingsResponse = z.infer<
  typeof listPlaneProjectBindingsResponseSchema
>;
export type ListPlaneWorkItemCommentsQuery = z.infer<typeof listPlaneWorkItemCommentsQuerySchema>;
export type ListPlaneProjectInboundChangesQuery = z.infer<
  typeof listPlaneProjectInboundChangesQuerySchema
>;
export type ResolvePlaneProjectInboundChangePayload = z.infer<
  typeof resolvePlaneProjectInboundChangePayloadSchema
>;
export type PreparePlaneProjectOperationPayload = z.infer<
  typeof preparePlaneProjectOperationPayloadSchema
>;
export type ExecutePlaneProjectOperationPayload = z.infer<
  typeof executePlaneProjectOperationPayloadSchema
>;
export type ReconcilePlaneProjectOperationPayload = z.infer<
  typeof reconcilePlaneProjectOperationPayloadSchema
>;
export type ManuallyDisposePlaneProjectOperationPayload = z.infer<
  typeof manuallyDisposePlaneProjectOperationPayloadSchema
>;
export type PlaneProjectOperationResponse = z.infer<typeof planeProjectOperationResponseSchema>;
export type ListPlaneProjectOperationsQuery = z.infer<typeof listPlaneProjectOperationsQuerySchema>;
export type ListPlaneProjectOperationsResponse = z.infer<
  typeof listPlaneProjectOperationsResponseSchema
>;
