import { z } from "zod";
import { productSnapshotSchema } from "./product-store-v20.js";

const productSnapshotV16PlaneEntitiesSchema = productSnapshotSchema.shape.entities
  .omit({
    agentVersions: true,
    toolExecutionIntents: true,
    toolExecutionDecisions: true,
    toolExecutionResults: true,
  })
  .strict();

const productSnapshotV16MainEntitiesSchema = productSnapshotV16PlaneEntitiesSchema
  .omit({
    projectBootstrapCandidates: true,
    projectBootstrapDecisions: true,
    projectBootstrapOperations: true,
    projectWorkspaceBindings: true,
  })
  .strict();

export const productSnapshotV16MainSchema = productSnapshotSchema
  .extend({
    schemaVersion: z.literal("chat-product-store.v16"),
    entities: productSnapshotV16MainEntitiesSchema,
  })
  .strict();

export const productSnapshotV16PlaneSchema = productSnapshotSchema
  .extend({
    schemaVersion: z.literal("chat-product-store.v16"),
    entities: productSnapshotV16PlaneEntitiesSchema,
  })
  .strict();

export const productSnapshotV16Schema = z.union([
  productSnapshotV16PlaneSchema,
  productSnapshotV16MainSchema,
]);

export type ProductSnapshotV16Main = z.infer<typeof productSnapshotV16MainSchema>;
export type ProductSnapshotV16 = z.infer<typeof productSnapshotV16Schema>;
