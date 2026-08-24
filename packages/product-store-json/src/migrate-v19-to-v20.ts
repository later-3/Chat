import type { ProductSnapshotV19 } from "./legacy-v19.js";
import { productSnapshotV20Schema, type ProductSnapshotV20 } from "./legacy-v20.js";

/** v20只增加Provider中立的Session Import批次集合；旧事实逐字段保持不变。 */
export function migrateProductSnapshotV19ToV20(snapshot: ProductSnapshotV19): ProductSnapshotV20 {
  return productSnapshotV20Schema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v20",
    entities: { ...snapshot.entities, memorySessionImports: {} },
  });
}
