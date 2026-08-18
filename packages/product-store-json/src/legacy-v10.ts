import { productSnapshotSchema } from "@chat/contracts";
import { z } from "zod";

/** v10只用于迁移读取；实体集合与v11相同，差异是系统Planning发布修订。 */
export const productSnapshotV10Schema = productSnapshotSchema.extend({
  schemaVersion: z.literal("chat-product-store.v10"),
});

export type ProductSnapshotV10 = z.infer<typeof productSnapshotV10Schema>;
