import { outboxEntrySchema, productSnapshotSchema } from "@chat/contracts";
import { z } from "zod";

const productOutboxEntryV18Schema = outboxEntrySchema.refine(
  (entry) => entry.kind !== "project_bootstrap_execute",
  "v18不支持Project Bootstrap执行Outbox",
);

/** v18尚未声明Project Bootstrap后台执行Outbox kind。 */
export const productSnapshotV18Schema = productSnapshotSchema
  .extend({
    schemaVersion: z.literal("chat-product-store.v18"),
    outbox: z.record(z.string().min(1).max(200), productOutboxEntryV18Schema),
  })
  .strict();

export type ProductSnapshotV18 = z.infer<typeof productSnapshotV18Schema>;
