import { productSnapshotSchema } from "@chat/contracts";
import { z } from "zod";

/** v15只用于读取迁移；v16开始允许正文外置的Prompt Revision v2。 */
export const productSnapshotV15Schema = productSnapshotSchema.extend({
  schemaVersion: z.literal("chat-product-store.v15"),
});

export type ProductSnapshotV15 = z.infer<typeof productSnapshotV15Schema>;
