import {
  ruleDecisionSchema,
  ruleRevisionSchema,
  ruleSchema,
  ruleSelectionSchema,
  ruleTagSchema,
} from "@chat/contracts";
import { planningProjectContextSchema } from "./index.js";
import { z } from "zod";
import { productSnapshotV8Schema } from "./legacy-v8.js";

const idKeySchema = z.string().min(1).max(200);

/** v9只用于迁移读取；新事务只能写当前v10合同。 */
export const productSnapshotV9Schema = productSnapshotV8Schema.extend({
  schemaVersion: z.literal("chat-product-store.v9"),
  entities: productSnapshotV8Schema.shape.entities.extend({
    rules: z.record(idKeySchema, ruleSchema),
    ruleRevisions: z.record(idKeySchema, ruleRevisionSchema),
    ruleTags: z.record(idKeySchema, ruleTagSchema),
    ruleDecisions: z.record(idKeySchema, ruleDecisionSchema),
    ruleSelections: z.record(idKeySchema, ruleSelectionSchema),
    planningProjectContexts: z.record(idKeySchema, planningProjectContextSchema),
  }),
});

export type ProductSnapshotV9 = z.infer<typeof productSnapshotV9Schema>;
