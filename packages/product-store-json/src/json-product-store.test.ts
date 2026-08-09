import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createEmptySnapshot,
  productSnapshotSchema,
  type CommandId,
  type ProductSession,
  type ProductSnapshot,
  type TraceEventInput,
} from "@chat/contracts";
import {
  compilePlanningInput,
  computePlanSha256,
  createProductSession,
  publishPlanForReview,
  submitUserMessage,
  CommandIdReusedError,
  StoreCorruptedError,
  type ApplicationDeps,
  type IdFactory,
} from "@chat/application";
import {
  computeContextPackageSha256,
  computeMemoryBackendDescriptorSha256,
  computeMemoryQueryResultSha256,
  computeMemoryResultSnapshotSha256,
  computeRunContextRequestSha256,
  estimateMemorySectionTokens,
  hashCanonical,
} from "@chat/domain";
import { JsonProductStore, type StoreIo } from "./json-product-store.js";
import { migrateProductSnapshotV1ToV2, productSnapshotV1Schema } from "./migrate-v1-to-v2.js";
import { migrateProductSnapshotV2ToV3, productSnapshotV2Schema } from "./migrate-v2-to-v3.js";
import { migrateProductSnapshotV3ToV4 } from "./migrate-v3-to-v4.js";
import { assertSnapshotIntegrity } from "./snapshot-integrity.js";

const NOW = "2026-08-07T12:00:00.000Z";
let clock = 0;
const now = (): string => new Date(Date.parse(NOW) + clock++ * 1000).toISOString();

async function tempStorePath(): Promise<{ dir: string; filePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "chat-store-"));
  return { dir, filePath: join(dir, "chat-product-store.v1.json") };
}

function sessionEntity(id: string): ProductSession {
  return {
    schemaVersion: "product-session.v1",
    sessionId: id as ProductSession["sessionId"],
    ownerPrincipalId: "usr_debug" as ProductSession["ownerPrincipalId"],
    status: "active",
    lastMessageSequence: 0,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function addSessionTransaction(commandId: string, sessionId: string) {
  return {
    commandId: commandId as CommandId,
    commandType: "CreateProductSession",
    requestSha256: "a".repeat(64),
    mutate: (draft: ProductSnapshot) => {
      draft.entities.sessions[sessionId] = sessionEntity(sessionId);
      return { resultRefs: { sessionId } };
    },
  };
}

async function listTempFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.includes(".tmp-"));
}

function legacyEntitiesFrom(snapshot: ProductSnapshot) {
  const entities = snapshot.entities;
  return {
    sessions: entities.sessions,
    messages: entities.messages,
    runs: entities.runs,
    attempts: entities.attempts,
    plans: entities.plans,
    revisionInputs: entities.revisionInputs,
    approvalRequests: entities.approvalRequests,
    decisions: entities.decisions,
    executionContracts: entities.executionContracts,
    executionCandidates: entities.executionCandidates,
    validationResults: entities.validationResults,
    artifacts: entities.artifacts,
  };
}

function v2EntitiesFrom(snapshot: ProductSnapshot): Record<string, unknown> {
  const entities = structuredClone(snapshot.entities) as unknown as Record<string, unknown>;
  delete entities["memoryImportIntents"];
  delete entities["memoryImportResults"];
  for (const key of [
    "projects",
    "projectMethodSnapshots",
    "projectStages",
    "projectResources",
    "projectParticipants",
    "projectWorks",
    "projectActions",
    "projectContributions",
    "projectEvidence",
    "projectDecisions",
    "projectObservations",
    "projectCandidates",
  ]) {
    delete entities[key];
  }
  return entities;
}

async function validReviewSnapshot(): Promise<ProductSnapshot> {
  const { filePath } = await tempStorePath();
  const store = await JsonProductStore.open({ filePath, now });
  let id = 0;
  const next = (prefix: string) => `${prefix}_integrity${(++id).toString(36)}`;
  const ids = {
    session: () => next("psn"),
    message: () => next("msg"),
    run: () => next("run"),
    attempt: () => next("att"),
    plan: () => next("pln"),
    planRevision: () => next("plr"),
    revisionInput: () => next("rin"),
    approval: () => next("apr"),
    decision: () => next("dec"),
    executionContract: () => next("exc"),
    executionCandidate: () => next("xcd"),
    validationResult: () => next("val"),
    artifact: () => next("art"),
    outbox: () => next("obx"),
  } as IdFactory;
  const deps: ApplicationDeps = { store, now, ids };
  const { session } = await createProductSession(deps, {
    principalId: "usr_integrity" as never,
    commandId: "cmd_integritysession" as never,
    payload: {},
  });
  const { run } = await submitUserMessage(deps, {
    principalId: "usr_integrity" as never,
    sessionId: session.sessionId,
    commandId: "cmd_integritymessage" as never,
    payload: { text: "生成包含风险与下一步的周报" },
  });
  const planning = await compilePlanningInput(deps, {
    commandId: "cmd_integritycompile" as never,
    productRunId: run.productRunId,
    planRevision: 1,
  });
  await publishPlanForReview(deps, {
    commandId: "cmd_integritypublish" as never,
    productRunId: run.productRunId,
    attemptId: planning.attemptId,
    expectedRunRevision: planning.inputRunRevision,
    inputManifestSha256: planning.inputManifestSha256,
    content: {
      objective: "生成周报",
      summary: "整理进展并输出周报",
      assumptions: [],
      openQuestions: [],
      steps: [
        {
          stepId: "step-1",
          title: "整理",
          purpose: "整理输入",
          dependsOn: [],
          inputRefs: [],
          expectedOutput: "Markdown",
          successCriteria: ["包含风险与下一步"],
          requestedCapabilities: [],
          risk: "low",
        },
      ],
      completionCriteria: ["包含风险与下一步"],
      warnings: [],
    },
  });
  return structuredClone(
    (await store.read({ kind: "committedSnapshot" })).snapshot,
  ) as ProductSnapshot;
}

