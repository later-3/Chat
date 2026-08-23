import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SYSTEM_MEMORY_DIRECT_WORKFLOW_DEFINITION_ID,
  SYSTEM_MEMORY_DIRECT_WORKFLOW_REVISION_ID,
  SYSTEM_MEMORY_DIRECT_WORKFLOW_VIEW_ID,
} from "@chat/application/workflow-system-definitions";
import { describe, expect, it } from "vitest";
import { JsonProductStore } from "./json-product-store.js";
import { productSnapshotV18Schema, type ProductSnapshotV18 } from "./legacy-v18.js";
import { migrateProductSnapshotV18ToV19 } from "./migrate-v18-to-v19.js";
import { migrateProductSnapshotV19ToV20 } from "./migrate-v19-to-v20.js";
import { migrateProductSnapshotV20ToV21 } from "./migrate-v20-to-v21.js";
import { assertSnapshotIntegrity } from "./snapshot-integrity.js";

const NOW = "2026-08-24T08:00:00.000Z";

async function seededV18(): Promise<ProductSnapshotV18> {
  const directory = await mkdtemp(join(tmpdir(), "chat-memory-direct-v18-seed-"));
  const store = await JsonProductStore.open({
    filePath: join(directory, "product-store.json"),
    now: () => NOW,
  });
  const { snapshot } = await store.read({ kind: "committedSnapshot" });
  const {
    memorySessionImports: _memorySessionImports,
    memoryAgentWriteCandidates: _memoryAgentWriteCandidates,
    memoryAgentWriteDecisions: _memoryAgentWriteDecisions,
    memoryAgentOperations: _memoryAgentOperations,
    ...entities
  } = structuredClone(snapshot.entities);
  void _memorySessionImports;
  void _memoryAgentWriteCandidates;
  void _memoryAgentWriteDecisions;
  void _memoryAgentOperations;
  delete entities.workflowDefinitions[SYSTEM_MEMORY_DIRECT_WORKFLOW_DEFINITION_ID];
  delete entities.workflowDefinitionRevisions[SYSTEM_MEMORY_DIRECT_WORKFLOW_REVISION_ID];
  delete entities.workflowViewDefinitions[SYSTEM_MEMORY_DIRECT_WORKFLOW_VIEW_ID];
  return productSnapshotV18Schema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v18",
    entities,
  });
}

describe("Product Store v18到v19 Memory Direct迁移", () => {
  it("只新增固定Definition、Revision与View，其他事实和Store revision完全不变", async () => {
    const legacy = await seededV18();
    const legacyMemoryPlanning = Object.values(legacy.entities.workflowDefinitionRevisions).find(
      (revision) => revision.workflowDefinitionRevisionId === "wfr_systemmemoryplanningv1",
    );
    expect(legacyMemoryPlanning?.definitionSha256).toBe(
      "b03c3f476b9e277f01892703d6d8a0385b2a5d5cb0baaa66a36c36e15cb555a7",
    );
    expect(
      legacyMemoryPlanning?.semanticRoot.elements.find(
        (node) => node.kind === "task" && node.definitionNodeId === "memory-planning.write",
      ),
    ).not.toHaveProperty("config.required");
    const migrated = migrateProductSnapshotV18ToV19(legacy);

    expect(migrated.schemaVersion).toBe("chat-product-store.v19");
    expect(migrated.storeRevision).toBe(legacy.storeRevision);
    expect(migrated.committedAt).toBe(legacy.committedAt);
    expect(migrated.entities.workflowDefinitions).toEqual({
      ...legacy.entities.workflowDefinitions,
      [SYSTEM_MEMORY_DIRECT_WORKFLOW_DEFINITION_ID]: expect.objectContaining({
        key: "system.memory-direct",
        blueprintKey: "direct",
        blueprintVersion: 2,
      }),
    });
    expect(migrated.entities.workflowDefinitionRevisions).toEqual({
      ...legacy.entities.workflowDefinitionRevisions,
      [SYSTEM_MEMORY_DIRECT_WORKFLOW_REVISION_ID]: expect.objectContaining({
        workflowDefinitionId: SYSTEM_MEMORY_DIRECT_WORKFLOW_DEFINITION_ID,
        blueprintKey: "direct",
        blueprintVersion: 2,
      }),
    });
    expect(migrated.entities.workflowDefinitionRevisions["wfr_systemmemoryplanningv1"]).toEqual(
      legacyMemoryPlanning,
    );
    expect(migrated.entities.workflowViewDefinitions).toEqual({
      ...legacy.entities.workflowViewDefinitions,
      [SYSTEM_MEMORY_DIRECT_WORKFLOW_VIEW_ID]: expect.objectContaining({
        source: expect.objectContaining({
          workflowDefinitionId: SYSTEM_MEMORY_DIRECT_WORKFLOW_DEFINITION_ID,
        }),
      }),
    });
    expect(() =>
      assertSnapshotIntegrity(
        migrateProductSnapshotV20ToV21(migrateProductSnapshotV19ToV20(migrated)),
      ),
    ).not.toThrow();
  });

  it("固定ID被异语义对象占用时失败关闭，不静默覆盖", async () => {
    const legacy = await seededV18();
    const current = migrateProductSnapshotV18ToV19(legacy);
    const conflicting = productSnapshotV18Schema.parse({
      ...current,
      schemaVersion: "chat-product-store.v18",
      entities: {
        ...current.entities,
        workflowDefinitions: {
          ...current.entities.workflowDefinitions,
          [SYSTEM_MEMORY_DIRECT_WORKFLOW_DEFINITION_ID]: {
            ...current.entities.workflowDefinitions[SYSTEM_MEMORY_DIRECT_WORKFLOW_DEFINITION_ID]!,
            title: "冲突的系统定义",
          },
        },
      },
    });

    expect(() => migrateProductSnapshotV18ToV19(conflicting)).toThrow(
      "v19系统Memory Direct Definition固定ID已被异语义对象占用",
    );
  });

  it("首次原子迁移后重启保持字节不变", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chat-memory-direct-v18-open-"));
    const filePath = join(directory, "product-store.json");
    await writeFile(filePath, JSON.stringify(await seededV18(), null, 2));

    await JsonProductStore.open({ filePath, now: () => NOW });
    const once = await readFile(filePath, "utf8");
    await JsonProductStore.open({ filePath, now: () => NOW });

    expect(await readFile(filePath, "utf8")).toBe(once);
  });
});
