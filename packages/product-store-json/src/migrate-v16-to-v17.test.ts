import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmptySnapshot } from "@chat/contracts";
import { describe, expect, it } from "vitest";
import { JsonProductStore } from "./json-product-store.js";
import {
  productSnapshotV16MainSchema,
  productSnapshotV16PlaneSchema,
  productSnapshotV16Schema,
} from "./legacy-v16.js";
import { migrateProductSnapshotV16ToV17 } from "./migrate-v16-to-v17.js";

const NOW = "2026-08-21T00:00:00.000Z";

function mainV16() {
  const current = createEmptySnapshot(NOW);
  const entities = structuredClone(current.entities) as Record<string, unknown>;
  delete entities["agentVersions"];
  delete entities["projectBootstrapCandidates"];
  delete entities["projectBootstrapDecisions"];
  delete entities["projectBootstrapOperations"];
  delete entities["projectWorkspaceBindings"];
  return productSnapshotV16MainSchema.parse({
    ...current,
    schemaVersion: "chat-product-store.v16",
    entities,
  });
}

async function seededMainV16() {
  const directory = await mkdtemp(join(tmpdir(), "chat-v17-genesis-"));
  const store = await JsonProductStore.open({
    filePath: join(directory, "product-store.json"),
    now: () => NOW,
  });
  const { snapshot } = await store.read({ kind: "committedSnapshot" });
  const entities = structuredClone(snapshot.entities) as Record<string, unknown>;
  delete entities["agentVersions"];
  delete entities["projectBootstrapCandidates"];
  delete entities["projectBootstrapDecisions"];
  delete entities["projectBootstrapOperations"];
  delete entities["projectWorkspaceBindings"];
  return productSnapshotV16MainSchema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v16",
    entities,
  });
}

