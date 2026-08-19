import {
  directAgentCandidateSchema,
  promptReviewDecisionSchema,
  promptReviewRequestSchema,
} from "@chat/contracts";
import { z } from "zod";
import { productSnapshotV12Schema } from "./legacy-v12.js";

const idKeySchema = z.string().min(1).max(200);

/** v13只用于读取迁移；v14才新增Prompt Studio用户资产。 */
export const productSnapshotV13Schema = productSnapshotV12Schema.extend({
  schemaVersion: z.literal("chat-product-store.v13"),
  entities: productSnapshotV12Schema.shape.entities.extend({
    directAgentCandidates: z.record(idKeySchema, directAgentCandidateSchema),
    promptReviewRequests: z.record(idKeySchema, promptReviewRequestSchema),
    promptReviewDecisions: z.record(idKeySchema, promptReviewDecisionSchema),
  }),
});

export type ProductSnapshotV13 = z.infer<typeof productSnapshotV13Schema>;
