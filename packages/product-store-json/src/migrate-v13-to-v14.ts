import { productSnapshotSchema, type ProductSnapshot } from "@chat/contracts";
import type { ProductSnapshotV13 } from "./legacy-v13.js";

/** v13→v14仅增加空Prompt Studio用户事实表；Git内置Prompt不写入Product Store。 */
export function migrateProductSnapshotV13ToV14(snapshot: ProductSnapshotV13): ProductSnapshot {
  return productSnapshotSchema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v14",
    entities: {
      ...snapshot.entities,
      promptFragments: {},
      promptFragmentRevisions: {},
    },
  });
}
