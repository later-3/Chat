import {
  SYSTEM_MEMORY_PLANNING_WORKFLOW_DEFINITION_ID,
  SYSTEM_MEMORY_PLANNING_WORKFLOW_REVISION_ID,
  SYSTEM_MEMORY_PLANNING_WORKFLOW_VIEW_ID,
  createSystemMemoryPlanningDefinition,
} from "@chat/application/workflow-system-definitions";
import type { ProductSnapshotV11 } from "./legacy-v11.js";
import { productSnapshotV12Schema, type ProductSnapshotV12 } from "./legacy-v12.js";

/**
 * v11→v12新增Provider中立Workflow Memory事实和独立Memory Planning Definition。
 * v11已经发布的Simple Planning以及历史context.memory Definition全部原样保留。
 */
export function migrateProductSnapshotV11ToV12(snapshot: ProductSnapshotV11): ProductSnapshotV12 {
  const definitions = { ...snapshot.entities.workflowDefinitions };
  const revisions = { ...snapshot.entities.workflowDefinitionRevisions };
  const views = { ...snapshot.entities.workflowViewDefinitions };
  const seed = createSystemMemoryPlanningDefinition(snapshot.committedAt);
  for (const [label, current, expected] of [
    ["Definition", definitions[SYSTEM_MEMORY_PLANNING_WORKFLOW_DEFINITION_ID], seed.definition],
    ["Revision", revisions[SYSTEM_MEMORY_PLANNING_WORKFLOW_REVISION_ID], seed.revision],
    ["View", views[SYSTEM_MEMORY_PLANNING_WORKFLOW_VIEW_ID], seed.view],
  ] as const) {
    if (current !== undefined && JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error(`v12系统Memory Planning ${label}固定ID已被异语义对象占用`);
    }
  }
  definitions[SYSTEM_MEMORY_PLANNING_WORKFLOW_DEFINITION_ID] = seed.definition;
  revisions[SYSTEM_MEMORY_PLANNING_WORKFLOW_REVISION_ID] = seed.revision;
  views[SYSTEM_MEMORY_PLANNING_WORKFLOW_VIEW_ID] = seed.view;

  return productSnapshotV12Schema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v12",
    entities: {
      ...snapshot.entities,
      workflowDefinitions: definitions,
      workflowDefinitionRevisions: revisions,
      workflowViewDefinitions: views,
      workflowMemoryQueries: {},
      workflowMemorySnapshots: {},
      workflowMemoryContexts: {},
      memoryWriteIntents: {},
      memoryWriteResults: {},
    },
  });
}
