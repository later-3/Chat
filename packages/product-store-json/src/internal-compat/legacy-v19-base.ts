import {
  legacyAgentVersionV1Schema,
  promptAssemblyV1Schema,
  promptAssemblyV2Schema,
  promptAssemblyV3Schema,
} from "@chat/contracts";
import { z } from "zod";
import { productSnapshotSchema } from "./product-store-v20.js";

const historicalProductEntitiesV19Schema = productSnapshotSchema.shape.entities
  .omit({
    toolExecutionIntents: true,
    toolExecutionDecisions: true,
    toolExecutionResults: true,
  })
  .extend({
    promptAssemblies: z.record(
      z.string().min(1).max(200),
      z.union([promptAssemblyV1Schema, promptAssemblyV2Schema, promptAssemblyV3Schema]),
    ),
    agentVersions: z.record(z.string().min(1).max(200), legacyAgentVersionV1Schema),
  })
  .strict();

/** main已经发布的v19冻结根；只供Store历史reader，不进入当前Contracts/API。 */
export const productSnapshotV19Schema = productSnapshotSchema
  .extend({
    schemaVersion: z.literal("chat-product-store.v19"),
    entities: historicalProductEntitiesV19Schema,
  })
  .strict();

export type ProductSnapshotV19 = z.infer<typeof productSnapshotV19Schema>;
