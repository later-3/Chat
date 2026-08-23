import { z } from "zod";
import { productSnapshotV19Schema } from "./legacy-v19.js";

/** v18尚未发布独立Memory Direct系统Definition；实体结构与v19相同。 */
export const productSnapshotV18Schema = productSnapshotV19Schema
  .extend({ schemaVersion: z.literal("chat-product-store.v18") })
  .strict();

export type ProductSnapshotV18 = z.infer<typeof productSnapshotV18Schema>;
