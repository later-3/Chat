import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StoreCorruptedError } from "@chat/application";
import { JsonProductStore } from "./json-product-store.js";
import { productSnapshotV23Schema, type ProductSnapshotV23 } from "./legacy-v23.js";
import { migrateProductSnapshotV23ToV24 } from "./migrate-v23-to-v24.js";

const NOW = "2026-08-26T08:00:00.000Z";
const SUPERVISED_ENTITY_KEYS = [
  "supervisedPlanningEpochs",
  "supervisedCarryForwards",
  "supervisedStepStates",
  "supervisedAgentAttempts",
  "supervisedStepEvidence",
  "supervisedStepCandidates",
  "supervisedPlannerVerdicts",
  "supervisedStepReviewRequests",
  "supervisedStepHumanDecisions",
  "supervisedAgentOutcomeObservations",
  "supervisedExecutionResults",
] as const;

async function realNonEmptyV23(): Promise<ProductSnapshotV23> {
  const directory = await mkdtemp(join(tmpdir(), "chat-v23-seed-"));
  const store = await JsonProductStore.open({
    filePath: join(directory, "product-store.json"),
    now: () => NOW,
  });
  const current = (await store.read({ kind: "committedSnapshot" })).snapshot;
  const entities = structuredClone(current.entities) as unknown as Record<string, unknown>;
  for (const key of SUPERVISED_ENTITY_KEYS) delete entities[key];
  return productSnapshotV23Schema.parse({
    ...current,
    schemaVersion: "chat-product-store.v23",
    entities,
  });
}

describe("Product Store v23→v24", () => {
  it("只新增11组空集合，旧非空事实逐字等价且重复打开字节幂等", async () => {
    const legacy = await realNonEmptyV23();
    expect(Object.keys(legacy.entities.workflowDefinitions).length).toBeGreaterThan(0);

    const migrated = migrateProductSnapshotV23ToV24(legacy);
    const migratedEntities = structuredClone(migrated.entities) as unknown as Record<
      string,
      unknown
    >;
    for (const key of SUPERVISED_ENTITY_KEYS) {
      expect(migratedEntities[key], key).toEqual({});
      delete migratedEntities[key];
    }
    expect(migratedEntities).toEqual(legacy.entities);
    expect(migrated.storeRevision).toBe(legacy.storeRevision);
    expect(migrated.commandReceipts).toEqual(legacy.commandReceipts);
    expect(migrated.outbox).toEqual(legacy.outbox);

    const directory = await mkdtemp(join(tmpdir(), "chat-v23-migrate-"));
    const filePath = join(directory, "product-store.json");
    await writeFile(filePath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
    await JsonProductStore.open({ filePath, now: () => NOW });
    const firstOpen = await readFile(filePath, "utf8");
    await JsonProductStore.open({ filePath, now: () => NOW });
    expect(await readFile(filePath, "utf8")).toBe(firstOpen);
  });

  it.each([
    [
      "未知代际",
      (legacy: ProductSnapshotV23) => ({ ...legacy, schemaVersion: "chat-product-store.v25" }),
    ],
    [
      "v23同名监督集合碰撞",
      (legacy: ProductSnapshotV23) => ({
        ...legacy,
        entities: { ...legacy.entities, supervisedStepStates: {} },
      }),
    ],
    [
      "v23不能反向携带Prompt Assembly v5",
      (legacy: ProductSnapshotV23) => ({
        ...legacy,
        entities: {
          ...legacy.entities,
          promptAssemblies: {
            ...legacy.entities.promptAssemblies,
            pas_forbiddenv5: { schemaVersion: "prompt-assembly.v5" },
          },
        },
      }),
    ],
  ] as const)("%s失败关闭且保留原字节", async (_label, corrupt) => {
    const legacy = await realNonEmptyV23();
    const directory = await mkdtemp(join(tmpdir(), "chat-v23-corrupt-"));
    const filePath = join(directory, "product-store.json");
    const bytes = `${JSON.stringify(corrupt(legacy), null, 2)}\n`;
    await writeFile(filePath, bytes, "utf8");
    await expect(JsonProductStore.open({ filePath, now: () => NOW })).rejects.toBeInstanceOf(
      StoreCorruptedError,
    );
    expect(await readFile(filePath, "utf8")).toBe(bytes);
  });
});
