import { productSnapshotSchema } from "@chat/contracts";
import { z } from "zod";

const productSnapshotV16PlaneEntitiesSchema = productSnapshotSchema.shape.entities
  .omit({
    agentVersions: true,
    memorySessionImports: true,
    memoryAgentWriteCandidates: true,
    memoryAgentWriteDecisions: true,
    memoryAgentOperations: true,
  })
  .strict();

const productSnapshotV16MainEntitiesSchema = productSnapshotV16PlaneEntitiesSchema
  .omit({
    projectBootstrapCandidates: true,
    projectBootstrapDecisions: true,
    projectBootstrapOperations: true,
    projectWorkspaceBindings: true,
  })
  .strict();

/** main曾发布的v16：包含Prompt Assembly v2，但尚无Plane初始化事实集合。 */
export const productSnapshotV16MainSchema = productSnapshotSchema
  .extend({
    schemaVersion: z.literal("chat-product-store.v16"),
    entities: productSnapshotV16MainEntitiesSchema,
  })
  .strict();

/** Plane开发分支曾发布的v16：四组初始化事实已经存在，迁移时必须完整保留。 */
export const productSnapshotV16PlaneSchema = productSnapshotSchema
  .extend({
    schemaVersion: z.literal("chat-product-store.v16"),
    entities: productSnapshotV16PlaneEntitiesSchema,
  })
  .strict();

export const productSnapshotV16Schema = z.union([
  productSnapshotV16PlaneSchema,
  productSnapshotV16MainSchema,
]);

export type ProductSnapshotV16Main = z.infer<typeof productSnapshotV16MainSchema>;
export type ProductSnapshotV16Plane = z.infer<typeof productSnapshotV16PlaneSchema>;
export type ProductSnapshotV16 = z.infer<typeof productSnapshotV16Schema>;
