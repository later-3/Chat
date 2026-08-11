import type { ProductSnapshotV8 } from "./legacy-v8.js";
import { productSnapshotV9Schema, type ProductSnapshotV9 } from "./legacy-v9.js";

/**
 * v8→v9只增加规则事实与Planning Project Context集合；历史Message、Project或Trace
 * 不能推断出用户规则或运行上下文，因此迁移必须保持这些集合为空。
 */
export function migrateProductSnapshotV8ToV9(snapshot: ProductSnapshotV8): ProductSnapshotV9 {
  return productSnapshotV9Schema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v9",
    entities: {
      ...snapshot.entities,
      rules: {},
      ruleRevisions: {},
      ruleTags: {},
      ruleDecisions: {},
      ruleSelections: {},
      planningProjectContexts: {},
    },
  });
}
