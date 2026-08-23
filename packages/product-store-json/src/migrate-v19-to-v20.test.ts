import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { productSnapshotV19Schema } from "./legacy-v19.js";
import { migrateProductSnapshotV19ToV20 } from "./migrate-v19-to-v20.js";
import { assertSnapshotIntegrity } from "./snapshot-integrity.js";
import { JsonProductStore } from "./json-product-store.js";

const NOW = "2026-08-24T09:00:00.000Z";

describe("Product Store v19到v20 Session Import迁移", () => {
  it("只增加空批次集合并保持所有v19事实与Store revision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chat-memory-v19-v20-"));
    const store = await JsonProductStore.open({
      filePath: join(directory, "product.json"),
      now: () => NOW,
    });
    const current = (await store.read({ kind: "committedSnapshot" })).snapshot;
    const { memorySessionImports: _memorySessionImports, ...entities } = current.entities;
    void _memorySessionImports;
    const legacy = productSnapshotV19Schema.parse({
      ...current,
      schemaVersion: "chat-product-store.v19",
      entities,
    });
    const migrated = migrateProductSnapshotV19ToV20(legacy);

    expect(migrated).toEqual({
      ...legacy,
      schemaVersion: "chat-product-store.v20",
      entities: { ...legacy.entities, memorySessionImports: {} },
    });
    expect(() => assertSnapshotIntegrity(migrated)).not.toThrow();
  });
});
