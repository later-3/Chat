import {
  legacyAgentVersionV1Schema,
  promptAssemblyV1Schema,
  promptAssemblyV2Schema,
  promptAssemblyV3Schema,
  projectDecisionIdSchema,
  commandIdSchema,
  projectEvidenceIdSchema,
  projectIdSchema,
  projectMethodSnapshotIdSchema,
  projectParticipantIdSchema,
  projectResourceIdSchema,
  projectStageIdSchema,
  projectWorkIdSchema,
  productSnapshotSchema,
  sha256Schema,
} from "@chat/contracts";
import { z } from "zod";

const idKeySchema = z.string().min(1).max(200);
const isoDateTimeSchema = z.iso.datetime();
const shortText = z.string().trim().min(1).max(500);
const longText = z.string().trim().min(1).max(4_000);
const entityBase = {
  revision: z.number().int().positive(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
};

export const projectMethodProfileIdV19Schema = z.enum([
  "small-project.v1",
  "software-delivery.v1",
  "lightweight.v1",
]);

export const projectMethodSnapshotPoliciesV19Schema = z
  .object({
    stage: z
      .object({
        singleActive: z.literal(true),
        completionDecision: z.enum(["required", "optional"]),
        completionEvidence: z.enum(["required", "optional"]),
      })
      .strict(),
    iteration: z
      .object({
        enabled: z.boolean(),
        singleActive: z.literal(true),
        appetiteKind: z.enum(["timebox_days", "review_trigger"]),
        minDays: z.number().int().positive().optional(),
        maxDays: z.number().int().positive().optional(),
        circuitBreaker: z.boolean(),
      })
      .strict(),
    work: z
      .object({
        scopeEnabled: z.boolean(),
        readyGate: z.enum(["required", "optional"]),
        doneGate: z.enum(["required", "optional"]),
      })
      .strict(),
    artifact: z
      .object({
        requiredRoles: z.array(z.enum(["requirements", "architecture", "testing_strategy"])).max(3),
      })
      .strict(),
    quality: z
      .object({ evidenceRequired: z.boolean(), waiverRequiresApproverAndExpiry: z.literal(true) })
      .strict(),
    change: z
      .object({
        stageTransitionDecision: z.enum(["required", "optional"]),
        iterationCommitmentDecision: z.enum(["required", "optional"]),
      })
      .strict(),
  })
  .strict();

export const projectMethodSnapshotV19Schema = z
  .object({
    schemaVersion: z.literal("project-method-snapshot.v2"),
    projectMethodSnapshotId: projectMethodSnapshotIdSchema,
    projectId: projectIdSchema,
    profileId: projectMethodProfileIdV19Schema,
    rationale: z.string().min(1).max(2_000),
    policies: projectMethodSnapshotPoliciesV19Schema,
    source: z.enum(["project_intake", "migrated_v1", "user_tailored"]),
    sha256: sha256Schema,
    ...entityBase,
  })
  .strict();

export const projectWorkV19Schema = z
  .object({
    schemaVersion: z.literal("project-work.v1"),
    projectWorkId: projectWorkIdSchema,
    projectId: projectIdSchema,
    stageId: projectStageIdSchema,
    title: z.string().min(1).max(200),
    objective: longText,
    acceptanceCriteria: z.array(shortText).min(1).max(20),
    dependsOn: z.array(projectWorkIdSchema).max(20),
    ownerParticipantId: projectParticipantIdSchema,
    status: z.enum(["draft", "approved", "in_progress", "review", "done", "cancelled"]),
    ...entityBase,
  })
  .strict();

export const projectEvidenceV19Schema = z
  .object({
    schemaVersion: z.literal("project-evidence.v1"),
    projectEvidenceId: projectEvidenceIdSchema,
    projectId: projectIdSchema,
    resourceId: projectResourceIdSchema.optional(),
    kind: z.enum(["resource_observation", "commit", "pull_request", "test", "artifact", "trace"]),
    label: z.string().min(1).max(240),
    revisionRef: z.string().min(1).max(240),
    sha256: sha256Schema,
    observedAt: isoDateTimeSchema,
    ...entityBase,
  })
  .strict();

export const projectDecisionV19Schema = z
  .object({
    schemaVersion: z.literal("project-decision.v1"),
    projectDecisionId: projectDecisionIdSchema,
    projectId: projectIdSchema,
    question: z.string().min(1).max(1_000),
    options: z.array(z.string().min(1).max(1_000)).min(1).max(12),
    choice: z.string().min(1).max(1_000),
    rationale: z.string().min(1).max(2_000),
    decidedByParticipantId: projectParticipantIdSchema,
    boundProjectRevision: z.number().int().positive(),
    status: z.enum(["active", "superseded", "revoked"]),
    supersededByDecisionId: projectDecisionIdSchema.optional(),
    commandId: commandIdSchema,
    ...entityBase,
  })
  .strict();

const productSnapshotV19EntitiesSchema = productSnapshotSchema.shape.entities
  .omit({
    projectWorkBlocks: true,
    projectWorkClaims: true,
    projectWorkHandoffs: true,
    projectPracticeRevisions: true,
    projectWorkOutcomes: true,
    projectContextMaps: true,
    projectProviderBindings: true,
    projectProviderProjections: true,
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
    /** v19只能按当时已发布代际解释，不能借当前union反向改写历史语义。 */
    promptAssemblies: z.record(
      idKeySchema,
      z.union([promptAssemblyV1Schema, promptAssemblyV2Schema, promptAssemblyV3Schema]),
    ),
    agentVersions: z.record(idKeySchema, legacyAgentVersionV1Schema),
    projectMethodSnapshots: z.record(idKeySchema, projectMethodSnapshotV19Schema),
    projectWorks: z.record(idKeySchema, projectWorkV19Schema),
    projectEvidence: z.record(idKeySchema, projectEvidenceV19Schema),
    projectDecisions: z.record(idKeySchema, projectDecisionV19Schema),
  })
  .strict();

export const productSnapshotV19Schema = productSnapshotSchema
  .extend({
    schemaVersion: z.literal("chat-product-store.v19"),
    entities: productSnapshotV19EntitiesSchema,
  })
  .strict();

export type ProductSnapshotV19 = z.infer<typeof productSnapshotV19Schema>;
