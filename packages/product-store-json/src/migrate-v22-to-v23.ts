import { productSnapshotSchema, type ProductSnapshot } from "@chat/contracts";
import type { ProductSnapshotV22 } from "./legacy-v22.js";

/**
 * v23只增加全项目生命周期K1的七组空集合。
 * 旧快照没有这些事实可迁；迁移不得推断Profile、扫描资源或创建用户Commitment。
 */
export function migrateProductSnapshotV22ToV23(snapshot: ProductSnapshotV22): ProductSnapshot {
  return productSnapshotSchema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v23",
    entities: {
      ...snapshot.entities,
      projectProfileRevisions: {},
      projectConfigurationRevisions: {},
      projectEvents: {},
      projectNeeds: {},
      projectRequirements: {},
      projectArtifactRefs: {},
      projectMetricObservations: {},
    },
  });
}
