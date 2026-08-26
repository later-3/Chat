import {
  memoryWriteIntentSchema,
  memoryWriteResultSchema,
  workflowMemoryContextSchema,
  workflowMemoryQuerySchema,
  workflowMemorySnapshotSchema,
} from "@chat/contracts";
import { z } from "zod";
import { productSnapshotV11Schema } from "./legacy-v11.js";

const idKeySchema = z.string().min(1).max(200);

/** v12只用于读取迁移；v13才新增Direct Agent与Prompt Review事实。 */
export const productSnapshotV12Schema = productSnapshotV11Schema.extend({
  schemaVersion: z.literal("chat-product-store.v12"),
  entities: productSnapshotV11Schema.shape.entities.extend({
    workflowMemoryQueries: z.record(idKeySchema, workflowMemoryQuerySchema),
    workflowMemorySnapshots: z.record(idKeySchema, workflowMemorySnapshotSchema),
    workflowMemoryContexts: z.record(idKeySchema, workflowMemoryContextSchema),
    memoryWriteIntents: z.record(idKeySchema, memoryWriteIntentSchema),
    memoryWriteResults: z.record(idKeySchema, memoryWriteResultSchema),
  }),
});

export type ProductSnapshotV12 = z.infer<typeof productSnapshotV12Schema>;
