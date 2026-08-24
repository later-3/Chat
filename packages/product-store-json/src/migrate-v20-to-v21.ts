import {
  SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_DEFINITION_ID,
  SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_REVISION_ID,
  SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_VIEW_ID,
  SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_DEFINITION_ID,
  SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_REVISION_ID,
  SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_VIEW_ID,
  SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_DEFINITION_ID,
  SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_REVISION_ID,
  SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_VIEW_ID,
  createSystemMemoryAgentDirectDefinition,
  createSystemMemoryReadDirectDefinition,
  createSystemMemoryWriteDirectDefinition,
} from "@chat/application/workflow-system-definitions";
import { productSnapshotSchema, type ProductSnapshot } from "@chat/contracts";
import type { ProductSnapshotV20 } from "./legacy-v20.js";

/** v21增加Memory Agent审核事实与direct@3/4/5系统Definition，不改写历史Run。 */
export function migrateProductSnapshotV20ToV21(snapshot: ProductSnapshotV20): ProductSnapshot {
  const definitions = { ...snapshot.entities.workflowDefinitions };
  const revisions = { ...snapshot.entities.workflowDefinitionRevisions };
  const views = { ...snapshot.entities.workflowViewDefinitions };
  const seed = createSystemMemoryAgentDirectDefinition(snapshot.committedAt);
  const readSeed = createSystemMemoryReadDirectDefinition(snapshot.committedAt);
  const writeSeed = createSystemMemoryWriteDirectDefinition(snapshot.committedAt);
  for (const [label, current, expected] of [
    ["Definition", definitions[SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_DEFINITION_ID], seed.definition],
    ["Revision", revisions[SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_REVISION_ID], seed.revision],
    ["View", views[SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_VIEW_ID], seed.view],
    [
      "Read Definition",
      definitions[SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_DEFINITION_ID],
      readSeed.definition,
    ],
    ["Read Revision", revisions[SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_REVISION_ID], readSeed.revision],
    ["Read View", views[SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_VIEW_ID], readSeed.view],
    [
      "Write Definition",
      definitions[SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_DEFINITION_ID],
      writeSeed.definition,
    ],
    [
      "Write Revision",
      revisions[SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_REVISION_ID],
      writeSeed.revision,
    ],
    ["Write View", views[SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_VIEW_ID], writeSeed.view],
  ] as const) {
    if (current !== undefined && JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error(`v21系统Memory Agent Direct ${label}固定ID已被异语义对象占用`);
    }
  }
  definitions[SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_DEFINITION_ID] = seed.definition;
  revisions[SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_REVISION_ID] = seed.revision;
  views[SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_VIEW_ID] = seed.view;
  definitions[SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_DEFINITION_ID] = readSeed.definition;
  revisions[SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_REVISION_ID] = readSeed.revision;
  views[SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_VIEW_ID] = readSeed.view;
  definitions[SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_DEFINITION_ID] = writeSeed.definition;
  revisions[SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_REVISION_ID] = writeSeed.revision;
  views[SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_VIEW_ID] = writeSeed.view;
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
