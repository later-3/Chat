import { z } from "zod";
import { productSnapshotV19Schema } from "./legacy-v19.js";

const productSnapshotV16EntitiesSchema = productSnapshotV19Schema.shape.entities
  .omit({ agentVersions: true })
  .strip();

/** v16历史Reader只提取当时代际的主事实，忽略已退出产品的扩展集合。 */
export const productSnapshotV16MainSchema = productSnapshotV19Schema
  .extend({
    schemaVersion: z.literal("chat-product-store.v16"),
    entities: productSnapshotV16EntitiesSchema,
  })
  .strict();

export const productSnapshotV16Schema = productSnapshotV16MainSchema;

export type ProductSnapshotV16Main = z.infer<typeof productSnapshotV16MainSchema>;
export type ProductSnapshotV16 = z.infer<typeof productSnapshotV16Schema>;
