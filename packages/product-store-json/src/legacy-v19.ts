import { productSnapshotSchema } from "@chat/contracts";
import {
  legacyAgentVersionV1Schema,
  promptAssemblyV1Schema,
  promptAssemblyV2Schema,
  promptAssemblyV3Schema,
} from "@chat/contracts";
import { z } from "zod";

const historicalProductEntitiesV19Schema = productSnapshotSchema.shape.entities
  .omit({
    toolExecutionIntents: true,
    toolExecutionDecisions: true,
    toolExecutionResults: true,
  })
  .extend({
    promptAssemblies: z.record(
      z.string().min(1).max(200),
      z.union([promptAssemblyV1Schema, promptAssemblyV2Schema, promptAssemblyV3Schema]),
    ),
    agentVersions: z.record(z.string().min(1).max(200), legacyAgentVersionV1Schema),
  })
  .strict();

/**
 * 任务02已经真实定义的v19：在v18之上只增加Project Bootstrap Outbox语义，
 * 尚不存在通用ToolExecution三张事实集合。严格省略这三个键，避免把donor私有v19
 * 与已落盘v19解释成同一个Schema。
 */
export const productSnapshotV19Schema = productSnapshotSchema
  .extend({
    schemaVersion: z.literal("chat-product-store.v19"),
    entities: historicalProductEntitiesV19Schema,
  })
  .strict();

export type ProductSnapshotV19 = z.infer<typeof productSnapshotV19Schema>;
