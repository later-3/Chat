import {
  productSnapshotSchema,
  type ProductSnapshot,
  type ProductSnapshotV15,
} from "@chat/contracts";

/** v15→v16只增加Plane CE项目初始化事实集合；历史对象逐字段保持不变。 */
export function migrateProductSnapshotV15ToV16(snapshot: ProductSnapshotV15): ProductSnapshot {
  return productSnapshotSchema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v16",
    entities: {
      ...snapshot.entities,
      projectBootstrapCandidates: {},
      projectBootstrapDecisions: {},
      projectBootstrapOperations: {},
      projectWorkspaceBindings: {},
    },
  });
}
