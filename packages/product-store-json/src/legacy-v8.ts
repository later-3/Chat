import {
  noteCandidateSchema,
  noteDecisionSchema,
  noteRevisionSchema,
  noteSchema,
} from "@chat/contracts";
import { z } from "zod";
import { productSnapshotV7Schema } from "./legacy-v7.js";

const idKeySchema = z.string().min(1).max(200);

/** v8只用于迁移读取；新事务只能写当前v9合同。 */
export const productSnapshotV8Schema = productSnapshotV7Schema.extend({
  schemaVersion: z.literal("chat-product-store.v8"),
  entities: productSnapshotV7Schema.shape.entities.extend({
    notes: z.record(idKeySchema, noteSchema),
    noteRevisions: z.record(idKeySchema, noteRevisionSchema),
    noteCandidates: z.record(idKeySchema, noteCandidateSchema),
    noteDecisions: z.record(idKeySchema, noteDecisionSchema),
  }),
});

export type ProductSnapshotV8 = z.infer<typeof productSnapshotV8Schema>;
