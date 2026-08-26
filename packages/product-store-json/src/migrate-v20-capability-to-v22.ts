import { productSnapshotV19Schema } from "./legacy-v19.js";
import type { ProductSnapshotV20Capability } from "./legacy-v20-capability.js";
import { productSnapshotV22Schema, type ProductSnapshotV22 } from "./legacy-v22.js";
import { migrateProductSnapshotV19ToV20 } from "./migrate-v19-to-v20.js";
import { migrateProductSnapshotV20ToV21 } from "./migrate-v20-to-v21.js";
import { migrateProductSnapshotV21ToV22 } from "./migrate-v21-to-v22.js";

/**
 * 将正式main的Capability v20汇入v22。
 *
 * 先把旧Project部分按P8已经验证的v19→v20→v21链升级，再逐字保留原来的
 * Tool Intent/Decision/Result集合。整个过程只转换内存中的本地快照；不会调用Plane、Git或文件Resource。
 */
export function migrateProductSnapshotV20CapabilityToV22(
  snapshot: ProductSnapshotV20Capability,
): ProductSnapshotV22 {
  const {
    toolExecutionIntents,
    toolExecutionDecisions,
    toolExecutionResults,
    promptAssemblies,
    agentVersions,
    ...projectEntities
  } = snapshot.entities;

  // Capability v20允许Prompt Assembly v4和Agent Version v2；P8旧迁移链只负责
  // Project对象升级，因此暂时用空集合通过历史Schema，最终逐字恢复这两组事实。
  const projectV19 = productSnapshotV19Schema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v19",
    entities: {
      ...projectEntities,
      promptAssemblies: {},
      agentVersions: {},
    },
  });
  const projectV22 = migrateProductSnapshotV21ToV22(
    migrateProductSnapshotV20ToV21(migrateProductSnapshotV19ToV20(projectV19)),
  );

  return productSnapshotV22Schema.parse({
    ...projectV22,
    entities: {
      ...projectV22.entities,
      promptAssemblies,
      agentVersions,
      toolExecutionIntents,
      toolExecutionDecisions,
      toolExecutionResults,
    },
  });
}