function planeV16WithFacts() {
  const current = createEmptySnapshot(NOW);
  current.entities.projectBootstrapCandidates["pbc_migration1"] = {
    schemaVersion: "project-bootstrap.v1",
    projectBootstrapCandidateId: "pbc_migration1" as never,
    ownerPrincipalId: "usr_migration" as never,
    sourceProductSessionId: "psn_migration" as never,
    sourceProductRunId: "run_migration" as never,
    proposal: {
      name: "AI学习",
      objective: "验证Plane分支v16事实不会在合并迁移中丢失。",
      planeWorkspaceSlug: "ai",
      planeProjectIdentifier: "AI2026",
      workspaceRootId: "root_code" as never,
      directoryName: "ai-learning",
      initializerProfile: "ai_learning",
      initialModules: ["课程"],
    },
    preview: {
      planeProjectLabel: "ai/AI2026",
      workspaceLabel: "Code/ai-learning",
      gitAction: "initialize",
      initialModules: ["课程"],
    },
    status: "ready",
    sha256: "a".repeat(64) as never,
    revision: 4,
    createdAt: NOW,
    updatedAt: NOW,
  };
  current.entities.projectBootstrapDecisions["pbd_migration1"] = {
    schemaVersion: "project-bootstrap.v1",
    projectBootstrapDecisionId: "pbd_migration1" as never,
    projectBootstrapCandidateId: "pbc_migration1" as never,
    candidateRevision: 1,
    candidateSha256: "a".repeat(64) as never,
    decidedByPrincipalId: "usr_migration" as never,
    kind: "confirm",
    decidedAt: NOW,
  };
  current.entities.projectBootstrapOperations["pbo_migration1"] = {
    schemaVersion: "project-bootstrap.v1",
    projectBootstrapOperationId: "pbo_migration1" as never,
    projectBootstrapCandidateId: "pbc_migration1" as never,
    projectBootstrapDecisionId: "pbd_migration1" as never,
    candidateSha256: "a".repeat(64) as never,
    ownerPrincipalId: "usr_migration" as never,
    status: "ready",
    workspaceStep: "completed",
    planeStep: "completed",
    bindingStep: "completed",
    planeProjectId: "66cf0460-84e0-4d3d-b1ef-d193b83b7562" as never,
    revision: 3,
    createdAt: NOW,
    updatedAt: NOW,
  };
  current.entities.projectWorkspaceBindings["pwb_migration1"] = {
    schemaVersion: "project-bootstrap.v1",
    projectWorkspaceBindingId: "pwb_migration1" as never,
    ownerPrincipalId: "usr_migration" as never,
    productSessionId: "psn_migration" as never,
    projectBootstrapOperationId: "pbo_migration1" as never,
    providerKind: "plane_ce",
    planeWorkspaceSlug: "ai",
    planeProjectId: "66cf0460-84e0-4d3d-b1ef-d193b83b7562" as never,
    planeProjectIdentifier: "AI2026",
    workspaceRootId: "root_code" as never,
    directoryName: "ai-learning",
    status: "active",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const entities = structuredClone(current.entities) as Record<string, unknown>;
  delete entities["agentVersions"];
  return productSnapshotV16PlaneSchema.parse({
    ...current,
    schemaVersion: "chat-product-store.v16",
    entities,
  });
}

describe("Product Store双v16到v17迁移", () => {
  it("main v16补齐四个空集合且首次落盘后重启不再改写", async () => {
    const legacy = await seededMainV16();
    const migrated = migrateProductSnapshotV16ToV17(legacy);
    expect(migrated.schemaVersion).toBe("chat-product-store.v17");
    expect(migrated.entities.projectBootstrapCandidates).toEqual({});
    expect(migrated.entities.projectBootstrapDecisions).toEqual({});
    expect(migrated.entities.projectBootstrapOperations).toEqual({});
    expect(migrated.entities.projectWorkspaceBindings).toEqual({});
    expect(migrated.storeRevision).toBe(legacy.storeRevision);

    const directory = await mkdtemp(join(tmpdir(), "chat-v16-main-"));
    const filePath = join(directory, "product-store.json");
    await writeFile(filePath, JSON.stringify(legacy, null, 2));
    await JsonProductStore.open({ filePath, now: () => NOW });
    const once = await readFile(filePath, "utf8");
    await JsonProductStore.open({ filePath, now: () => NOW });
    expect(await readFile(filePath, "utf8")).toBe(once);
  });

  it("Plane v16逐对象保留四组非空初始化事实", () => {
    const legacy = planeV16WithFacts();
    const migrated = migrateProductSnapshotV16ToV17(legacy);
    expect(migrated.entities.projectBootstrapCandidates).toEqual(
      legacy.entities.projectBootstrapCandidates,
    );
    expect(migrated.entities.projectBootstrapDecisions).toEqual(
      legacy.entities.projectBootstrapDecisions,
    );
    expect(migrated.entities.projectBootstrapOperations).toEqual(
      legacy.entities.projectBootstrapOperations,
    );
    expect(migrated.entities.projectWorkspaceBindings).toEqual(
      legacy.entities.projectWorkspaceBindings,
    );
  });

  it("只含部分Plane集合的v16失败关闭", () => {
    const incomplete = structuredClone(mainV16()) as Record<string, unknown>;
    const entities = incomplete["entities"] as Record<string, unknown>;
    entities["projectBootstrapCandidates"] = {};
    expect(productSnapshotV16Schema.safeParse(incomplete).success).toBe(false);
  });

  it("v16原子迁移在rename前失败时保留原字节", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chat-v16-rename-"));
    const filePath = join(directory, "product-store.json");
    const before = JSON.stringify(await seededMainV16(), null, 2);
    await writeFile(filePath, before);
    await expect(
      JsonProductStore.open({
        filePath,
        now: () => NOW,
        io: { renameTempFile: async () => Promise.reject(new Error("rename failed")) },
      }),
    ).rejects.toThrow("Product Store提交在atomic rename前失败");
    expect(await readFile(filePath, "utf8")).toBe(before);
  });
});
