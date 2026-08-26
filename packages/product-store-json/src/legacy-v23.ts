import {
  productSnapshotSchema,
  promptAssemblyV1Schema,
  promptAssemblyV2Schema,
  promptAssemblyV3Schema,
  promptAssemblyV4Schema,
} from "@chat/contracts";
import { z } from "zod";

/**
 * 真实发布的v23完整形状：包含Project K2与Capability治理事实，但尚无监督执行集合。
 * 该reader严格拒绝带v24集合的同名文件，避免未发布的donor格式冒充历史事实。
 */
const idKeySchema = z.string().min(1).max(200);

const productSnapshotV23EntitiesSchema = productSnapshotSchema.shape.entities
  .omit({
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
      z.union([
        promptAssemblyV1Schema,
        promptAssemblyV2Schema,
        promptAssemblyV3Schema,
        promptAssemblyV4Schema,
      ]),
    ),
  })
  .strict();

export const productSnapshotV23Schema = productSnapshotSchema
  .extend({
    schemaVersion: z.literal("chat-product-store.v23"),
    entities: productSnapshotV23EntitiesSchema,
  })
  .strict();

export type ProductSnapshotV23 = z.infer<typeof productSnapshotV23Schema>;
