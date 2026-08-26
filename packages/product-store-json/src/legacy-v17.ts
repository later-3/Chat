import { z } from "zod";
import { productSnapshotV19Schema } from "./legacy-v19.js";

/** v17尚未持久化Principal派生的不可变Agent Version。 */
const productSnapshotV17EntitiesSchema = productSnapshotV19Schema.shape.entities
  .omit({ agentVersions: true })
  .strict();

export const productSnapshotV17Schema = productSnapshotV19Schema
  .extend({
    schemaVersion: z.literal("chat-product-store.v17"),
    entities: productSnapshotV17EntitiesSchema,
  })
  .strict();

export type ProductSnapshotV17 = z.infer<typeof productSnapshotV17Schema>;
