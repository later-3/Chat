import { promptFragmentRevisionSchema, promptFragmentSchema } from "@chat/contracts";
import { z } from "zod";
import { productSnapshotV13Schema } from "./legacy-v13.js";

const idKeySchema = z.string().min(1).max(200);

/** v14只用于读取迁移；当时Prompt Fragment尚无全局/Workspace Scope。 */
export const productSnapshotV14Schema = productSnapshotV13Schema.extend({
  schemaVersion: z.literal("chat-product-store.v14"),
  entities: productSnapshotV13Schema.shape.entities.extend({
    promptFragments: z.record(idKeySchema, promptFragmentSchema.omit({ scope: true })),
    promptFragmentRevisions: z.record(idKeySchema, promptFragmentRevisionSchema),
  }),
});

export type ProductSnapshotV14 = z.infer<typeof productSnapshotV14Schema>;
