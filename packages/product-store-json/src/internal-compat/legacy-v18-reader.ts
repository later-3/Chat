import {
  legacyAgentVersionV1Schema,
  outboxEntrySchema,
  promptAssemblyV1Schema,
  promptAssemblyV2Schema,
  promptAssemblyV3Schema,
} from "@chat/contracts";
import { z } from "zod";
import { productSnapshotSchema } from "./product-store-v20.js";

const historicalProductEntitiesV18Schema = productSnapshotSchema.shape.entities
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
  .strip();

export const productSnapshotV18Schema = productSnapshotSchema
  .extend({
    schemaVersion: z.literal("chat-product-store.v18"),
    entities: historicalProductEntitiesV18Schema,
    outbox: z.record(z.string().min(1).max(200), outboxEntrySchema),
  })
  .strict();

export type ProductSnapshotV18 = z.infer<typeof productSnapshotV18Schema>;
