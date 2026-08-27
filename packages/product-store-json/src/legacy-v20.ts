import {
  legacyAgentVersionV1Schema,
  productSnapshotSchema,
  promptAssemblyV1Schema,
  promptAssemblyV2Schema,
  promptAssemblyV3Schema,
} from "@chat/contracts";
import { z } from "zod";

const idKeySchema = z.string().min(1).max(200);

/** v20历史Reader只提取继续存在的主事实，已退出的扩展集合由备份分支保留。 */
const entitiesV20Schema = productSnapshotSchema.shape.entities
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
  })
  .strip();

export const productSnapshotV20Schema = productSnapshotSchema
  .extend({
    schemaVersion: z.literal("chat-product-store.v20"),
    entities: entitiesV20Schema,
  })
  .strict();

export type ProductSnapshotV20 = z.infer<typeof productSnapshotV20Schema>;
