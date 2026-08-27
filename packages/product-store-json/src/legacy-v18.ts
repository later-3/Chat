import { outboxEntrySchema } from "@chat/contracts";
import { z } from "zod";
import { productSnapshotV19Schema } from "./legacy-v19.js";

export const productSnapshotV18Schema = productSnapshotV19Schema
  .extend({
    schemaVersion: z.literal("chat-product-store.v18"),
    outbox: z.record(z.string().min(1).max(200), outboxEntrySchema),
  })
  .strict();

export type ProductSnapshotV18 = z.infer<typeof productSnapshotV18Schema>;
