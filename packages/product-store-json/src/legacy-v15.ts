import { z } from "zod";
import { productSnapshotV16MainSchema } from "./legacy-v16.js";

/** v15只用于读取迁移；v16开始允许正文外置的Prompt Revision v2。 */
export const productSnapshotV15Schema = productSnapshotV16MainSchema
  .extend({ schemaVersion: z.literal("chat-product-store.v15") })
  .strict();

export type ProductSnapshotV15 = z.infer<typeof productSnapshotV15Schema>;
