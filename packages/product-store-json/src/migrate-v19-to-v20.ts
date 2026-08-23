import { productSnapshotSchema, type ProductSnapshot } from "@chat/contracts";
import type { ProductSnapshotV19 } from "./legacy-v19.js";

/** v20只增加Provider中立的Session Import批次集合；旧事实逐字段保持不变。 */
export function migrateProductSnapshotV19ToV20(snapshot: ProductSnapshotV19): ProductSnapshot {
  return productSnapshotSchema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v20",
    entities: { ...snapshot.entities, memorySessionImports: {} },
  });
}
