import { productSnapshotSchema } from "@chat/contracts";
import { z } from "zod";

/** v20已有Session Import，但尚无Memory Agent候选/决定及direct@3系统Definition。 */
export const productSnapshotV20Schema = productSnapshotSchema
  .extend({
    schemaVersion: z.literal("chat-product-store.v20"),
    entities: productSnapshotSchema.shape.entities
      .omit({
        memoryAgentWriteCandidates: true,
        memoryAgentWriteDecisions: true,
        memoryAgentOperations: true,
      })
      .strict(),
  })
  .strict();

export type ProductSnapshotV20 = z.infer<typeof productSnapshotV20Schema>;
