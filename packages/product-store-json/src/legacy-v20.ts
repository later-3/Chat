import {
  legacyAgentVersionV1Schema,
  principalIdSchema,
  productSnapshotSchema,
  promptAssemblyV1Schema,
  promptAssemblyV2Schema,
  promptAssemblyV3Schema,
  projectIdSchema,
  projectProviderBindingIdSchema,
  projectProviderProjectionIdSchema,
  projectWorkKeySchema,
  projectWorkspaceBindingIdSchema,
  sha256Schema,
} from "@chat/contracts";
import { z } from "zod";

const idKeySchema = z.string().min(1).max(200);
const isoDateTimeSchema = z.iso.datetime();

/** P4 v20固定Binding形状；P5迁移不能用当前v2 Schema解释旧字节。 */
export const projectProviderBindingV20Schema = z
  .object({
    schemaVersion: z.literal("project-provider-binding.v1"),
    projectProviderBindingId: projectProviderBindingIdSchema,
    projectId: projectIdSchema,
    ownerPrincipalId: principalIdSchema,
    providerKind: z.literal("plane_ce"),
    providerVersion: z.string().trim().min(1).max(80),
    externalWorkspaceId: z.string().trim().min(1).max(200),
    externalProjectId: z.string().trim().min(1).max(200),
    externalProjectIdentifier: z.string().trim().min(1).max(80),
    syncPolicyVersion: z.literal("content-lab-plane-mapping.v1"),
    reconciledWorkspaceBindingId: projectWorkspaceBindingIdSchema.optional(),
    status: z.enum(["active", "needs_attention", "archived"]),
    revision: z.number().int().positive(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export const projectProviderProjectionV20Schema = z
  .object({
    schemaVersion: z.literal("project-provider-projection.v1"),
    projectProviderProjectionId: projectProviderProjectionIdSchema,
    projectId: projectIdSchema,
    bindingId: projectProviderBindingIdSchema,
    objectType: z.enum(["work", "practice_revision", "context_page", "publication_history_page"]),
    objectId: z.string().trim().min(1).max(200),
    providerObjectType: z.enum(["work_item", "page"]),
    providerObjectId: z.string().trim().min(1).max(200),
    externalKey: projectWorkKeySchema.optional(),
    chatObjectRevision: z.number().int().positive(),
    providerFingerprint: sha256Schema,
    syncStatus: z.enum(["healthy", "pending", "outcome_unknown", "needs_attention"]),
    lastSyncedAt: isoDateTimeSchema.optional(),
    revision: z.number().int().positive(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

const entitiesV20Schema = productSnapshotSchema.shape.entities
  .omit({
    projectCoordinationOperations: true,
    projectInboundChanges: true,
    toolExecutionIntents: true,
    toolExecutionDecisions: true,
    toolExecutionResults: true,
    projectProfileRevisions: true,
    projectConfigurationRevisions: true,
    projectEvents: true,
    projectNeeds: true,
    projectRequirements: true,
    projectArtifactRefs: true,
    projectMetricObservations: true,
    supervisedPlanningEpochs: true,
    supervisedCarryForwards: true,
    supervisedStepStates: true,
    supervisedAgentAttempts: true,
    supervisedStepEvidence: true,
    supervisedStepCandidates: true,
    supervisedPlannerVerdicts: true,
    supervisedStepReviewRequests: true,
    supervisedStepHumanDecisions: true,
    supervisedAgentOutcomeObservations: true,
    supervisedExecutionResults: true,
    memorySessionImports: true,
    memoryAgentOperations: true,
    memoryAgentWriteCandidates: true,
    memoryAgentWriteDecisions: true,
  })
  .extend({
    promptAssemblies: z.record(
      idKeySchema,
      z.union([promptAssemblyV1Schema, promptAssemblyV2Schema, promptAssemblyV3Schema]),
    ),
    agentVersions: z.record(idKeySchema, legacyAgentVersionV1Schema),
    projectProviderBindings: z.record(idKeySchema, projectProviderBindingV20Schema),
    projectProviderProjections: z.record(idKeySchema, projectProviderProjectionV20Schema),
  })
  .strict();

export const productSnapshotV20Schema = productSnapshotSchema
  .extend({
    schemaVersion: z.literal("chat-product-store.v20"),
    entities: entitiesV20Schema,
  })
  .strict();

export type ProductSnapshotV20 = z.infer<typeof productSnapshotV20Schema>;
