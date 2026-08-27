import type { ProductSnapshotV16 } from "./legacy-v16.js";
import { productSnapshotV17Schema, type ProductSnapshotV17 } from "./legacy-v17.js";

export function migrateProductSnapshotV16ToV17(snapshot: ProductSnapshotV16): ProductSnapshotV17 {
  return productSnapshotV17Schema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v17",
    entities: snapshot.entities,
  });
}
