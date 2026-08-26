import { productSnapshotSchema, type ProductSnapshot } from "@chat/contracts";
import {
  createSystemMemoryAgentDirectDefinition,
  createSystemMemoryDirectDefinition,
  createSystemMemoryReadDirectDefinition,
  createSystemMemoryWriteDirectDefinition,
  SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_DEFINITION_ID,
  SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_REVISION_ID,
  SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_VIEW_ID,
  SYSTEM_MEMORY_DIRECT_WORKFLOW_DEFINITION_ID,
  SYSTEM_MEMORY_DIRECT_WORKFLOW_REVISION_ID,
  SYSTEM_MEMORY_DIRECT_WORKFLOW_VIEW_ID,
  SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_DEFINITION_ID,
  SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_REVISION_ID,
  SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_VIEW_ID,
  SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_DEFINITION_ID,
  SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_REVISION_ID,
  SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_VIEW_ID,
} from "@chat/application/workflow-system-definitions";
import type { ProductSnapshotV25 } from "./legacy-v25.js";

/**
 * v26发布Memory Session Import、Memory Agent产品事实集合和Memory Direct系统定义。
 * 迁移只从固定部署种子和已提交v25事实推导；模型候选、Provider对象、外部Memory ID和
 * 外部Session ID都不会在迁移时生成或伪装成产品身份。
 */
export function migrateProductSnapshotV25ToV26(snapshot: ProductSnapshotV25): ProductSnapshot {
  const migratedAt = snapshot.committedAt;
  const memoryDirect = createSystemMemoryDirectDefinition(migratedAt);
  const memoryAgentDirect = createSystemMemoryAgentDirectDefinition(migratedAt);
  const memoryReadDirect = createSystemMemoryReadDirectDefinition(migratedAt);
  const memoryWriteDirect = createSystemMemoryWriteDirectDefinition(migratedAt);
  assertNoWorkflowIdentityCollision(snapshot, {
    workflowDefinitionIds: [
      SYSTEM_MEMORY_DIRECT_WORKFLOW_DEFINITION_ID,
      SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_DEFINITION_ID,
      SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_DEFINITION_ID,
      SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_DEFINITION_ID,
    ],
    workflowDefinitionRevisionIds: [
      SYSTEM_MEMORY_DIRECT_WORKFLOW_REVISION_ID,
      SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_REVISION_ID,
      SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_REVISION_ID,
      SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_REVISION_ID,
    ],
    workflowViewDefinitionIds: [
      SYSTEM_MEMORY_DIRECT_WORKFLOW_VIEW_ID,
      SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_VIEW_ID,
      SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_VIEW_ID,
      SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_VIEW_ID,
    ],
  });

  return productSnapshotSchema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v26",
    entities: {
      ...snapshot.entities,
      workflowDefinitions: {
        ...snapshot.entities.workflowDefinitions,
        [SYSTEM_MEMORY_DIRECT_WORKFLOW_DEFINITION_ID]: memoryDirect.definition,
        [SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_DEFINITION_ID]: memoryAgentDirect.definition,
        [SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_DEFINITION_ID]: memoryReadDirect.definition,
        [SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_DEFINITION_ID]: memoryWriteDirect.definition,
      },
      workflowDefinitionRevisions: {
        ...snapshot.entities.workflowDefinitionRevisions,
        [SYSTEM_MEMORY_DIRECT_WORKFLOW_REVISION_ID]: memoryDirect.revision,
        [SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_REVISION_ID]: memoryAgentDirect.revision,
        [SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_REVISION_ID]: memoryReadDirect.revision,
        [SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_REVISION_ID]: memoryWriteDirect.revision,
      },
      workflowViewDefinitions: {
        ...snapshot.entities.workflowViewDefinitions,
        [SYSTEM_MEMORY_DIRECT_WORKFLOW_VIEW_ID]: memoryDirect.view,
        [SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_VIEW_ID]: memoryAgentDirect.view,
        [SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_VIEW_ID]: memoryReadDirect.view,
        [SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_VIEW_ID]: memoryWriteDirect.view,
      },
      memorySessionImports: {},
      memoryAgentOperations: {},
      memoryAgentWriteCandidates: {},
      memoryAgentWriteDecisions: {},
    },
  });
}

function assertNoWorkflowIdentityCollision(
  snapshot: ProductSnapshotV25,
  input: {
    readonly workflowDefinitionIds: readonly string[];
    readonly workflowDefinitionRevisionIds: readonly string[];
    readonly workflowViewDefinitionIds: readonly string[];
  },
): void {
  for (const workflowDefinitionId of input.workflowDefinitionIds) {
    if (snapshot.entities.workflowDefinitions[workflowDefinitionId] !== undefined) {
      throw new Error("v25→v26的Memory Direct系统Definition目标身份发生碰撞");
    }
  }
  for (const workflowDefinitionRevisionId of input.workflowDefinitionRevisionIds) {
    if (snapshot.entities.workflowDefinitionRevisions[workflowDefinitionRevisionId] !== undefined) {
      throw new Error("v25→v26的Memory Direct系统Revision目标身份发生碰撞");
    }
  }
  for (const workflowViewDefinitionId of input.workflowViewDefinitionIds) {
    if (snapshot.entities.workflowViewDefinitions[workflowViewDefinitionId] !== undefined) {
      throw new Error("v25→v26的Memory Direct系统View目标身份发生碰撞");
    }
  }
}
