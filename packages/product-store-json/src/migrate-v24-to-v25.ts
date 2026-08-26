import {
  createLegacySystemSimplePlanningDefinition,
  createSystemSimplePlanningDefinition,
  LEGACY_SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID,
  LEGACY_SYSTEM_SIMPLE_PLANNING_WORKFLOW_VIEW_ID,
  SYSTEM_SIMPLE_PLANNING_WORKFLOW_DEFINITION_ID,
  SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID,
  SYSTEM_SIMPLE_PLANNING_WORKFLOW_VIEW_ID,
} from "@chat/application/workflow-system-definitions";
import { productSnapshotV25Schema, type ProductSnapshotV25 } from "./legacy-v25.js";
import type { ProductSnapshotV24 } from "./legacy-v24.js";

/**
 * v25发布Simple Planning治理Revision。v24事实保持原ID/Hash并转为superseded；迁移只从
 * 已提交对象和固定系统种子推导，绝不读取DSH草稿、Workspace、Pi Journal或模型输出。
 */
export function migrateProductSnapshotV24ToV25(snapshot: ProductSnapshotV24): ProductSnapshotV25 {
  const migratedAt = snapshot.committedAt;
  const existingDefinition =
    snapshot.entities.workflowDefinitions[SYSTEM_SIMPLE_PLANNING_WORKFLOW_DEFINITION_ID];
  const legacyRevision =
    snapshot.entities.workflowDefinitionRevisions[
      LEGACY_SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID
    ];
  const legacyView =
    snapshot.entities.workflowViewDefinitions[LEGACY_SYSTEM_SIMPLE_PLANNING_WORKFLOW_VIEW_ID];
  const currentRevision =
    snapshot.entities.workflowDefinitionRevisions[SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID];
  const currentView =
    snapshot.entities.workflowViewDefinitions[SYSTEM_SIMPLE_PLANNING_WORKFLOW_VIEW_ID];
  if (currentRevision !== undefined || currentView !== undefined) {
    throw new Error("v24→v25的Simple Planning治理Revision目标身份发生碰撞");
  }
  if (
    existingDefinition === undefined ||
    legacyRevision === undefined ||
    legacyView === undefined
  ) {
    throw new Error("v24→v25的Simple Planning历史事实不完整");
  }
  const legacySeed = createLegacySystemSimplePlanningDefinition(existingDefinition.createdAt);
  if (
    JSON.stringify(existingDefinition) !== JSON.stringify(legacySeed.definition) ||
    JSON.stringify(legacyRevision) !== JSON.stringify(legacySeed.revision) ||
    JSON.stringify(legacyView) !== JSON.stringify(legacySeed.view)
  ) {
    throw new Error("v24→v25的Simple Planning固定历史种子语义不匹配");
  }
  const seed = createSystemSimplePlanningDefinition(migratedAt);
  return productSnapshotV25Schema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v25",
    entities: {
      ...snapshot.entities,
      workflowDefinitions: {
        ...snapshot.entities.workflowDefinitions,
        [SYSTEM_SIMPLE_PLANNING_WORKFLOW_DEFINITION_ID]: {
          ...seed.definition,
          createdAt: existingDefinition.createdAt,
          updatedAt: migratedAt,
        },
      },
      workflowDefinitionRevisions: {
        ...snapshot.entities.workflowDefinitionRevisions,
        [LEGACY_SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID]: {
          ...legacyRevision,
          state: "superseded" as const,
          supersededAt: migratedAt,
          updatedAt: migratedAt,
        },
        [SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID]: seed.revision,
      },
      workflowViewDefinitions: {
        ...snapshot.entities.workflowViewDefinitions,
        [SYSTEM_SIMPLE_PLANNING_WORKFLOW_VIEW_ID]: seed.view,
      },
    },
  });
}
