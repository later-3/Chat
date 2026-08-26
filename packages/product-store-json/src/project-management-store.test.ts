import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileBuiltInProjectProfileRevision } from "@chat/domain";
import { JsonProductStore } from "./json-product-store.js";
import { productSnapshotV22Schema } from "./legacy-v22.js";

const NOW = "2026-08-25T12:00:00.000Z";

async function temporaryStore() {
  const directory = await mkdtemp(join(tmpdir(), "chat-project-management-v23-"));
  const filePath = join(directory, "product-store.json");
  const store = await JsonProductStore.open({ filePath, now: () => NOW });
  return { filePath, store };
}

describe("Product Store v23全项目生命周期事实", () => {
  it("v22只补七组空集合且首次落盘后重启逐字节幂等", async () => {
    const { filePath, store } = await temporaryStore();
    const current = (await store.read({ kind: "committedSnapshot" })).snapshot;
    const entities = structuredClone(current.entities) as unknown as Record<string, unknown>;
    for (const key of [
      "projectProfileRevisions",
      "projectConfigurationRevisions",
      "projectEvents",
      "projectNeeds",
      "projectRequirements",
      "projectArtifactRefs",
      "projectMetricObservations",
    ]) {
      delete entities[key];
    }
    const legacy = productSnapshotV22Schema.parse({
      ...current,
      schemaVersion: "chat-product-store.v22",
      entities,
    });
    await writeFile(filePath, JSON.stringify(legacy), "utf8");

    const migratedStore = await JsonProductStore.open({ filePath, now: () => NOW });
    const migrated = (await migratedStore.read({ kind: "committedSnapshot" })).snapshot;
    expect(migrated.schemaVersion).toBe("chat-product-store.v23");
    expect(migrated.storeRevision).toBe(legacy.storeRevision);
    expect(migrated.entities.projectProfileRevisions).toEqual({});
    expect(migrated.entities.projectConfigurationRevisions).toEqual({});
    expect(migrated.entities.projectEvents).toEqual({});
    expect(migrated.entities.projectNeeds).toEqual({});
    expect(migrated.entities.projectRequirements).toEqual({});
    expect(migrated.entities.projectArtifactRefs).toEqual({});
    expect(migrated.entities.projectMetricObservations).toEqual({});

    const once = await readFile(filePath, "utf8");
    await JsonProductStore.open({ filePath, now: () => NOW });
    expect(await readFile(filePath, "utf8")).toBe(once);
  });

  it("非空Profile Revision真实提交并在重启后完整恢复", async () => {
    const { filePath, store } = await temporaryStore();
    const profile = compileBuiltInProjectProfileRevision({
      profileKey: "software-delivery",
      now: NOW,
    });
    await store.transact({
      commandId: "cmd_profileappend1" as never,
      commandType: "RegisterProjectProfileRevision",
      requestSha256: "a".repeat(64),
      mutate: (draft) => {
        draft.entities.projectProfileRevisions[profile.projectProfileRevisionId] = profile as never;
        return { resultRefs: { projectProfileRevisionId: profile.projectProfileRevisionId } };
      },
    });

    const reopened = await JsonProductStore.open({ filePath, now: () => NOW });
    const persisted = (await reopened.read({ kind: "committedSnapshot" })).snapshot.entities
      .projectProfileRevisions[profile.projectProfileRevisionId];
    expect(persisted).toEqual(profile);
  });
});
