import {
  SYSTEM_SIMPLE_PLANNING_WORKFLOW_DEFINITION_ID,
  SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID,
  SYSTEM_SIMPLE_PLANNING_WORKFLOW_VIEW_ID,
  createSystemSimplePlanningDefinition,
} from "@chat/application/workflow-system-definitions";
import type { ProductSnapshotV10 } from "./legacy-v10.js";
import { productSnapshotV11Schema, type ProductSnapshotV11 } from "./legacy-v11.js";

/**
 * v10→v11新增独立的“规划执行工作流”，不修改带完整上下文能力的system.planning。
 * 旧RunSpec与Memory事实全部原样保留；新默认只是不再选择完整上下文Workflow。
 */
export function migrateProductSnapshotV10ToV11(snapshot: ProductSnapshotV10): ProductSnapshotV11 {
  const definitions = { ...snapshot.entities.workflowDefinitions };
  const revisions = { ...snapshot.entities.workflowDefinitionRevisions };
  const views = { ...snapshot.entities.workflowViewDefinitions };
  const seed = createSystemSimplePlanningDefinition(snapshot.committedAt);
  for (const [label, current, expected] of [
    ["Definition", definitions[SYSTEM_SIMPLE_PLANNING_WORKFLOW_DEFINITION_ID], seed.definition],
    ["Revision", revisions[SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID], seed.revision],
    ["View", views[SYSTEM_SIMPLE_PLANNING_WORKFLOW_VIEW_ID], seed.view],
  ] as const) {
    if (current !== undefined && JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error(`v11系统Simple Planning ${label}固定ID已被异语义对象占用`);
    }
  }
  definitions[SYSTEM_SIMPLE_PLANNING_WORKFLOW_DEFINITION_ID] = seed.definition;
  revisions[SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID] = seed.revision;
  views[SYSTEM_SIMPLE_PLANNING_WORKFLOW_VIEW_ID] = seed.view;

  return productSnapshotV11Schema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v11",
    entities: {
      ...snapshot.entities,
      workflowDefinitions: definitions,
      workflowDefinitionRevisions: revisions,
      workflowViewDefinitions: views,
    },
  });
}
