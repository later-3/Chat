import {
  legacyAgentVersionV1Schema,
  productSnapshotSchema,
  promptAssemblyV1Schema,
  promptAssemblyV2Schema,
  promptAssemblyV3Schema,
} from "@chat/contracts";
import { z } from "zod";

const idKeySchema = z.string().min(1).max(200);

/**
 * Content Lab P5-P8实际发布的v21：拥有完整Project Coordination事实，
 * 但尚不存在Capability Governance的Tool Execution三组集合。
 */
const projectCoordinationV21EntitiesSchema = productSnapshotSchema.shape.entities
  .omit({
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
  })
  .extend({
    promptAssemblies: z.record(
      idKeySchema,
      z.union([promptAssemblyV1Schema, promptAssemblyV2Schema, promptAssemblyV3Schema]),
    ),
    agentVersions: z.record(idKeySchema, legacyAgentVersionV1Schema),
  })
  .strict();

export const productSnapshotV21Schema = productSnapshotSchema
  .extend({
    schemaVersion: z.literal("chat-product-store.v21"),
    entities: projectCoordinationV21EntitiesSchema,
  })
  .strict();

export type ProductSnapshotV21 = z.infer<typeof productSnapshotV21Schema>;
