import { productSnapshotV13Schema, type ProductSnapshotV13 } from "./legacy-v13.js";
import {
  SYSTEM_DIRECT_AGENT_WORKFLOW_DEFINITION_ID,
  LEGACY_SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID,
  LEGACY_SYSTEM_DIRECT_AGENT_WORKFLOW_VIEW_ID,
  SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID,
  SYSTEM_DIRECT_AGENT_WORKFLOW_VIEW_ID,
  createLegacySystemDirectAgentDefinition,
  createSystemDirectAgentDefinition,
} from "@chat/application/workflow-system-definitions";
import type { ProductSnapshotV12 } from "./legacy-v12.js";

/**
 * v12→v13新增Direct Agent候选、Prompt Review事实与固定Direct系统Definition。
 * 旧Run及所有历史事实原样保留；迁移不伪造审核、Decision、Candidate或运行终态。
 */
export function migrateProductSnapshotV12ToV13(snapshot: ProductSnapshotV12): ProductSnapshotV13 {
  const definitions = { ...snapshot.entities.workflowDefinitions };
  const revisions = { ...snapshot.entities.workflowDefinitionRevisions };
  const views = { ...snapshot.entities.workflowViewDefinitions };
  // 部分历史测试工件由更新后的创世快照降格生成，可能已携带v2；真实v12则种入
  // 当时发布的v1只读Revision。两者都必须幂等，不能把一个版本覆盖成另一个。
  const alreadyCurrent =
    definitions[SYSTEM_DIRECT_AGENT_WORKFLOW_DEFINITION_ID]?.publishedRevisionId ===
    SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID;
  const seed = alreadyCurrent
    ? createSystemDirectAgentDefinition(snapshot.committedAt)
    : createLegacySystemDirectAgentDefinition(snapshot.committedAt);
  const revisionId = alreadyCurrent
    ? SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID
    : LEGACY_SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID;
  const viewId = alreadyCurrent
    ? SYSTEM_DIRECT_AGENT_WORKFLOW_VIEW_ID
    : LEGACY_SYSTEM_DIRECT_AGENT_WORKFLOW_VIEW_ID;
  for (const [label, current, expected] of [
    ["Definition", definitions[SYSTEM_DIRECT_AGENT_WORKFLOW_DEFINITION_ID], seed.definition],
    ["Revision", revisions[revisionId], seed.revision],
    ["View", views[viewId], seed.view],
  ] as const) {
    if (current !== undefined && JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error(`v13系统Direct Agent ${label}固定ID已被异语义对象占用`);
    }
  }
  definitions[SYSTEM_DIRECT_AGENT_WORKFLOW_DEFINITION_ID] = seed.definition;
  revisions[revisionId] = seed.revision;
  views[viewId] = seed.view;

  return productSnapshotV13Schema.parse({
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
