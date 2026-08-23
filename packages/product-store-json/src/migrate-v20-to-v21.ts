import {
  SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_DEFINITION_ID,
  SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_REVISION_ID,
  SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_VIEW_ID,
  createSystemMemoryAgentDirectDefinition,
} from "@chat/application/workflow-system-definitions";
import { productSnapshotSchema, type ProductSnapshot } from "@chat/contracts";
import type { ProductSnapshotV20 } from "./legacy-v20.js";

/** v21增加Memory Agent审核事实与独立direct@3系统Definition，不改写历史Run。 */
export function migrateProductSnapshotV20ToV21(snapshot: ProductSnapshotV20): ProductSnapshot {
  const definitions = { ...snapshot.entities.workflowDefinitions };
  const revisions = { ...snapshot.entities.workflowDefinitionRevisions };
  const views = { ...snapshot.entities.workflowViewDefinitions };
  const seed = createSystemMemoryAgentDirectDefinition(snapshot.committedAt);
  for (const [label, current, expected] of [
    ["Definition", definitions[SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_DEFINITION_ID], seed.definition],
    ["Revision", revisions[SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_REVISION_ID], seed.revision],
    ["View", views[SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_VIEW_ID], seed.view],
  ] as const) {
    if (current !== undefined && JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error(`v21系统Memory Agent Direct ${label}固定ID已被异语义对象占用`);
    }
  }
  definitions[SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_DEFINITION_ID] = seed.definition;
  revisions[SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_REVISION_ID] = seed.revision;
  views[SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_VIEW_ID] = seed.view;
  return productSnapshotSchema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v21",
    entities: {
      ...snapshot.entities,
      memoryAgentWriteCandidates: {},
      memoryAgentWriteDecisions: {},
      memoryAgentOperations: {},
      workflowDefinitions: definitions,
      workflowDefinitionRevisions: revisions,
      workflowViewDefinitions: views,
    },
  });
}
