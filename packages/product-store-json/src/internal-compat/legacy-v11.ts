import { z } from "zod";
import { productSnapshotV10Schema } from "./legacy-v10.js";

/** v11只新增Simple Planning系统Definition，实体集合形状仍与v10相同。 */
export const productSnapshotV11Schema = productSnapshotV10Schema.extend({
  schemaVersion: z.literal("chat-product-store.v11"),
});

export type ProductSnapshotV11 = z.infer<typeof productSnapshotV11Schema>;
