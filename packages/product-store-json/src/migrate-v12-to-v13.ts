import { productSnapshotSchema, type ProductSnapshot } from "@chat/contracts";
import {
  SYSTEM_DIRECT_AGENT_WORKFLOW_DEFINITION_ID,
  SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID,
  SYSTEM_DIRECT_AGENT_WORKFLOW_VIEW_ID,
  createSystemDirectAgentDefinition,
} from "@chat/application/workflow-system-definitions";
import type { ProductSnapshotV12 } from "./legacy-v12.js";

/**
 * v12→v13新增Direct Agent候选、Prompt Review事实与固定Direct系统Definition。
 * 旧Run及所有历史事实原样保留；迁移不伪造审核、Decision、Candidate或运行终态。
 */
export function migrateProductSnapshotV12ToV13(snapshot: ProductSnapshotV12): ProductSnapshot {
  const definitions = { ...snapshot.entities.workflowDefinitions };
  const revisions = { ...snapshot.entities.workflowDefinitionRevisions };
  const views = { ...snapshot.entities.workflowViewDefinitions };
  const seed = createSystemDirectAgentDefinition(snapshot.committedAt);
  for (const [label, current, expected] of [
    ["Definition", definitions[SYSTEM_DIRECT_AGENT_WORKFLOW_DEFINITION_ID], seed.definition],
    ["Revision", revisions[SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID], seed.revision],
    ["View", views[SYSTEM_DIRECT_AGENT_WORKFLOW_VIEW_ID], seed.view],
  ] as const) {
    if (current !== undefined && JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error(`v13系统Direct Agent ${label}固定ID已被异语义对象占用`);
    }
  }
  definitions[SYSTEM_DIRECT_AGENT_WORKFLOW_DEFINITION_ID] = seed.definition;
  revisions[SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID] = seed.revision;
  views[SYSTEM_DIRECT_AGENT_WORKFLOW_VIEW_ID] = seed.view;

  return productSnapshotSchema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v13",
    entities: {
      ...snapshot.entities,
      workflowDefinitions: definitions,
      workflowDefinitionRevisions: revisions,
      workflowViewDefinitions: views,
      directAgentCandidates: {},
      promptReviewRequests: {},
      promptReviewDecisions: {},
    },
  });
}
