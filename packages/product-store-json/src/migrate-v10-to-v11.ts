import {
  SYSTEM_SIMPLE_PLANNING_WORKFLOW_DEFINITION_ID,
  LEGACY_SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID,
  LEGACY_SYSTEM_SIMPLE_PLANNING_WORKFLOW_VIEW_ID,
  SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID,
  SYSTEM_SIMPLE_PLANNING_WORKFLOW_VIEW_ID,
  createLegacySystemSimplePlanningDefinition,
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
  const seed = createLegacySystemSimplePlanningDefinition(snapshot.committedAt);
  const forwardSeed = createSystemSimplePlanningDefinition(snapshot.committedAt);
  if (
    JSON.stringify(definitions[SYSTEM_SIMPLE_PLANNING_WORKFLOW_DEFINITION_ID]) ===
      JSON.stringify(forwardSeed.definition) &&
    JSON.stringify(revisions[SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID]) ===
      JSON.stringify(forwardSeed.revision) &&
    JSON.stringify(views[SYSTEM_SIMPLE_PLANNING_WORKFLOW_VIEW_ID]) ===
      JSON.stringify(forwardSeed.view)
  ) {
    // 旧测试/回滚流程曾把精确的当前Seed装进旧Schema；先归一回真实v11种子，
    // 避免它继续穿越版本并伪装成真实v20历史事实。
    delete definitions[SYSTEM_SIMPLE_PLANNING_WORKFLOW_DEFINITION_ID];
    delete revisions[SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID];
    delete views[SYSTEM_SIMPLE_PLANNING_WORKFLOW_VIEW_ID];
  }
  for (const [label, current, expected] of [
    ["Definition", definitions[SYSTEM_SIMPLE_PLANNING_WORKFLOW_DEFINITION_ID], seed.definition],
    ["Revision", revisions[LEGACY_SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID], seed.revision],
    ["View", views[LEGACY_SYSTEM_SIMPLE_PLANNING_WORKFLOW_VIEW_ID], seed.view],
  ] as const) {
    if (current !== undefined && JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error(`v11系统Simple Planning ${label}固定ID已被异语义对象占用`);
    }
  }
  definitions[SYSTEM_SIMPLE_PLANNING_WORKFLOW_DEFINITION_ID] = seed.definition;
  revisions[LEGACY_SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID] = seed.revision;
  views[LEGACY_SYSTEM_SIMPLE_PLANNING_WORKFLOW_VIEW_ID] = seed.view;

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