async function validMemoryReviewSnapshot(): Promise<ProductSnapshot> {
  const snapshot = await validReviewSnapshot();
  const request = Object.values(snapshot.entities.contextRequests)[0];
  const attempt = Object.values(snapshot.entities.attempts).find(
    (candidate) => candidate.kind === "planning",
  );
  const source =
    request === undefined ? undefined : snapshot.entities.messages[request.sourceMessageId];
  if (request === undefined || attempt === undefined || source === undefined) {
    throw new Error("fixture缺少ContextRequest、Planning Attempt或源消息");
  }

  const memory = {
    backendId: "mbk_memmy" as never,
    requirement: "optional" as const,
    tags: ["project"],
    layers: ["L1" as const],
    limit: 3,
    contextBudget: 512,
  };
  request.memory = memory;
  request.sha256 = computeRunContextRequestSha256({
    productRunId: request.productRunId,
    requestedByPrincipalId: request.requestedByPrincipalId,
    sourceMessageId: request.sourceMessageId,
    sourceMessageSha256: request.sourceMessageSha256,
    memory,
  });

  const backendDescriptor = {
    backendId: memory.backendId,
    displayName: "Memmy",
    kind: "memmy" as const,
    adapterContractVersion: "memmy-http-query.v1" as const,
    configured: true,
    authMode: "none" as const,
    credentialRevision: "none" as const,
    configurationFingerprint: "b".repeat(64),
    capabilities: {
      query: true as const,
      tags: true as const,
      layers: ["L1" as const, "L2" as const],
      maxLimit: 5,
      maxContextBudget: 1_024,
    },
  };
  const memoryQueryId = "mqy_integrity1" as never;
  const memoryResultSnapshotId = "mrs_integrity1" as never;
  const contextPackageId = "ctxp_integrity1" as never;
  const completedAt = snapshot.committedAt;
  const section = {
    externalObjectIds: ["memory-1"],
    title: "项目约束",
    kind: "policy" as const,
    memoryLayer: "L1" as const,
    content: "正式结果必须可由产品事实解释。",
    tags: ["project"],
  };
  const tokenEstimate = estimateMemorySectionTokens(section);
  const sectionWithToken = { ...section, tokenEstimate };
  const resultSetSha256 = computeMemoryQueryResultSha256({
    externalQueryId: "memmy-query-1",
    hitCount: 1,
    tokenEstimate,
    sections: [sectionWithToken],
  });
  snapshot.entities.memoryQueries[memoryQueryId] = {
    schemaVersion: "memory-query.v1",
    memoryQueryId,
    contextRequestId: request.contextRequestId,
    productRunId: request.productRunId,
    planRevision: 1,
    backendId: memory.backendId,
    backendDescriptor,
    backendDescriptorSha256: computeMemoryBackendDescriptorSha256(backendDescriptor),
    requirement: memory.requirement,
    sourceMessageSha256: request.sourceMessageSha256,
    tags: memory.tags,
    layers: memory.layers,
    limit: memory.limit,
    contextBudget: memory.contextBudget,
    status: "completed",
    startedAt: request.createdAt,
    externalQueryId: "memmy-query-1",
    hitCount: 1,
    adoptedCount: 1,
    tokenEstimate,
    resultSetSha256,
    completedAt,
    revision: 2,
    createdAt: request.createdAt,
    updatedAt: completedAt,
  };
  const memorySnapshotShape = {
    backendId: memory.backendId,
    ...sectionWithToken,
  };
  const memorySnapshotSha256 = computeMemoryResultSnapshotSha256(memorySnapshotShape);
  snapshot.entities.memoryResultSnapshots[memoryResultSnapshotId] = {
    schemaVersion: "memory-result-snapshot.v1",
    memoryResultSnapshotId,
    memoryQueryId,
    ...memorySnapshotShape,
    sha256: memorySnapshotSha256,
    revision: 1,
    createdAt: completedAt,
    updatedAt: completedAt,
  };
  const packageShape = {
    contextRequestId: request.contextRequestId,
    productRunId: request.productRunId,
    assembledForPlanRevision: 1,
    purpose: "planning" as const,
    memoryQueryId,
    items: [
      {
        kind: "memory_snapshot" as const,
        memoryResultSnapshotId,
        revision: 1,
        sha256: memorySnapshotSha256,
        selection: "retrieved" as const,
        reasonCode: "within_budget" as const,
      },
    ],
    exclusions: [],
  };
  const contextPackageSha256 = computeContextPackageSha256(packageShape);
  snapshot.entities.contextPackages[contextPackageId] = {
    schemaVersion: "context-package.v1",
    contextPackageId,
    ...packageShape,
    sha256: contextPackageSha256,
    revision: 1,
    createdAt: completedAt,
    updatedAt: completedAt,
  };
  snapshot.entities.memoryAdoptions["mad_integrity1"] = {
    schemaVersion: "memory-adoption.v1",
    memoryAdoptionId: "mad_integrity1" as never,
    productRunId: request.productRunId,
    contextPackageId,
    memoryResultSnapshotId,
    status: "adopted",
    reasonCode: "within_budget",
    revision: 1,
    createdAt: completedAt,
    updatedAt: completedAt,
  };

  attempt.contextPackageId = contextPackageId;
  attempt.contextPackageSha256 = contextPackageSha256;
  attempt.inputManifestSha256 = hashCanonical("planning-input-manifest.v2", {
    productRunId: attempt.productRunId,
    planRevision: attempt.planRevision,
    sourceMessageRef: { messageId: source.messageId, sha256: attempt.sourceMessageSha256 },
    contextPackageRef: {
      contextPackageId,
      revision: 1,
      sha256: contextPackageSha256,
    },
    promptTemplateVersion: attempt.promptTemplateVersion,
    modelConfigVersion: attempt.modelConfigVersion,
  });
  assertSnapshotIntegrity(snapshot);
  return snapshot;
}

