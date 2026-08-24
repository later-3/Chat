import {
  legacyAgentVersionV1Schema,
  outboxEntrySchema,
  productSnapshotSchema,
  promptAssemblyV1Schema,
  promptAssemblyV2Schema,
  promptAssemblyV3Schema,
} from "@chat/contracts";
import { z } from "zod";

const productOutboxEntryV18Schema = outboxEntrySchema.refine(
  (entry) => entry.kind !== "project_bootstrap_execute",
  "v18不支持Project Bootstrap执行Outbox",
);

const historicalProductEntitiesV18Schema = productSnapshotSchema.shape.entities
  .omit({
    toolExecutionIntents: true,
    toolExecutionDecisions: true,
    toolExecutionResults: true,
  })
  .extend({
    /** v18/v19只能按当时已发布代际解释，不能借当前union反向改写历史语义。 */
    promptAssemblies: z.record(
      z.string().min(1).max(200),
      z.union([promptAssemblyV1Schema, promptAssemblyV2Schema, promptAssemblyV3Schema]),
    ),
    agentVersions: z.record(z.string().min(1).max(200), legacyAgentVersionV1Schema),
  })
  .strict();

/** v18尚未声明Project Bootstrap后台执行Outbox kind。 */
export const productSnapshotV18Schema = productSnapshotSchema
  .extend({
    schemaVersion: z.literal("chat-product-store.v18"),
    entities: historicalProductEntitiesV18Schema,
    outbox: z.record(z.string().min(1).max(200), productOutboxEntryV18Schema),
  })
  .strict();

export type ProductSnapshotV18 = z.infer<typeof productSnapshotV18Schema>;
