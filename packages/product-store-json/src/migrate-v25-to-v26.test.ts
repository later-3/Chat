import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
import { describe, expect, it } from "vitest";
import { JsonProductStore } from "./json-product-store.js";
import { productSnapshotV25Schema, type ProductSnapshotV25 } from "./legacy-v25.js";
import { migrateProductSnapshotV25ToV26 } from "./migrate-v25-to-v26.js";

const NOW = "2026-08-26T13:00:00.000Z";
const MEMORY_ENTITY_KEYS = [
  "memorySessionImports",
  "memoryAgentOperations",
  "memoryAgentWriteCandidates",
  "memoryAgentWriteDecisions",
] as const;
const MEMORY_DEFINITION_IDS = [
  SYSTEM_MEMORY_DIRECT_WORKFLOW_DEFINITION_ID,
  SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_DEFINITION_ID,
  SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_DEFINITION_ID,
  SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_DEFINITION_ID,
] as const;
const MEMORY_REVISION_IDS = [
  SYSTEM_MEMORY_DIRECT_WORKFLOW_REVISION_ID,
  SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_REVISION_ID,
  SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_REVISION_ID,
  SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_REVISION_ID,
] as const;
const MEMORY_VIEW_IDS = [
  SYSTEM_MEMORY_DIRECT_WORKFLOW_VIEW_ID,
  SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_VIEW_ID,
  SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_VIEW_ID,
  SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_VIEW_ID,
] as const;

async function realV25Fixture(): Promise<ProductSnapshotV25> {
  const directory = await mkdtemp(join(tmpdir(), "chat-v25-memory-seed-"));
  const store = await JsonProductStore.open({
    filePath: join(directory, "product-store.json"),
    now: () => NOW,
  });
  const current = (await store.read({ kind: "committedSnapshot" })).snapshot;
  const entities = structuredClone(current.entities) as unknown as Record<string, unknown>;
  for (const key of MEMORY_ENTITY_KEYS) delete entities[key];
  const workflowDefinitions = entities["workflowDefinitions"] as Record<string, unknown>;
  const workflowDefinitionRevisions = entities["workflowDefinitionRevisions"] as Record<
    string,
    unknown
  >;
  const workflowViewDefinitions = entities["workflowViewDefinitions"] as Record<string, unknown>;
  for (const id of MEMORY_DEFINITION_IDS) delete workflowDefinitions[id];
  for (const id of MEMORY_REVISION_IDS) delete workflowDefinitionRevisions[id];
  for (const id of MEMORY_VIEW_IDS) delete workflowViewDefinitions[id];
  return productSnapshotV25Schema.parse({
    ...current,
    schemaVersion: "chat-product-store.v25",
    entities,
  });
}

describe("Product Store v25→v26 Memory Agent迁移", () => {
  it("只新增四组空事实与四个固定系统Workflow，首次落盘后字节幂等", async () => {
    const legacy = await realV25Fixture();
    const migrated = migrateProductSnapshotV25ToV26(legacy);

    expect(migrated.schemaVersion).toBe("chat-product-store.v26");
    for (const key of MEMORY_ENTITY_KEYS) expect(migrated.entities[key]).toEqual({});
    for (const id of MEMORY_DEFINITION_IDS) {
      expect(migrated.entities.workflowDefinitions[id]?.schemaVersion).toBe(
        "workflow-definition.v3",
      );
    }
    for (const id of MEMORY_REVISION_IDS) {
      expect(migrated.entities.workflowDefinitionRevisions[id]?.schemaVersion).toBe(
        "workflow-definition-revision.v3",
      );
    }
    for (const id of MEMORY_VIEW_IDS) {
      expect(migrated.entities.workflowViewDefinitions[id]).toBeDefined();
    }

    const directory = await mkdtemp(join(tmpdir(), "chat-v25-memory-open-"));
    const filePath = join(directory, "product-store.json");
    await writeFile(filePath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
    await JsonProductStore.open({ filePath, now: () => NOW });
    const firstOpen = await readFile(filePath, "utf8");
    await JsonProductStore.open({ filePath, now: () => NOW });
    expect(await readFile(filePath, "utf8")).toBe(firstOpen);
  });

  it("固定Definition身份被占用时失败关闭", async () => {
    const legacy = await realV25Fixture();
    const collision = structuredClone(legacy);
    const existing = Object.values(collision.entities.workflowDefinitions)[0];
    expect(existing).toBeDefined();
    collision.entities.workflowDefinitions[SYSTEM_MEMORY_DIRECT_WORKFLOW_DEFINITION_ID] = existing!;
    expect(() => migrateProductSnapshotV25ToV26(collision)).toThrow(/身份发生碰撞/u);
  });
});
