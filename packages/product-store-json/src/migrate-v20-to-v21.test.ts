import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
} from "@chat/application/workflow-system-definitions";
import { JsonProductStore } from "./json-product-store.js";
import { productSnapshotV20Schema } from "./legacy-v20.js";
import { migrateProductSnapshotV20ToV21 } from "./migrate-v20-to-v21.js";
import { assertSnapshotIntegrity } from "./snapshot-integrity.js";

const NOW = "2026-08-24T12:00:00.000Z";

describe("Product Store v20到v21 Memory Agent迁移", () => {
  it("只新增空候选、决定、Operation集合和固定direct@3/4/5 Definition", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chat-memory-agent-v20-v21-"));
    const store = await JsonProductStore.open({
      filePath: join(directory, "product.json"),
      now: () => NOW,
    });
    const current = (await store.read({ kind: "committedSnapshot" })).snapshot;
    const {
      memoryAgentWriteCandidates: _candidates,
      memoryAgentWriteDecisions: _decisions,
      memoryAgentOperations: _operations,
      ...entityRest
    } = current.entities;
    void _candidates;
    void _decisions;
    void _operations;
    const workflowDefinitions = { ...entityRest.workflowDefinitions };
    const workflowDefinitionRevisions = { ...entityRest.workflowDefinitionRevisions };
    const workflowViewDefinitions = { ...entityRest.workflowViewDefinitions };
    delete workflowDefinitions[SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_DEFINITION_ID];
    delete workflowDefinitionRevisions[SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_REVISION_ID];
    delete workflowViewDefinitions[SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_VIEW_ID];
    delete workflowDefinitions[SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_DEFINITION_ID];
    delete workflowDefinitionRevisions[SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_REVISION_ID];
    delete workflowViewDefinitions[SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_VIEW_ID];
    delete workflowDefinitions[SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_DEFINITION_ID];
    delete workflowDefinitionRevisions[SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_REVISION_ID];
    delete workflowViewDefinitions[SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_VIEW_ID];
    const legacy = productSnapshotV20Schema.parse({
      ...current,
      schemaVersion: "chat-product-store.v20",
      entities: {
        ...entityRest,
        workflowDefinitions,
        workflowDefinitionRevisions,
        workflowViewDefinitions,
      },
    });

    const migrated = migrateProductSnapshotV20ToV21(legacy);
    expect(migrated.schemaVersion).toBe("chat-product-store.v21");
    expect(migrated.storeRevision).toBe(legacy.storeRevision);
    expect(migrated.entities.memoryAgentWriteCandidates).toEqual({});
    expect(migrated.entities.memoryAgentWriteDecisions).toEqual({});
    expect(migrated.entities.memoryAgentOperations).toEqual({});
    expect(
      migrated.entities.workflowDefinitions[SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_DEFINITION_ID],
    ).toMatchObject({ key: "system.memory-agent-direct", blueprintVersion: 3 });
    expect(
      migrated.entities.workflowDefinitions[SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_DEFINITION_ID],
    ).toMatchObject({ key: "system.memory-read-direct", blueprintVersion: 4 });
    expect(
      migrated.entities.workflowDefinitions[SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_DEFINITION_ID],
    ).toMatchObject({ key: "system.memory-write-direct", blueprintVersion: 5 });
    expect(() => assertSnapshotIntegrity(migrated)).not.toThrow();
  });
});
