import type { ProductSnapshotV20 } from "./legacy-v20.js";
import { productSnapshotV21Schema, type ProductSnapshotV21 } from "./legacy-v21.js";

export function migrateProductSnapshotV20ToV21(snapshot: ProductSnapshotV20): ProductSnapshotV21 {
  return productSnapshotV21Schema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v21",
    entities: snapshot.entities,
  });
}
