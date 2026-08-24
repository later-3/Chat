import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { promptAssemblyV2Schema } from "@chat/contracts";
import { JsonProductStore } from "./json-product-store.js";
import { productSnapshotV18Schema } from "./legacy-v18.js";
import { productSnapshotV19Schema } from "./legacy-v19.js";
import { migrateProductSnapshotV18ToV19 } from "./migrate-v18-to-v19.js";
import { migrateProductSnapshotV19ToV20 } from "./migrate-v19-to-v20.js";

const NOW = "2026-08-23T00:00:00.000Z";

function historicalPromptAssemblyV2() {
  return promptAssemblyV2Schema.parse({
    schemaVersion: "prompt-assembly.v2",
    promptAssemblyId: "pma_legacyv2migration",
    productSessionId: "psn_legacyv2migration",
    productRunId: "run_legacyv2migration",
    sourceMessageId: "msg_legacyv2migration",
    workflowDefinitionRevisionId: "wfr_legacyv2migration",
    profileVersion: "direct-agent-prompt-profile.v2",
    compilerVersion: "direct-agent-prompt-compiler.v2",
    regions: [],
    systemPromptAppend: "",
    messages: [
      {
        role: "user",
        text: "历史v2迁移输入",
        source: {
          kind: "current_input",
          messageId: "msg_legacyv2migration",
          sessionSequence: 1,
          sha256: "1".repeat(64),
        },
        estimatedTokens: 4,
      },
    ],
    tools: {
      capabilityMode: "read_only",
      names: ["read", "grep", "find", "ls"],
      estimatedTokens: 8_000,
    },
    requestOptions: {
      providerId: "dashscope-coding",
      modelId: "qwen3.7-plus",
      thinkingLevel: "off",
      retryEnabled: false,
      compactionEnabled: false,
    },
    budget: {
      meterVersion: "utf8-bytes-div-3.v1",
      inputTokenLimit: 64_000,
      instructionsEstimatedTokens: 0,
      messagesEstimatedTokens: 4,
      toolsEstimatedTokens: 8_000,
      totalEstimatedTokens: 8_004,
      excludedHistoryMessageIds: [],
    },
    sha256: "2".repeat(64),
    createdAt: NOW,
  });
}

async function seededV18() {
  // v18 fixture必须携带当时已经存在的系统Definition事实；createEmptySnapshot只含空集合，
  // 直接降代会制造一个历史上不可能落盘、迁移后必然被完整性门拒绝的伪快照。
  const seedDirectory = await mkdtemp(join(tmpdir(), "chat-v18-seed-"));
  const seedStore = await JsonProductStore.open({
    filePath: join(seedDirectory, "seed.json"),
    now: () => NOW,
  });
  const { snapshot } = await seedStore.read({ kind: "committedSnapshot" });
  const current = structuredClone(snapshot);
  const legacyEntities = Object.fromEntries(
    Object.entries(current.entities).filter(
      ([key]) =>
        key !== "toolExecutionIntents" &&
        key !== "toolExecutionDecisions" &&
        key !== "toolExecutionResults",
    ),
  );
  return productSnapshotV18Schema.parse({
    ...current,
    schemaVersion: "chat-product-store.v18",
    entities: legacyEntities,
  });
}

async function v18WithQueuedProjectBootstrapOperation() {
  const current = await seededV18();
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
  return productSnapshotV18Schema.parse(current);
}

