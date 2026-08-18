import { planningMemorySelectionSchema, workflowPolicyResolutionSchema } from "@chat/contracts";
import { z } from "zod";
import { productSnapshotV9Schema } from "./legacy-v9.js";

const idKeySchema = z.string().min(1).max(200);

/** v10只用于迁移读取；v11开始发布Simple Planning，v12才新增Workflow Memory集合。 */
export const productSnapshotV10Schema = productSnapshotV9Schema.extend({
  schemaVersion: z.literal("chat-product-store.v10"),
  entities: productSnapshotV9Schema.shape.entities.extend({
    planningMemorySelections: z.record(idKeySchema, planningMemorySelectionSchema),
    workflowPolicyResolutions: z.record(idKeySchema, workflowPolicyResolutionSchema),
  }),
});

export type ProductSnapshotV10 = z.infer<typeof productSnapshotV10Schema>;