function requiredMemoryFacts(snapshot: ProductSnapshot) {
  const request = Object.values(snapshot.entities.contextRequests)[0];
  const query = Object.values(snapshot.entities.memoryQueries)[0];
  const memorySnapshot = Object.values(snapshot.entities.memoryResultSnapshots)[0];
  const contextPackage = Object.values(snapshot.entities.contextPackages)[0];
  const adoption = Object.values(snapshot.entities.memoryAdoptions)[0];
  if (
    request === undefined ||
    query === undefined ||
    memorySnapshot === undefined ||
    contextPackage === undefined ||
    adoption === undefined
  ) {
    throw new Error("fixture缺少完整Memory事实");
  }
  return { request, query, memorySnapshot, contextPackage, adoption };
}

async function expectSnapshotOpenFailure(snapshot: ProductSnapshot): Promise<void> {
  const { filePath } = await tempStorePath();
  await writeFile(filePath, JSON.stringify(snapshot, null, 2));
  await expect(JsonProductStore.open({ filePath, now })).rejects.toBeInstanceOf(
    StoreCorruptedError,
  );
}

describe("JsonProductStore 原子提交与重启恢复", () => {
  it("文件不存在时创建创世快照并持久化", async () => {
    const { filePath } = await tempStorePath();
    const store = await JsonProductStore.open({ filePath, now });
    const { snapshot } = await store.read({ kind: "committedSnapshot" });
    expect(snapshot.storeRevision).toBe(0);

    const onDisk = productSnapshotSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
    expect(onDisk.schemaVersion).toBe("chat-product-store.v4");
  });

  it("非空v1真实快照串行迁移到v4，保留旧事实并合成no-memory ContextRequest，重启幂等", async () => {
    const { filePath } = await tempStorePath();
    const current = await validReviewSnapshot();
    const legacy = productSnapshotV1Schema.parse({
      ...current,
      schemaVersion: "chat-product-store.v1",
      entities: legacyEntitiesFrom(current),
    });
    const before = JSON.stringify(legacy, null, 2);
    await writeFile(filePath, before);

    const store = await JsonProductStore.open({ filePath, now });
    const { snapshot } = await store.read({ kind: "committedSnapshot" });
    expect(snapshot.schemaVersion).toBe("chat-product-store.v4");
    expect(snapshot.storeRevision).toBe(legacy.storeRevision);
    expect(snapshot.commandReceipts).toEqual(legacy.commandReceipts);
    expect(snapshot.outbox).toEqual(legacy.outbox);
    expect(legacyEntitiesFrom(snapshot)).toEqual(legacy.entities);
    const runs = Object.values(legacy.entities.runs);
    expect(runs.length).toBeGreaterThan(0);
    expect(Object.values(snapshot.entities.contextRequests)).toHaveLength(runs.length);
    for (const run of runs) {
      const requests = Object.values(snapshot.entities.contextRequests).filter(
        (request) => request.productRunId === run.productRunId,
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]?.memory).toBeUndefined();
      expect(requests[0]?.createdAt).toBe(legacy.committedAt);
      expect(requests[0]?.updatedAt).toBe(legacy.committedAt);
    }
    expect(snapshot.entities.memoryQueries).toEqual({});
    expect(snapshot.entities.memoryResultSnapshots).toEqual({});
    expect(snapshot.entities.memoryAdoptions).toEqual({});
    expect(snapshot.entities.contextPackages).toEqual({});
    expect(snapshot.entities.memoryImportIntents).toEqual({});
    expect(snapshot.entities.memoryImportResults).toEqual({});
    expect(snapshot.entities.projects).toEqual({});
    expect(snapshot.entities.projectCandidates).toEqual({});
    const expectedMigration = migrateProductSnapshotV3ToV4(
      migrateProductSnapshotV2ToV3(migrateProductSnapshotV1ToV2(legacy)),
    );
    expect(snapshot).toEqual(expectedMigration);
    expect(
      migrateProductSnapshotV3ToV4(
        migrateProductSnapshotV2ToV3(migrateProductSnapshotV1ToV2(legacy)),
      ),
    ).toEqual(expectedMigration);
    const once = await readFile(filePath, "utf8");
    expect(once).not.toBe(before);

    await JsonProductStore.open({ filePath, now });
    expect(await readFile(filePath, "utf8")).toBe(once);
  });

  it("非空v2 M1快照直接迁移到v4，逐对象保留Memory事实且重启不重复迁移", async () => {
    const { filePath } = await tempStorePath();
    const current = await validMemoryReviewSnapshot();
    const legacy = productSnapshotV2Schema.parse({
      ...current,
      schemaVersion: "chat-product-store.v2",
      entities: v2EntitiesFrom(current),
    });
    const before = JSON.stringify(legacy, null, 2);
    await writeFile(filePath, before);

    const opened = await JsonProductStore.open({ filePath, now });
    const { snapshot } = await opened.read({ kind: "committedSnapshot" });
    expect(snapshot.schemaVersion).toBe("chat-product-store.v4");
    expect(snapshot.entities.memoryQueries).toEqual(legacy.entities.memoryQueries);
    expect(snapshot.entities.memoryResultSnapshots).toEqual(legacy.entities.memoryResultSnapshots);
    expect(snapshot.entities.memoryAdoptions).toEqual(legacy.entities.memoryAdoptions);
    expect(snapshot.entities.contextPackages).toEqual(legacy.entities.contextPackages);
    expect(snapshot.entities.memoryImportIntents).toEqual({});
    expect(snapshot.entities.memoryImportResults).toEqual({});
    expect(snapshot).toEqual(migrateProductSnapshotV3ToV4(migrateProductSnapshotV2ToV3(legacy)));
    const migratedBytes = await readFile(filePath, "utf8");
    expect(migratedBytes).not.toBe(before);
    await JsonProductStore.open({ filePath, now });
    expect(await readFile(filePath, "utf8")).toBe(migratedBytes);
  });

  it("损坏v2和v2迁移写入故障都失败关闭且保留原文件", async () => {
    const { filePath } = await tempStorePath();
    const current = await validMemoryReviewSnapshot();
    const validV2 = productSnapshotV2Schema.parse({
      ...current,
      schemaVersion: "chat-product-store.v2",
      entities: v2EntitiesFrom(current),
    });
    const damaged = structuredClone(validV2) as unknown as Record<string, unknown>;
    (damaged["entities"] as Record<string, unknown>)["memoryQueries"] = {
      mqy_dangling: { broken: true },
    };
    const damagedBytes = JSON.stringify(damaged, null, 2);
    await writeFile(filePath, damagedBytes);
    await expect(JsonProductStore.open({ filePath, now })).rejects.toBeInstanceOf(
      StoreCorruptedError,
    );
    expect(await readFile(filePath, "utf8")).toBe(damagedBytes);

    const { filePath: ioFile } = await tempStorePath();
    const validBytes = JSON.stringify(validV2, null, 2);
    await writeFile(ioFile, validBytes);
    await expect(
      JsonProductStore.open({
        filePath: ioFile,
        now,
        io: { writeTempFile: async () => Promise.reject(new Error("v2 migration write failed")) },
      }),
    ).rejects.toThrow("Product Store提交在atomic rename前失败，可用同一commandId安全重试");
    expect(await readFile(ioFile, "utf8")).toBe(validBytes);
  });

  it("v1迁移在atomic rename前失败时原文件逐字节不变", async () => {
    const { filePath } = await tempStorePath();
    const current = createEmptySnapshot(NOW);
    const before = JSON.stringify(
      productSnapshotV1Schema.parse({
        ...current,
        schemaVersion: "chat-product-store.v1",
        entities: legacyEntitiesFrom(current),
      }),
      null,
      2,
    );
    await writeFile(filePath, before);
    await expect(
      JsonProductStore.open({
        filePath,
        now,
        io: { writeTempFile: async () => Promise.reject(new Error("migration write failed")) },
      }),
    ).rejects.toThrow();
    expect(await readFile(filePath, "utf8")).toBe(before);
  });

  it("transact原子提交并可跨重启读取", async () => {
    const { filePath } = await tempStorePath();
    const store = await JsonProductStore.open({ filePath, now });
    const result = await store.transact(addSessionTransaction("cmd_1", "psn_1"));
    expect(result.replayed).toBe(false);
    expect(result.storeRevision).toBe(1);

    const reopened = await JsonProductStore.open({ filePath, now });
    const { snapshot } = await reopened.read({ kind: "committedSnapshot" });
    expect(snapshot.storeRevision).toBe(1);
    expect(snapshot.entities.sessions["psn_1"]?.sessionId).toBe("psn_1");
    expect(snapshot.commandReceipts["cmd_1"]?.committedStoreRevision).toBe(1);
  });

  it("快照文件权限为0600", async () => {
    const { filePath } = await tempStorePath();
    await JsonProductStore.open({ filePath, now });
    const mode = (await stat(filePath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("同一commandId + 相同请求Hash返回原结果，mutate不再次运行", async () => {
    const { filePath } = await tempStorePath();
    const store = await JsonProductStore.open({ filePath, now });
    let mutateCalls = 0;
    const tx = {
      commandId: "cmd_9" as CommandId,
      commandType: "CreateProductSession",
      requestSha256: "b".repeat(64),
      mutate: (draft: ProductSnapshot) => {
        mutateCalls += 1;
        draft.entities.sessions["psn_9"] = sessionEntity("psn_9");
        return { resultRefs: { sessionId: "psn_9" } };
      },
    };
    const first = await store.transact(tx);
    const second = await store.transact(tx);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.resultRefs).toEqual(first.resultRefs);
    expect(mutateCalls).toBe(1);
    const { snapshot } = await store.read({ kind: "committedSnapshot" });
    expect(Object.keys(snapshot.entities.sessions)).toHaveLength(1);
  });

  it("事务Trace只记录真实执行，幂等重放不重复计数且不含正文", async () => {
    const { filePath } = await tempStorePath();
    const events: TraceEventInput[] = [];
    const store = await JsonProductStore.open({
      filePath,
      now,
      trace: (event) => events.push(event),
    });
    const transaction = {
      ...addSessionTransaction("cmd_trace", "psn_trace"),
      traceContext: { productSessionId: "psn_trace" as never },
    };
    await store.transact(transaction);
    await store.transact(transaction);

    expect(events.map((event) => event.eventName)).toEqual([
      "product.transaction.started",
      "product.transaction.committed",
    ]);
    expect(JSON.stringify(events)).not.toContain("PRODUCT_CONTENT_MUST_NEVER_BE_WRITTEN");
  });

  it("事务失败记录稳定错误而不提交Receipt", async () => {
    const { filePath } = await tempStorePath();
    const events: TraceEventInput[] = [];
    const store = await JsonProductStore.open({
      filePath,
      now,
      trace: (event) => events.push(event),
    });
    await expect(
      store.transact({
        commandId: "cmd_tracefail" as CommandId,
        commandType: "CreateProductSession",
        requestSha256: "a".repeat(64),
        mutate: () => {
          throw new Error("PRODUCT_CONTENT_MUST_NEVER_BE_WRITTEN");
        },
      }),
    ).rejects.toThrow();
    expect(events.map((event) => event.eventName)).toEqual([
      "product.transaction.started",
      "product.transaction.failed",
    ]);
    expect(JSON.stringify(events)).not.toContain("PRODUCT_CONTENT_MUST_NEVER_BE_WRITTEN");
  });

  it("同一commandId + 不同请求Hash抛出CommandIdReusedError", async () => {
    const { filePath } = await tempStorePath();
    const store = await JsonProductStore.open({ filePath, now });
    await store.transact(addSessionTransaction("cmd_1", "psn_1"));
    const conflicting = {
      ...addSessionTransaction("cmd_1", "psn_2"),
      requestSha256: "f".repeat(64),
    };
    await expect(store.transact(conflicting)).rejects.toBeInstanceOf(CommandIdReusedError);
    const { snapshot } = await store.read({ kind: "committedSnapshot" });
    expect(snapshot.entities.sessions["psn_2"]).toBeUndefined();
  });

  it("并发transact按单写队列序列化，storeRevision连续递增", async () => {
    const { filePath } = await tempStorePath();
    const store = await JsonProductStore.open({ filePath, now });
    const results = await Promise.all([
      store.transact(addSessionTransaction("cmd_a", "psn_a")),
      store.transact(addSessionTransaction("cmd_b", "psn_b")),
      store.transact(addSessionTransaction("cmd_c", "psn_c")),
    ]);
    const revisions = results.map((result) => result.storeRevision).sort();
    expect(revisions).toEqual([1, 2, 3]);
    const { snapshot } = await store.read({ kind: "committedSnapshot" });
    expect(Object.keys(snapshot.entities.sessions)).toHaveLength(3);
  });

  it("read返回防御性副本，调用方不能绕过事务修改内存权威快照", async () => {
    const { filePath } = await tempStorePath();
    const store = await JsonProductStore.open({ filePath, now });
    const first = await store.read({ kind: "committedSnapshot" });
    first.snapshot.entities.sessions["psn_injected"] = sessionEntity("psn_injected");

    const second = await store.read({ kind: "committedSnapshot" });
    expect(second.snapshot.entities.sessions["psn_injected"]).toBeUndefined();
    expect(second.snapshot.storeRevision).toBe(0);
  });

  it("mutate抛错时不写入任何内容", async () => {
    const { filePath } = await tempStorePath();
    const store = await JsonProductStore.open({ filePath, now });
    const before = await readFile(filePath, "utf8");
    await expect(
      store.transact({
        commandId: "cmd_x" as CommandId,
        commandType: "Broken",
        requestSha256: "c".repeat(64),
        mutate: () => {
          throw new Error("business failure");
        },
      }),
    ).rejects.toThrow("business failure");
    expect(await readFile(filePath, "utf8")).toBe(before);
    const { snapshot } = await store.read({ kind: "committedSnapshot" });
    expect(snapshot.storeRevision).toBe(0);
    expect(snapshot.commandReceipts["cmd_x"]).toBeUndefined();
  });
});

describe("JsonProductStore 损坏与失败注入", () => {
  it("rename后目录fsync失败会熔断实例，禁止旧内存覆盖已rename的提交", async () => {
    const { filePath } = await tempStorePath();
    await JsonProductStore.open({ filePath, now });
    let directorySyncCalls = 0;
    const store = await JsonProductStore.open({
      filePath,
      now,
      io: {
        fsyncParentDirectory: async () => {
          directorySyncCalls += 1;
          if (directorySyncCalls === 2) throw new Error("post-rename fsync failed");
        },
      },
    });

    await expect(
      store.transact(addSessionTransaction("cmd_first", "psn_first")),
    ).rejects.toBeInstanceOf(StoreCorruptedError);
    await expect(store.read({ kind: "committedSnapshot" })).rejects.toBeInstanceOf(
      StoreCorruptedError,
    );
    await expect(
      store.transact(addSessionTransaction("cmd_second", "psn_second")),
    ).rejects.toBeInstanceOf(StoreCorruptedError);

    const reopened = await JsonProductStore.open({ filePath, now });
    const { snapshot } = await reopened.read({ kind: "committedSnapshot" });
    expect(snapshot.entities.sessions["psn_first"]).toBeDefined();
    expect(snapshot.entities.sessions["psn_second"]).toBeUndefined();
  });

  it.each([
    [
      "临时文件写入",
      {
        writeTempFile: async () => Promise.reject(new Error("disk full")),
      } satisfies Partial<StoreIo>,
    ],
    [
      "临时文件fsync",
      {
        fsyncTempFile: async () => Promise.reject(new Error("fsync failed")),
      } satisfies Partial<StoreIo>,
    ],
    [
      "父目录fsync",
      {
        fsyncParentDirectory: async () => Promise.reject(new Error("dir fsync failed")),
      } satisfies Partial<StoreIo>,
    ],
    [
      "rename",
      {
        renameTempFile: async () => Promise.reject(new Error("rename failed")),
      } satisfies Partial<StoreIo>,
    ],
  ])("%s失败时旧快照逐字节不变，内存仍指向旧快照", async (_label, ioOverride) => {
    const { dir, filePath } = await tempStorePath();
    await JsonProductStore.open({ filePath, now });
    await writeFile(filePath, JSON.stringify(createEmptySnapshot(NOW), null, 2));
    const store = await JsonProductStore.open({ filePath, now, io: ioOverride });
    const before = await readFile(filePath, "utf8");

    await expect(store.transact(addSessionTransaction("cmd_1", "psn_1"))).rejects.toThrow();

    expect(await readFile(filePath, "utf8")).toBe(before);
    const { snapshot } = await store.read({ kind: "committedSnapshot" });
    expect(snapshot.storeRevision).toBe(0);
    expect(snapshot.entities.sessions["psn_1"]).toBeUndefined();
    // 孤立临时文件被隔离保留供诊断，不被误当正式快照
    void dir;
  });

  it("写失败产生的孤立临时文件不影响open，也不被静默删除", async () => {
    const { dir, filePath } = await tempStorePath();
    await JsonProductStore.open({ filePath, now });
    const store = await JsonProductStore.open({
      filePath,
      now,
      io: { fsyncTempFile: async () => Promise.reject(new Error("fsync failed")) },
    });
    await expect(store.transact(addSessionTransaction("cmd_1", "psn_1"))).rejects.toThrow();
    expect((await listTempFiles(dir)).length).toBeGreaterThan(0);

    const reopened = await JsonProductStore.open({ filePath, now });
    const { snapshot } = await reopened.read({ kind: "committedSnapshot" });
    expect(snapshot.storeRevision).toBe(0);
    expect((await listTempFiles(dir)).length).toBeGreaterThan(0);
  });

  it("截断JSON启动失败关闭，原文件逐字节不变", async () => {
    const { filePath } = await tempStorePath();
    await JsonProductStore.open({ filePath, now });
    const original = await readFile(filePath, "utf8");
    await writeFile(filePath, original.slice(0, original.length - 20));
    const corrupted = await readFile(filePath, "utf8");
    await expect(JsonProductStore.open({ filePath, now })).rejects.toBeInstanceOf(
      StoreCorruptedError,
    );
    expect(await readFile(filePath, "utf8")).toBe(corrupted);
  });

  it("未知Schema版本启动失败关闭", async () => {
    const { filePath } = await tempStorePath();
    await JsonProductStore.open({ filePath, now });
    const snapshot = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    snapshot["schemaVersion"] = "chat-product-store.v999";
    await writeFile(filePath, JSON.stringify(snapshot));
    await expect(JsonProductStore.open({ filePath, now })).rejects.toBeInstanceOf(
      StoreCorruptedError,
    );
  });

  it("删除任一已提交Receipt但保留storeRevision时启动失败关闭", async () => {
    const { filePath } = await tempStorePath();
    const store = await JsonProductStore.open({ filePath, now });
    await store.transact(addSessionTransaction("cmd_receipt", "psn_receipt"));
    const snapshot = JSON.parse(await readFile(filePath, "utf8")) as ProductSnapshot;
    delete snapshot.commandReceipts["cmd_receipt" as CommandId];
    await writeFile(filePath, JSON.stringify(snapshot));

    await expect(JsonProductStore.open({ filePath, now })).rejects.toBeInstanceOf(
      StoreCorruptedError,
    );
  });

  it("悬空引用启动失败关闭", async () => {
    const { filePath } = await tempStorePath();
    const store = await JsonProductStore.open({ filePath, now });
    await store.transact(addSessionTransaction("cmd_1", "psn_1"));
    const snapshot = JSON.parse(await readFile(filePath, "utf8")) as ProductSnapshot;
    snapshot.entities.messages["msg_1"] = {
      schemaVersion: "message.v1",
      messageId: "msg_1" as never,
      sessionId: "psn_missing" as never,
      sessionSequence: 1,
      role: "user",
      content: { format: "markdown", text: "hi" },
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    await writeFile(filePath, JSON.stringify(snapshot));
    await expect(JsonProductStore.open({ filePath, now })).rejects.toBeInstanceOf(
      StoreCorruptedError,
    );
  });

  it("Plan Hash不一致启动失败关闭", async () => {
    const { filePath } = await tempStorePath();
    const store = await JsonProductStore.open({ filePath, now });
    await store.transact({
      commandId: "cmd_1" as CommandId,
      commandType: "CompilePlanningInput",
      requestSha256: "d".repeat(64),
      mutate: (draft) => {
        draft.entities.sessions["psn_1"] = {
          ...sessionEntity("psn_1"),
          lastMessageSequence: 1,
        };
        const content = {
          objective: "o",
          summary: "s",
          assumptions: [],
          openQuestions: [],
          steps: [
            {
              stepId: "s1",
              title: "t",
              purpose: "p",
              dependsOn: [],
              inputRefs: [],
              expectedOutput: "e",
              successCriteria: ["c"],
              requestedCapabilities: [],
              risk: "low" as const,
            },
          ],
          completionCriteria: ["done"],
          warnings: [],
        };
        draft.entities.runs["run_1"] = {
          schemaVersion: "product-run.v1",
          productRunId: "run_1" as never,
          sessionId: "psn_1" as never,
          sourceMessageId: "msg_1" as never,
          status: "running",
          phase: "planning",
          currentPlanId: "pln_1" as never,
          currentPlanRevision: 1,
          maxPlanRevisions: 5,
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        };
        draft.entities.messages["msg_1"] = {
          schemaVersion: "message.v1",
          messageId: "msg_1" as never,
          sessionId: "psn_1" as never,
          sessionSequence: 1,
          role: "user",
          content: { format: "markdown", text: "hi" },
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        };
        const sourceMessageSha256 = hashCanonical("message.v1", {
          messageId: "msg_1",
          sessionId: "psn_1",
          sessionSequence: 1,
          role: "user",
          content: { format: "markdown", text: "hi" },
        });
        const contextRequestShape = {
          productRunId: "run_1" as never,
          requestedByPrincipalId: "usr_debug" as never,
          sourceMessageId: "msg_1" as never,
          sourceMessageSha256,
        };
        draft.entities.contextRequests["ctxr_1"] = {
          schemaVersion: "run-context-request.v1",
          contextRequestId: "ctxr_1" as never,
          ...contextRequestShape,
          sha256: computeRunContextRequestSha256(contextRequestShape),
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        };
        const inputManifestSha256 = hashCanonical("planning-input-manifest.v1", {
          productRunId: "run_1",
          planRevision: 1,
          sourceMessageRef: { messageId: "msg_1", sha256: sourceMessageSha256 },
          promptTemplateVersion: "planner-prompt.v1",
          modelConfigVersion: "bailian.qwen3.7-plus.v1",
        });
        draft.entities.attempts["att_1"] = {
          schemaVersion: "run-attempt.v1",
          attemptId: "att_1" as never,
          productRunId: "run_1" as never,
          kind: "planning",
          planRevision: 1,
          inputRunRevision: 1,
          sourceMessageSha256,
          inputManifestSha256,
          promptTemplateVersion: "planner-prompt.v1",
          modelConfigVersion: "bailian.qwen3.7-plus.v1",
          outcome: "success",
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        };
        draft.entities.attempts["att_workflow"] = {
          schemaVersion: "run-attempt.v1",
          attemptId: "att_workflow" as never,
          productRunId: "run_1" as never,
          kind: "workflow",
          outcome: "running",
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        };
        draft.entities.plans["plr_1"] = {
          schemaVersion: "plan-revision.v1",
          planRevisionId: "plr_1" as never,
          planId: "pln_1" as never,
          productRunId: "run_1" as never,
          planningAttemptId: "att_1" as never,
          planRevision: 1,
          status: "superseded",
          content,
          sha256: computePlanSha256({
            planId: "pln_1",
            productRunId: "run_1",
            planRevision: 1,
            content,
          }),
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        };
        return { resultRefs: { attemptId: "att_1", productRunId: "run_1" } };
      },
    });
    // 篡改持久化的Plan Hash
    const snapshot = JSON.parse(await readFile(filePath, "utf8")) as ProductSnapshot;
    const plan = snapshot.entities.plans["plr_1"];
    expect(plan).toBeDefined();
    if (plan !== undefined) plan.sha256 = "0".repeat(64);
    await writeFile(filePath, JSON.stringify(snapshot));
    await expect(JsonProductStore.open({ filePath, now })).rejects.toBeInstanceOf(
      StoreCorruptedError,
    );
  });
});

describe("Product Snapshot跨对象完整性", () => {
  it.each([
    [
      "Map键与实体ID不一致",
      (snapshot: ProductSnapshot) => {
        const session = Object.values(snapshot.entities.sessions)[0];
        if (session === undefined) throw new Error("fixture缺少session");
        delete snapshot.entities.sessions[session.sessionId];
        snapshot.entities.sessions["psn_wrongkey"] = session;
      },
    ],
    [
      "Run status/phase组合非法",
      (snapshot: ProductSnapshot) => {
        const run = Object.values(snapshot.entities.runs)[0];
        if (run === undefined) throw new Error("fixture缺少run");
        snapshot.entities.runs[run.productRunId] = { ...run, phase: "completed" };
      },
    ],
    [
      "Session消息序号账本不一致",
      (snapshot: ProductSnapshot) => {
        const session = Object.values(snapshot.entities.sessions)[0];
        if (session === undefined) throw new Error("fixture缺少session");
        snapshot.entities.sessions[session.sessionId] = { ...session, lastMessageSequence: 99 };
      },
    ],
    [
      "Planning输入Manifest被篡改",
      (snapshot: ProductSnapshot) => {
        const attempt = Object.values(snapshot.entities.attempts).find(
          (candidate) => candidate.kind === "planning",
        );
        if (attempt === undefined) throw new Error("fixture缺少planning attempt");
        snapshot.entities.attempts[attempt.attemptId] = {
          ...attempt,
          inputManifestSha256: "0".repeat(64),
        };
      },
    ],
    [
      "Plan绑定错误Attempt",
      (snapshot: ProductSnapshot) => {
        const plan = Object.values(snapshot.entities.plans)[0];
        const workflowAttempt = Object.values(snapshot.entities.attempts).find(
          (candidate) => candidate.kind === "workflow",
        );
        if (plan === undefined || workflowAttempt === undefined) throw new Error("fixture不完整");
        snapshot.entities.plans[plan.planRevisionId] = {
          ...plan,
          planningAttemptId: workflowAttempt.attemptId,
        };
      },
    ],
    [
      "Approval与Plan Hash不一致",
      (snapshot: ProductSnapshot) => {
        const approval = Object.values(snapshot.entities.approvalRequests)[0];
        if (approval === undefined) throw new Error("fixture缺少approval");
        snapshot.entities.approvalRequests[approval.approvalRequestId] = {
          ...approval,
          planSha256: "0".repeat(64),
        };
      },
    ],
    [
      "waiting_human丢失活动Approval引用",
      (snapshot: ProductSnapshot) => {
        const run = Object.values(snapshot.entities.runs)[0];
        if (run === undefined) throw new Error("fixture缺少run");
        const broken = { ...run };
        delete broken.currentApprovalRequestId;
        snapshot.entities.runs[run.productRunId] = broken;
      },
    ],
  ])("拒绝%s", async (_label, corrupt) => {
    const snapshot = await validReviewSnapshot();
    corrupt(snapshot);
    expect(() => assertSnapshotIntegrity(snapshot)).toThrow(StoreCorruptedError);
  });
});

describe("M1 Context持久化完整性", () => {
  it("接受完整的Memory Query→Snapshot→Package→Adoption双向事实链", async () => {
    const snapshot = await validMemoryReviewSnapshot();
    expect(() => assertSnapshotIntegrity(snapshot)).not.toThrow();
    const parsed = productSnapshotSchema.safeParse(snapshot);
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
  });

  it.each([
    [
      "同一Run出现重复ContextRequest",
      (snapshot: ProductSnapshot) => {
        const { request } = requiredMemoryFacts(snapshot);
        snapshot.entities.contextRequests["ctxr_duplicate"] = {
          ...request,
          contextRequestId: "ctxr_duplicate" as never,
        };
      },
    ],
    [
      "no-memory ContextRequest仍存在Query",
      (snapshot: ProductSnapshot) => {
        const { request } = requiredMemoryFacts(snapshot);
        delete request.memory;
        request.sha256 = computeRunContextRequestSha256({
          productRunId: request.productRunId,
          requestedByPrincipalId: request.requestedByPrincipalId,
          sourceMessageId: request.sourceMessageId,
          sourceMessageSha256: request.sourceMessageSha256,
        });
      },
    ],
    [
      "同一ContextRequest出现重复Query",
      (snapshot: ProductSnapshot) => {
        const { query } = requiredMemoryFacts(snapshot);
        snapshot.entities.memoryQueries["mqy_duplicate"] = {
          ...query,
          memoryQueryId: "mqy_duplicate" as never,
        };
      },
    ],
    [
      "后端descriptor未覆盖选择的Layer",
      (snapshot: ProductSnapshot) => {
        const { query } = requiredMemoryFacts(snapshot);
        query.backendDescriptor.capabilities.layers = ["L2"];
        query.backendDescriptorSha256 = computeMemoryBackendDescriptorSha256(
          query.backendDescriptor,
        );
      },
    ],
    [
      "查询limit超过descriptor最大值",
      (snapshot: ProductSnapshot) => {
        const { query } = requiredMemoryFacts(snapshot);
        query.backendDescriptor.capabilities.maxLimit = query.limit - 1;
        query.backendDescriptorSha256 = computeMemoryBackendDescriptorSha256(
          query.backendDescriptor,
        );
      },
    ],
    [
      "查询tokenBudget超过descriptor最大值",
      (snapshot: ProductSnapshot) => {
        const { query } = requiredMemoryFacts(snapshot);
        query.backendDescriptor.capabilities.maxContextBudget = query.contextBudget - 1;
        query.backendDescriptorSha256 = computeMemoryBackendDescriptorSha256(
          query.backendDescriptor,
        );
      },
    ],
    [
      "ContextRequest不可变时间戳被改写",
      (snapshot: ProductSnapshot) => {
        const { request } = requiredMemoryFacts(snapshot);
        request.updatedAt = snapshot.committedAt;
        if (request.updatedAt === request.createdAt) {
          request.updatedAt = new Date(Date.parse(request.createdAt) + 1_000).toISOString();
        }
      },
    ],
    [
      "MemorySnapshot不可变时间戳被改写",
      (snapshot: ProductSnapshot) => {
        const { memorySnapshot } = requiredMemoryFacts(snapshot);
        memorySnapshot.updatedAt = new Date(
          Date.parse(memorySnapshot.createdAt) + 1_000,
        ).toISOString();
      },
    ],
    [
      "ContextPackage不可变时间戳被改写",
      (snapshot: ProductSnapshot) => {
        const { contextPackage } = requiredMemoryFacts(snapshot);
        contextPackage.updatedAt = new Date(
          Date.parse(contextPackage.createdAt) + 1_000,
        ).toISOString();
      },
    ],
    [
      "MemoryAdoption不可变时间戳被改写",
      (snapshot: ProductSnapshot) => {
        const { adoption } = requiredMemoryFacts(snapshot);
        adoption.updatedAt = new Date(Date.parse(adoption.createdAt) + 1_000).toISOString();
      },
    ],
    [
      "terminal Query的updatedAt不等于completedAt",
      (snapshot: ProductSnapshot) => {
        const { query } = requiredMemoryFacts(snapshot);
        query.updatedAt = query.createdAt;
      },
    ],
    [
      "MemorySnapshot悬空Query",
      (snapshot: ProductSnapshot) => {
        const { memorySnapshot } = requiredMemoryFacts(snapshot);
        memorySnapshot.memoryQueryId = "mqy_missing" as never;
      },
    ],
    [
      "ContextPackage悬空ContextRequest",
      (snapshot: ProductSnapshot) => {
        const { contextPackage } = requiredMemoryFacts(snapshot);
        contextPackage.contextRequestId = "ctxr_missing" as never;
      },
    ],
    [
      "重复MemoryAdoption",
      (snapshot: ProductSnapshot) => {
        const { adoption } = requiredMemoryFacts(snapshot);
        snapshot.entities.memoryAdoptions["mad_duplicate"] = {
          ...adoption,
          memoryAdoptionId: "mad_duplicate" as never,
        };
      },
    ],
    [
      "MemorySnapshot Hash被篡改",
      (snapshot: ProductSnapshot) => {
        const { memorySnapshot } = requiredMemoryFacts(snapshot);
        memorySnapshot.sha256 = "0".repeat(64);
      },
    ],
    [
      "ContextPackage Hash被篡改",
      (snapshot: ProductSnapshot) => {
        const { contextPackage } = requiredMemoryFacts(snapshot);
        contextPackage.sha256 = "0".repeat(64);
      },
    ],
    [
      "Query resultSet Hash被篡改",
      (snapshot: ProductSnapshot) => {
        const { query } = requiredMemoryFacts(snapshot);
        if (query.status !== "completed") throw new Error("fixture Query不是completed");
        query.resultSetSha256 = "0".repeat(64);
      },
    ],
    [
      "Snapshot Token估算被篡改且内容Hash已同步伪造",
      (snapshot: ProductSnapshot) => {
        const { memorySnapshot } = requiredMemoryFacts(snapshot);
        memorySnapshot.tokenEstimate = 0;
        memorySnapshot.sha256 = computeMemoryResultSnapshotSha256({
          backendId: memorySnapshot.backendId,
          externalObjectIds: memorySnapshot.externalObjectIds,
          title: memorySnapshot.title,
          kind: memorySnapshot.kind,
          memoryLayer: memorySnapshot.memoryLayer,
          content: memorySnapshot.content,
          tags: memorySnapshot.tags,
          ...(memorySnapshot.score !== undefined ? { score: memorySnapshot.score } : {}),
          tokenEstimate: memorySnapshot.tokenEstimate,
          ...(memorySnapshot.sourceUpdatedAt !== undefined
            ? { sourceUpdatedAt: memorySnapshot.sourceUpdatedAt }
            : {}),
        });
      },
    ],
    [
      "Package丢失导致Query反向基数不成立",
      (snapshot: ProductSnapshot) => {
        const { contextPackage } = requiredMemoryFacts(snapshot);
        delete snapshot.entities.contextPackages[contextPackage.contextPackageId];
      },
    ],
  ])("损坏文件启动失败关闭：%s", async (_label, corrupt) => {
    const snapshot = await validMemoryReviewSnapshot();
    corrupt(snapshot);
    await expectSnapshotOpenFailure(snapshot);
  });

  it.each([
    ["ContextRequest", "contextRequests" as const],
    ["MemorySnapshot", "memoryResultSnapshots" as const],
    ["ContextPackage", "contextPackages" as const],
    ["MemoryAdoption", "memoryAdoptions" as const],
  ])("拒绝%s revision从1被篡改", async (_label, collection) => {
    const snapshot = await validMemoryReviewSnapshot();
    const entity = Object.values(snapshot.entities[collection])[0] as unknown as {
      revision: number;
    };
    entity.revision = 2;
    expect(productSnapshotSchema.safeParse(snapshot).success).toBe(false);
    await expectSnapshotOpenFailure(snapshot);
  });

  it("拒绝completed Query revision从2被篡改为1", async () => {
    const snapshot = await validMemoryReviewSnapshot();
    const { query } = requiredMemoryFacts(snapshot);
    (query as { revision: number }).revision = 1;
    expect(productSnapshotSchema.safeParse(snapshot).success).toBe(false);
    await expectSnapshotOpenFailure(snapshot);
  });
});