describe("Product Store v18到v19 Project Bootstrap Outbox迁移", () => {
  it("v18/v19迁移严格拒绝在历史v2 tools下注入v4-only字段", async () => {
    const v18 = await seededV18();
    const assembly = historicalPromptAssemblyV2();
    v18.entities.promptAssemblies[assembly.promptAssemblyId] = assembly;
    expect(productSnapshotV18Schema.safeParse(v18).success).toBe(true);
    const v19 = migrateProductSnapshotV18ToV19(v18);
    expect(productSnapshotV19Schema.safeParse(v19).success).toBe(true);
    expect(migrateProductSnapshotV19ToV20(v19).schemaVersion).toBe("chat-product-store.v20");

    for (const [schemaVersion, snapshot] of [
      ["chat-product-store.v18", v18],
      ["chat-product-store.v19", v19],
    ] as const) {
      const broken = structuredClone(snapshot) as unknown as {
        entities: {
          promptAssemblies: Record<string, { tools: Record<string, unknown> }>;
        };
      };
      broken.entities.promptAssemblies[assembly.promptAssemblyId]!.tools["capabilities"] = [];
      expect(
        (schemaVersion === "chat-product-store.v18"
          ? productSnapshotV18Schema
          : productSnapshotV19Schema
        ).safeParse(broken).success,
      ).toBe(false);
      const directory = await mkdtemp(join(tmpdir(), "chat-legacy-v2-injection-"));
      const filePath = join(directory, "product-store.json");
      await writeFile(filePath, JSON.stringify({ ...broken, schemaVersion }));
      await expect(JsonProductStore.open({ filePath, now: () => NOW })).rejects.toThrow();
    }
  });

  it("真实v18只复制到临时目录迁移v20，重复打开字节幂等且源文件不变", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chat-real-v18-copy-"));
    const source = process.env.CHAT_REAL_V18_SOURCE ?? join(directory, "synthetic-v18-source.json");
    if (process.env.CHAT_REAL_V18_SOURCE === undefined) {
      await writeFile(source, JSON.stringify(await seededV18()));
    }
    const filePath = join(directory, "product-store.json");
    const sourceBefore = await readFile(source);
    await copyFile(source, filePath);
    const copiedLegacy = productSnapshotV18Schema.safeParse(
      JSON.parse((await readFile(filePath)).toString("utf8")),
    );
    expect(
      copiedLegacy.success,
      copiedLegacy.success ? undefined : JSON.stringify(copiedLegacy.error.issues),
    ).toBe(true);
    await JsonProductStore.open({ filePath, now: () => NOW });
    const once = await readFile(filePath);
    expect(JSON.parse(once.toString("utf8")).schemaVersion).toBe("chat-product-store.v20");
    await JsonProductStore.open({ filePath, now: () => NOW });
    expect(await readFile(filePath)).toEqual(once);
    const sourceAfter = await readFile(source);
    expect(createHash("sha256").update(sourceAfter).digest("hex")).toBe(
      createHash("sha256").update(sourceBefore).digest("hex"),
    );
  });

  it("v19→v20只增加三张Tool事实集合并严格拒绝歧义Task03私有v19", async () => {
    const v19 = migrateProductSnapshotV18ToV19(await v18WithQueuedProjectBootstrapOperation());
    const source = structuredClone(v19);
    const migrated = migrateProductSnapshotV19ToV20(v19);
    expect(v19).toEqual(source);
    expect(migrated).toEqual({
      ...v19,
      schemaVersion: "chat-product-store.v20",
      entities: {
        ...v19.entities,
        toolExecutionIntents: {},
        toolExecutionDecisions: {},
        toolExecutionResults: {},
      },
    });
    expect(
      productSnapshotV19Schema.safeParse({
        ...v19,
        entities: { ...v19.entities, toolExecutionIntents: {} },
      }).success,
    ).toBe(false);
  });

  it("只提升Schema版本，保留旧事实且不自动创建或执行Outbox", async () => {
    const legacy = await v18WithQueuedProjectBootstrapOperation();
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
    const legacyEntities = Object.fromEntries(
      Object.entries(seeded.entities).filter(
        ([key]) =>
          key !== "toolExecutionIntents" &&
          key !== "toolExecutionDecisions" &&
          key !== "toolExecutionResults",
      ),
    );
    const legacy = productSnapshotV18Schema.parse({
      ...seeded,
      schemaVersion: "chat-product-store.v18",
      entities: legacyEntities,
    });
    await writeFile(filePath, JSON.stringify(legacy, null, 2));

    await JsonProductStore.open({ filePath, now: () => NOW });
    const once = await readFile(filePath, "utf8");
    expect(JSON.parse(once)).toEqual({
      ...legacy,
      schemaVersion: "chat-product-store.v20",
      entities: {
        ...legacy.entities,
        toolExecutionIntents: {},
        toolExecutionDecisions: {},
        toolExecutionResults: {},
      },
    });
    await JsonProductStore.open({ filePath, now: () => NOW });
    expect(await readFile(filePath, "utf8")).toBe(once);
  });

  it("v18严格拒绝新增的Project Bootstrap执行Outbox kind", async () => {
    const snapshot = await seededV18();
    const raw = structuredClone(snapshot) as unknown as {
      outbox: Record<string, unknown>;
    };
    raw.outbox["obx_v19only1"] = {
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
        ...raw,
        schemaVersion: "chat-product-store.v18",
      }).success,
    ).toBe(false);
  });
});
