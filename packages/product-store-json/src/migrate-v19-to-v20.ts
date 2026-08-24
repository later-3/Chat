import { productSnapshotSchema, type ProductSnapshot } from "@chat/contracts";
import type { ProductSnapshotV19 } from "./legacy-v19.js";

/** v20只在任务02的v19事实上增加Tool Intent/Decision/Result空集合。 */
export function migrateProductSnapshotV19ToV20(snapshot: ProductSnapshotV19): ProductSnapshot {
  return productSnapshotSchema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v20",
    entities: {
      ...snapshot.entities,
      toolExecutionIntents: {},
      toolExecutionDecisions: {},
      toolExecutionResults: {},
    },
  });
}
