import { productSnapshotSchema, type ProductSnapshot } from "@chat/contracts";
import type { ProductSnapshotV16 } from "./legacy-v16.js";

/**
 * 两条历史分支都曾写出v16。main形态补齐空集合；Plane形态逐对象保留初始化事实。
 * strict legacy union会拒绝只含部分集合的损坏快照，避免Zod静默strip造成数据丢失。
 */
export function migrateProductSnapshotV16ToV17(snapshot: ProductSnapshotV16): ProductSnapshot {
  const hasBootstrapFacts = "projectBootstrapCandidates" in snapshot.entities;
  return productSnapshotSchema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v17",
    entities: hasBootstrapFacts
      ? snapshot.entities
      : {
          ...snapshot.entities,
          projectBootstrapCandidates: {},
          projectBootstrapDecisions: {},
          projectBootstrapOperations: {},
          projectWorkspaceBindings: {},
        },
  });
}
