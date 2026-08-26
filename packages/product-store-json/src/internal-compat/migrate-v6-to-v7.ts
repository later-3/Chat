import type { ProductSnapshotV6 } from "./legacy-v6.js";
import { productSnapshotV7Schema, type ProductSnapshotV7 } from "./legacy-v7.js";
import {
  V7_LEGACY_PLANNING_RUNNER_BUNDLE_VERSION,
  V7_LEGACY_PLANNING_RUNNER_FAMILY,
  V7_SYSTEM_PLANNING_WORKFLOW_DEFINITION_ID,
  V7_SYSTEM_PLANNING_WORKFLOW_REVISION_ID,
  V7_SYSTEM_PLANNING_WORKFLOW_VIEW_ID,
  createV7SystemPlanningSeed,
} from "../v7-system-planning-seed.js";

/**
 * v6→v7把S3 Definition Kernel正式化为产品事实。
 * 旧Run全部迁移为planning legacy分支：保留原View和状态，不反向伪造RunSpec；
 * 同时用稳定ID种下system Planning Definition/Published Revision/View。
 */
export function migrateProductSnapshotV6ToV7(snapshot: ProductSnapshotV6): ProductSnapshotV7 {
  const seed = createV7SystemPlanningSeed(snapshot.committedAt);
  const migrated = productSnapshotV7Schema.parse({
    schemaVersion: "chat-product-store.v7",
    storeRevision: snapshot.storeRevision,
    committedAt: snapshot.committedAt,
    entities: {
      ...snapshot.entities,
      runs: Object.fromEntries(
        Object.entries(snapshot.entities.runs).map(([id, run]) => [
          id,
          {
            ...run,
            schemaVersion: "product-run.v3" as const,
            runKind: "planning" as const,
            runnerFamily: V7_LEGACY_PLANNING_RUNNER_FAMILY,
            runnerBundleVersion: V7_LEGACY_PLANNING_RUNNER_BUNDLE_VERSION,
          },
        ]),
      ),
      workflowDefinitions: {
        [V7_SYSTEM_PLANNING_WORKFLOW_DEFINITION_ID]: seed.definition,
      },
      workflowDefinitionRevisions: {
        [V7_SYSTEM_PLANNING_WORKFLOW_REVISION_ID]: seed.revision,
      },
      workflowRunSpecs: {},
      workflowViewDefinitions: {
        ...(snapshot.entities["workflowViewDefinitions"] as Record<string, unknown> | undefined),
        [V7_SYSTEM_PLANNING_WORKFLOW_VIEW_ID]: seed.view,
      },
    },
    commandReceipts: snapshot.commandReceipts,
    outbox: Object.fromEntries(
      Object.entries(snapshot.outbox).map(([id, entry]) => [
        id,
        entry.kind === "workflow_start" || entry.kind === "workflow_resume"
          ? {
              ...entry,
              runnerFamily: V7_LEGACY_PLANNING_RUNNER_FAMILY,
              runnerBundleVersion: V7_LEGACY_PLANNING_RUNNER_BUNDLE_VERSION,
            }
          : entry,
      ]),
    ),
  });
  return productSnapshotV7Schema.parse(migrated);
}
