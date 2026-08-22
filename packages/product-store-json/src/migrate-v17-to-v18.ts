import { productSnapshotSchema, type ProductSnapshot } from "@chat/contracts";
import {
  SYSTEM_DIRECT_AGENT_WORKFLOW_DEFINITION_ID,
  SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID,
  SYSTEM_DIRECT_AGENT_WORKFLOW_VIEW_ID,
  createSystemDirectAgentDefinition,
} from "@chat/application/workflow-system-definitions";
import type { ProductSnapshotV17 } from "./legacy-v17.js";

/**
 * v18增加不可变Agent Version集合，并发布Direct Workflow v2使新会话继承Pi CLI默认。
 * v1只读Revision/View完整保留给历史Run；只移动system Definition的published指针。
 */
export function migrateProductSnapshotV17ToV18(snapshot: ProductSnapshotV17): ProductSnapshot {
  const definitions = { ...snapshot.entities.workflowDefinitions };
  const revisions = { ...snapshot.entities.workflowDefinitionRevisions };
  const views = { ...snapshot.entities.workflowViewDefinitions };
  const prior = definitions[SYSTEM_DIRECT_AGENT_WORKFLOW_DEFINITION_ID];
  const seed = createSystemDirectAgentDefinition(prior?.createdAt ?? snapshot.committedAt);
  for (const [label, current, expected] of [
    ["Revision", revisions[SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID], seed.revision],
    ["View", views[SYSTEM_DIRECT_AGENT_WORKFLOW_VIEW_ID], seed.view],
  ] as const) {
    if (current !== undefined && JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error(`v18系统Direct Agent ${label}固定ID已被异语义对象占用`);
    }
  }
  definitions[SYSTEM_DIRECT_AGENT_WORKFLOW_DEFINITION_ID] = {
    ...seed.definition,
    createdAt: prior?.createdAt ?? seed.definition.createdAt,
  };
  revisions[SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID] = seed.revision;
  views[SYSTEM_DIRECT_AGENT_WORKFLOW_VIEW_ID] = seed.view;
  return productSnapshotSchema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v18",
    entities: {
      ...snapshot.entities,
      workflowDefinitions: definitions,
      workflowDefinitionRevisions: revisions,
      workflowViewDefinitions: views,
      agentVersions: {},
    },
  });
}
