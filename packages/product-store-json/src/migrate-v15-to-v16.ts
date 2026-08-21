import type { ProductSnapshotV15 } from "./legacy-v15.js";
import { productSnapshotV16MainSchema, type ProductSnapshotV16Main } from "./legacy-v16.js";

/**
 * v15→v16不伪造文件：旧Prompt Revision v1继续兼容读取并在首次访问时迁入MD；
 * 新命令只写v2文件引用。其余产品事实逐项保持不变。
 */
export function migrateProductSnapshotV15ToV16(
  snapshot: ProductSnapshotV15,
): ProductSnapshotV16Main {
  return productSnapshotV16MainSchema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v16",
  });
}
