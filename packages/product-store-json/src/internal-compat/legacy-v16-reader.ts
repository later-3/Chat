import { z } from "zod";
import { productSnapshotSchema } from "./product-store-v20.js";

const productSnapshotV16EntitiesSchema = productSnapshotSchema.shape.entities
  .omit({
    agentVersions: true,
    toolExecutionIntents: true,
    toolExecutionDecisions: true,
    toolExecutionResults: true,
  })
  .strip();

export const productSnapshotV16MainSchema = productSnapshotSchema
  .extend({
    schemaVersion: z.literal("chat-product-store.v16"),
    entities: productSnapshotV16EntitiesSchema,
  })
  .strict();

export const productSnapshotV16Schema = productSnapshotV16MainSchema;

export type ProductSnapshotV16Main = z.infer<typeof productSnapshotV16MainSchema>;
export type ProductSnapshotV16 = z.infer<typeof productSnapshotV16Schema>;
