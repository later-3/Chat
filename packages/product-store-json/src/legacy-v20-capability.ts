import {
  agentVersionSchema,
  productSnapshotSchema,
  promptAssemblySchema,
  toolExecutionDecisionSchema,
  toolExecutionIntentSchema,
  toolExecutionResultSchema,
} from "@chat/contracts";
import { z } from "zod";
import { productSnapshotV19Schema } from "./legacy-v19.js";

const idKeySchema = z.string().min(1).max(200);

/**
 * 正式main曾发布的Capability Governance v20。
 *
 * 该形态与Content Production分支的同名v20不同：它拥有Tool Execution三组事实，
 * 但仍使用v19时代的Project对象且没有Content Coordination集合。两者必须严格分型，
 * 不能用字段可选化掩盖版本号碰撞。
 */
const capabilityV20EntitiesSchema = productSnapshotV19Schema.shape.entities
  .extend({
    promptAssemblies: z.record(idKeySchema, promptAssemblySchema),
    agentVersions: z.record(idKeySchema, agentVersionSchema),
    toolExecutionIntents: z.record(idKeySchema, toolExecutionIntentSchema),
    toolExecutionDecisions: z.record(idKeySchema, toolExecutionDecisionSchema),
    toolExecutionResults: z.record(idKeySchema, toolExecutionResultSchema),
  })
  .strict();

export const productSnapshotV20CapabilitySchema = productSnapshotSchema
  .extend({
    schemaVersion: z.literal("chat-product-store.v20"),
    entities: capabilityV20EntitiesSchema,
  })
  .strict();

export type ProductSnapshotV20Capability = z.infer<typeof productSnapshotV20CapabilitySchema>;
