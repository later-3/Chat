import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmptySnapshot } from "@chat/contracts";
import { describe, expect, it } from "vitest";
import { JsonProductStore } from "./json-product-store.js";
import { productSnapshotV18Schema } from "./legacy-v18.js";
import { migrateProductSnapshotV18ToV19 } from "./migrate-v18-to-v19.js";

const NOW = "2026-08-23T00:00:00.000Z";

function v18Entities(entities: Record<string, unknown>): Record<string, unknown> {
  const legacy = structuredClone(entities);
  for (const key of [
    "projectWorkBlocks",
    "projectWorkClaims",
    "projectWorkHandoffs",
    "projectPracticeRevisions",
    "projectWorkOutcomes",
    "projectContextMaps",
    "projectProviderBindings",
    "projectProviderProjections",
    "projectCoordinationOperations",
    "projectInboundChanges",
    "toolExecutionIntents",
    "toolExecutionDecisions",
    "toolExecutionResults",
    "projectProfileRevisions",
    "projectConfigurationRevisions",
    "projectEvents",
    "projectNeeds",
    "projectRequirements",
    "projectArtifactRefs",
    "projectMetricObservations",
  ]) {
    delete legacy[key];
  }
  return legacy;
}

function v18WithQueuedProjectBootstrapOperation() {
  const current = createEmptySnapshot(NOW);
  current.entities.projectBootstrapCandidates["pbc_v18queued1"] = {
    schemaVersion: "project-bootstrap.v1",
    projectBootstrapCandidateId: "pbc_v18queued1" as never,
    ownerPrincipalId: "usr_v18migration1" as never,
    sourceProductSessionId: "psn_v18migration1" as never,
    sourceProductRunId: "run_v18migration1" as never,
    proposal: {
      name: "v18建项候选",
      objective: "验证Store升级不会代替用户retry触发外部写入。",
      planeWorkspaceSlug: "migration",
      planeProjectIdentifier: "MIG18",
      workspaceRootId: "root_code" as never,
      directoryName: "v18-migration",
      initializerProfile: "blank",
      initialModules: [],
    },
    preview: {
      planeProjectLabel: "migration/MIG18",
      workspaceLabel: "Code/v18-migration",
      gitAction: "initialize",
      initialModules: [],
    },
    status: "confirmed",
    sha256: "a".repeat(64) as never,
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
  };
  current.entities.projectBootstrapDecisions["pbd_v18confirm1"] = {
    schemaVersion: "project-bootstrap.v1",
    projectBootstrapDecisionId: "pbd_v18confirm1" as never,
    projectBootstrapCandidateId: "pbc_v18queued1" as never,
    candidateRevision: 1,
    candidateSha256: "a".repeat(64) as never,
    decidedByPrincipalId: "usr_v18migration1" as never,
    kind: "confirm",
    decidedAt: NOW,
  };
  current.entities.projectBootstrapOperations["pbo_v18queued1"] = {
    schemaVersion: "project-bootstrap.v1",
    projectBootstrapOperationId: "pbo_v18queued1" as never,
    projectBootstrapCandidateId: "pbc_v18queued1" as never,
    projectBootstrapDecisionId: "pbd_v18confirm1" as never,
    candidateSha256: "a".repeat(64) as never,
    ownerPrincipalId: "usr_v18migration1" as never,
    status: "queued",
    workspaceStep: "pending",
    planeStep: "pending",
    bindingStep: "pending",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return productSnapshotV18Schema.parse({
    ...current,
    schemaVersion: "chat-product-store.v18",
    entities: v18Entities(current.entities),
  });
}

describe("Product Store v18到v19 Project Bootstrap Outbox迁移", () => {
  it("只提升Schema版本，保留旧事实且不自动创建或执行Outbox", () => {
    const legacy = v18WithQueuedProjectBootstrapOperation();
    const migrated = migrateProductSnapshotV18ToV19(legacy);

    expect(migrated).toEqual({ ...legacy, schemaVersion: "chat-product-store.v19" });
    expect(migrated.entities.projectBootstrapOperations["pbo_v18queued1"]).toMatchObject({
      status: "queued",
      workspaceStep: "pending",
      planeStep: "pending",
      bindingStep: "pending",
      revision: 1,
    });
    expect(migrated.entities.projectWorkspaceBindings).toEqual({});
    expect(
      Object.values(migrated.outbox).filter((entry) => entry.kind === "project_bootstrap_execute"),
    ).toEqual([]);
  });

  it("旧快照首次打开原子落盘v19，重启不再改写", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chat-v18-v19-open-"));
    const filePath = join(directory, "product-store.json");
    const seedStore = await JsonProductStore.open({
      filePath: join(directory, "seed-product-store.json"),
      now: () => NOW,
    });
    const seeded = (await seedStore.read({ kind: "committedSnapshot" })).snapshot;
    const legacy = productSnapshotV18Schema.parse({
      ...seeded,
      schemaVersion: "chat-product-store.v18",
      entities: v18Entities(seeded.entities),
    });
    await writeFile(filePath, JSON.stringify(legacy, null, 2));

    await JsonProductStore.open({ filePath, now: () => NOW });
    const once = await readFile(filePath, "utf8");
    expect(JSON.parse(once)).toMatchObject({ schemaVersion: "chat-product-store.v23" });
    await JsonProductStore.open({ filePath, now: () => NOW });
    expect(await readFile(filePath, "utf8")).toBe(once);
  });

  it("v18严格拒绝新增的Project Bootstrap执行Outbox kind", () => {
    const snapshot = createEmptySnapshot(NOW);
    snapshot.outbox["obx_v19only1"] = {
      schemaVersion: "outbox-entry.v1",
      outboxId: "obx_v19only1" as never,
      kind: "project_bootstrap_execute",
      projectBootstrapOperationId: "pbo_v19only1" as never,
      expectedOperationRevision: 1,
      mode: "execute",
      status: "pending",
      dispatchAttempts: 0,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(
      productSnapshotV18Schema.safeParse({
        ...snapshot,
        schemaVersion: "chat-product-store.v18",
      }).success,
    ).toBe(false);
  });
});
