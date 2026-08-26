import { z } from "zod";
import { productSnapshotSchema } from "./product-store-v20.js";

const productSnapshotV17EntitiesSchema = productSnapshotSchema.shape.entities
  .omit({
    agentVersions: true,
    toolExecutionIntents: true,
    toolExecutionDecisions: true,
    toolExecutionResults: true,
  })
  .strict();

export const productSnapshotV17Schema = productSnapshotSchema
  .extend({
    schemaVersion: z.literal("chat-product-store.v17"),
    entities: productSnapshotV17EntitiesSchema,
  })
  .strict();

export type ProductSnapshotV17 = z.infer<typeof productSnapshotV17Schema>;
