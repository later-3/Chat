import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonProductStore } from "./json-product-store.js";
import { productSnapshotV8Schema } from "./legacy-v8.js";
import { migrateProductSnapshotV8ToV9 } from "./migrate-v8-to-v9.js";

const NOW = "2026-08-10T12:00:00.000Z";

describe("Product Store v8→v9", () => {
  it("只增加空Rule/Project Context集合，旧v8构建严格拒绝v9", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chat-rule-v9-migration-"));
    const filePath = join(directory, "product.json");
    const store = await JsonProductStore.open({ filePath, now: () => NOW });
    const current = (await store.read({ kind: "committedSnapshot" })).snapshot;
    const legacy = productSnapshotV8Schema.parse({
      ...current,
      schemaVersion: "chat-product-store.v8",
      entities: Object.fromEntries(
        Object.entries(current.entities).filter(
          ([key]) =>
            ![
              "rules",
              "ruleRevisions",
              "ruleTags",
              "ruleDecisions",
              "ruleSelections",
              "planningProjectContexts",
              "planningMemorySelections",
              "workflowPolicyResolutions",
              "workflowMemoryQueries",
              "workflowMemorySnapshots",
              "workflowMemoryContexts",
              "memoryWriteIntents",
              "memoryWriteResults",
              "directAgentCandidates",
              "promptReviewRequests",
              "promptReviewDecisions",
              "promptFragments",
              "promptFragmentRevisions",
              "promptAssemblies",
              "agentVersions",
              "projectBootstrapCandidates",
              "projectBootstrapDecisions",
              "projectBootstrapOperations",
              "projectWorkspaceBindings",
            ].includes(key),
        ),
      ),
    });
    const migrated = migrateProductSnapshotV8ToV9(legacy);
    expect(migrated.entities.rules).toEqual({});
    expect(migrated.entities.ruleRevisions).toEqual({});
    expect(migrated.entities.ruleTags).toEqual({});
    expect(migrated.entities.ruleDecisions).toEqual({});
    expect(migrated.entities.ruleSelections).toEqual({});
    expect(migrated.entities.planningProjectContexts).toEqual({});
    expect(productSnapshotV8Schema.safeParse(migrated).success).toBe(false);

    await writeFile(filePath, JSON.stringify(legacy), "utf8");
    await JsonProductStore.open({ filePath, now: () => NOW });
    const onDisk = JSON.parse(await readFile(filePath, "utf8")) as { schemaVersion?: unknown };
    expect(onDisk.schemaVersion).toBe("chat-product-store.v19");
    await JsonProductStore.open({ filePath, now: () => NOW });
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(onDisk);
  });
});
