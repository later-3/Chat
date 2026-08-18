import {
  LEGACY_SYSTEM_PLANNING_WORKFLOW_REVISION_ID,
  SYSTEM_PLANNING_WORKFLOW_DEFINITION_ID,
  SYSTEM_PLANNING_WORKFLOW_REVISION_ID,
  SYSTEM_PLANNING_WORKFLOW_VIEW_ID,
  createSystemPlanningDefinition,
} from "@chat/application/workflow-system-definitions";
import type { ProductSnapshotV9 } from "./legacy-v9.js";
import { productSnapshotV10Schema, type ProductSnapshotV10 } from "./legacy-v10.js";

/**
 * v9→v10新增Memory Selection与Workflow Policy Resolution产品事实。
 * 历史快照没有足够证据反推二者，因此集合必须为空；同时把系统Planning发布指针
 * 推进到移除装饰性research节点的revision 2，保留旧revision供已冻结RunSpec继续引用。
 */
export function migrateProductSnapshotV9ToV10(snapshot: ProductSnapshotV9): ProductSnapshotV10 {
  const definitions = { ...snapshot.entities.workflowDefinitions };
  const revisions = { ...snapshot.entities.workflowDefinitionRevisions };
  const views = { ...snapshot.entities.workflowViewDefinitions };
  const oldDefinition = definitions[SYSTEM_PLANNING_WORKFLOW_DEFINITION_ID];
  const oldRevision = revisions[LEGACY_SYSTEM_PLANNING_WORKFLOW_REVISION_ID];

  if (oldDefinition !== undefined && oldRevision !== undefined) {
    const seed = createSystemPlanningDefinition(snapshot.committedAt);
    definitions[SYSTEM_PLANNING_WORKFLOW_DEFINITION_ID] = {
      ...oldDefinition,
      publishedRevisionId: seed.definition.publishedRevisionId,
      revision: oldDefinition.revision + 1,
      updatedAt: snapshot.committedAt,
    };
    revisions[LEGACY_SYSTEM_PLANNING_WORKFLOW_REVISION_ID] =
      oldRevision.state === "published"
        ? {
            ...oldRevision,
            state: "superseded",
            supersededAt: snapshot.committedAt,
            updatedAt: snapshot.committedAt,
          }
        : oldRevision;
    revisions[SYSTEM_PLANNING_WORKFLOW_REVISION_ID] = seed.revision;
    views[SYSTEM_PLANNING_WORKFLOW_VIEW_ID] = seed.view;
  }

  return productSnapshotV10Schema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v10",
    entities: {
      ...snapshot.entities,
      workflowDefinitions: definitions,
      workflowDefinitionRevisions: revisions,
      workflowViewDefinitions: views,
      planningMemorySelections: {},
      workflowPolicyResolutions: {},
    },
  });
}
