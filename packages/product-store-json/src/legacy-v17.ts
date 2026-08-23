import { productSnapshotSchema } from "@chat/contracts";
import { z } from "zod";

/** v17尚未持久化Principal派生的不可变Agent Version。 */
const productSnapshotV17EntitiesSchema = productSnapshotSchema.shape.entities
  .omit({ agentVersions: true, memorySessionImports: true })
  .strict();

export const productSnapshotV17Schema = productSnapshotSchema
  .extend({
    schemaVersion: z.literal("chat-product-store.v17"),
    entities: productSnapshotV17EntitiesSchema,
  })
  .strict();

export type ProductSnapshotV17 = z.infer<typeof productSnapshotV17Schema>;
