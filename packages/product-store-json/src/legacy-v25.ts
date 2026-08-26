import { productSnapshotSchema } from "@chat/contracts";
import { z } from "zod";

/**
 * v25是Capability/Governance当前主线发布代；Memory Agent事实尚未进入写Schema。
 * 这里是只读reader，不能借v26联合Schema把Memory Agent集合塞回历史代际。
 */
const productSnapshotV25EntitiesSchema = productSnapshotSchema.shape.entities
  .omit({
    memorySessionImports: true,
    memoryAgentOperations: true,
    memoryAgentWriteCandidates: true,
    memoryAgentWriteDecisions: true,
  })
  .strict();

export const productSnapshotV25Schema = productSnapshotSchema
  .extend({
    schemaVersion: z.literal("chat-product-store.v25"),
    entities: productSnapshotV25EntitiesSchema,
  })
  .strict();

export type ProductSnapshotV25 = z.infer<typeof productSnapshotV25Schema>;
