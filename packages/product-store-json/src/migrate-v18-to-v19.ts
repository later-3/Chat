import type { ProductSnapshotV18 } from "./legacy-v18.js";
import { productSnapshotV19Schema, type ProductSnapshotV19 } from "./legacy-v19.js";

/**
 * v19允许新确认在事务内写入Project Bootstrap执行Outbox。历史Operation与Receipt保持
 * 原样：已经ready的对象不重放，旧queued对象只在用户显式retry后创建对账Outbox。
 */
export function migrateProductSnapshotV18ToV19(snapshot: ProductSnapshotV18): ProductSnapshotV19 {
  return productSnapshotV19Schema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v19",
  });
}
