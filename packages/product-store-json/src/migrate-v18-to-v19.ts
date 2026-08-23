import {
  SYSTEM_MEMORY_DIRECT_WORKFLOW_DEFINITION_ID,
  SYSTEM_MEMORY_DIRECT_WORKFLOW_REVISION_ID,
  SYSTEM_MEMORY_DIRECT_WORKFLOW_VIEW_ID,
  createSystemMemoryDirectDefinition,
} from "@chat/application/workflow-system-definitions";
import type { ProductSnapshotV18 } from "./legacy-v18.js";
import { productSnapshotV19Schema, type ProductSnapshotV19 } from "./legacy-v19.js";

/** v19只新增固定Memory Direct系统Definition，不改写任何已有Run或历史Definition。 */
export function migrateProductSnapshotV18ToV19(snapshot: ProductSnapshotV18): ProductSnapshotV19 {
  const definitions = { ...snapshot.entities.workflowDefinitions };
  const revisions = { ...snapshot.entities.workflowDefinitionRevisions };
  const views = { ...snapshot.entities.workflowViewDefinitions };
  const seed = createSystemMemoryDirectDefinition(snapshot.committedAt);
  for (const [label, current, expected] of [
    ["Definition", definitions[SYSTEM_MEMORY_DIRECT_WORKFLOW_DEFINITION_ID], seed.definition],
    ["Revision", revisions[SYSTEM_MEMORY_DIRECT_WORKFLOW_REVISION_ID], seed.revision],
    ["View", views[SYSTEM_MEMORY_DIRECT_WORKFLOW_VIEW_ID], seed.view],
  ] as const) {
    if (current !== undefined && JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error(`v19系统Memory Direct ${label}固定ID已被异语义对象占用`);
    }
  }
  definitions[SYSTEM_MEMORY_DIRECT_WORKFLOW_DEFINITION_ID] = seed.definition;
  revisions[SYSTEM_MEMORY_DIRECT_WORKFLOW_REVISION_ID] = seed.revision;
  views[SYSTEM_MEMORY_DIRECT_WORKFLOW_VIEW_ID] = seed.view;
  return productSnapshotV19Schema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v19",
    entities: {
      ...snapshot.entities,
      workflowDefinitions: definitions,
      workflowDefinitionRevisions: revisions,
      workflowViewDefinitions: views,
    },
  });
}
