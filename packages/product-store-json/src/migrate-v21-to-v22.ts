import type { ProductSnapshotV21 } from "./legacy-v21.js";
import { productSnapshotV22Schema, type ProductSnapshotV22 } from "./legacy-v22.js";

/**
 * v22汇合Project Coordination与Capability Governance两条Store谱系。
 * P8 v21没有Tool Execution事实，迁移只增加三个空集合，不访问任何Provider。
 */
export function migrateProductSnapshotV21ToV22(snapshot: ProductSnapshotV21): ProductSnapshotV22 {
  return productSnapshotV22Schema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v22",
    entities: {
      ...snapshot.entities,
      toolExecutionIntents: {},
      toolExecutionDecisions: {},
      toolExecutionResults: {},
    },
  });
}
