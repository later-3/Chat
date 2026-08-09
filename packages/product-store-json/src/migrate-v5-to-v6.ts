import {
  productSnapshotSchema,
  workflowViewDefinitionSchema,
  type ProductSnapshot,
} from "@chat/contracts";
import { synchronizePlanningWorkflowProjection } from "@chat/application";
import { LEGACY_PLANNING_VIEW_ID, createLegacyPlanningWorkflowView } from "@chat/domain";
import type { ProductSnapshotV5 } from "./legacy-v5.js";

/**
 * v5→v6为现有Planning Run补齐不可变Workflow View和可观察Node Run投影。
 * 回填只依据已经提交的产品事实，明确标记legacy_product_facts；它不会伪造真实的
 * step开始时间、重试次数或Vercel运行身份。
 */
export function migrateProductSnapshotV5ToV6(snapshot: ProductSnapshotV5): ProductSnapshot {
  const migrated = productSnapshotSchema.parse({
    schemaVersion: "chat-product-store.v6",
    storeRevision: snapshot.storeRevision,
    committedAt: snapshot.committedAt,
    entities: {
      ...snapshot.entities,
      runs: Object.fromEntries(
        Object.entries(snapshot.entities.runs).map(([id, run]) => [
          id,
          {
            ...run,
            schemaVersion: "product-run.v2" as const,
            workflowViewDefinitionId: LEGACY_PLANNING_VIEW_ID,
          },
        ]),
      ),
      workflowViewDefinitions:
        Object.keys(snapshot.entities.runs).length === 0
          ? {}
          : {
              [LEGACY_PLANNING_VIEW_ID]: workflowViewDefinitionSchema.parse(
                createLegacyPlanningWorkflowView(snapshot.committedAt),
              ),
            },
      workflowNodeRuns: {},
      nodeRunTransitions: {},
      nodeValueManifests: {},
    },
    commandReceipts: snapshot.commandReceipts,
    outbox: snapshot.outbox,
  });

  for (const run of Object.values(migrated.entities.runs)) {
    synchronizePlanningWorkflowProjection(
      migrated,
      run.productRunId,
      run.updatedAt,
      "legacy_product_facts",
    );
  }
  return productSnapshotSchema.parse(migrated);
}
