import { productSnapshotSchema } from "@chat/contracts";
import { z } from "zod";

/** v19尚无Session Import与Memory Agent实体；其他事实合同保持一致。 */
export const productSnapshotV19Schema = productSnapshotSchema
  .extend({
    schemaVersion: z.literal("chat-product-store.v19"),
    entities: productSnapshotSchema.shape.entities
      .omit({
        memorySessionImports: true,
        memoryAgentWriteCandidates: true,
        memoryAgentWriteDecisions: true,
        memoryAgentOperations: true,
      })
      .strict(),
  })
  .strict();

export type ProductSnapshotV19 = z.infer<typeof productSnapshotV19Schema>;
