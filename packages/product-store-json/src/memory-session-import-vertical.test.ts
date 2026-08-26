import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createMemorySessionImport,
  getMemorySessionImport,
  loadMemoryWriteForRuntime,
  previewMemorySessionImport,
  type ApplicationDeps,
  type IdFactory,
  type MemorySessionSourceRegistryPort,
  type WorkflowMemoryProviderRegistryPort,
} from "@chat/application";
import type {
  CommandId,
  MemoryBackendId,
  MemoryProviderDescriptor,
  PrincipalId,
} from "@chat/contracts";
import type { NormalizedMemorySessionSnapshot } from "@chat/domain";
import { JsonProductStore } from "./json-product-store.js";
import { assertSnapshotIntegrity } from "./snapshot-integrity.js";

const PRINCIPAL = "usr_sessionimport1" as PrincipalId;
const PROVIDER_ID = "mbk_memmy" as MemoryBackendId;
const CODEX_ID = "019db07f-953c-7fc2-95b6-d38228810e64";
const DESCRIPTOR: MemoryProviderDescriptor = {
  schemaVersion: "memory-provider-descriptor.v1",
  providerId: PROVIDER_ID,
  displayName: "Memmy Session Import测试",
  providerKind: "memmy",
  transport: "http",
  adapterContractVersion: "memmy-workflow.v1",
  configured: true,
  configurationFingerprint: "a".repeat(64) as never,
  capabilities: {
    query: { maxResults: 20, maxContextCharacters: 50_000 },
    write: {
      maxContentCharacters: 50_000,
      materialization: "synchronous",
      idempotency: "provider_key",
    },
    reconcile: true,
    management: { list: true, get: true, update: false, delete: false, history: false },
  },
  authMode: "none",
  credentialRevision: "none",
};

function ids(): IdFactory {
  let sequence = 0;
  const next = (prefix: string) => `${prefix}_sessionimport${(++sequence).toString(36)}`;
  return {
    session: () => next("psn") as never,
    message: () => next("msg") as never,
    run: () => next("run") as never,
    attempt: () => next("att") as never,
    plan: () => next("pln") as never,
    planRevision: () => next("plr") as never,
    revisionInput: () => next("rin") as never,
    approval: () => next("apr") as never,
    decision: () => next("dec") as never,
    executionContract: () => next("exc") as never,
    executionCandidate: () => next("xcd") as never,
    validationResult: () => next("val") as never,
    artifact: () => next("art") as never,
    outbox: () => next("obx") as never,
  };
}

function initialSource(): NormalizedMemorySessionSnapshot {
  return {
    sourceKind: "codex",
    sourceSessionId: CODEX_ID,
    title: "Memory导入纵向",
    updatedAt: "2026-08-24T09:00:00.000Z",
    messages: [
      {
        sourceMessageKey: "turn-1:user",
        role: "user",
        text: "先做预览。",
        createdAt: "2026-08-24T08:00:00.000Z",
      },
      {
        sourceMessageKey: "turn-1:assistant",
        role: "assistant",
        text: "预览不产生写入。",
        createdAt: "2026-08-24T08:00:01.000Z",
      },
      {
        sourceMessageKey: "turn-2:user",
        role: "user",
        text: "重复导入呢？",
        createdAt: "2026-08-24T08:01:00.000Z",
      },
    ],
  };
}

describe("Codex Session预览、去重与增量导入纵向", () => {
  it("预览零写入，同快照重跑零新增，新增turn只创建一个新Write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chat-memory-session-import-"));
    let tick = 0;
    let source = initialSource();
    const now = () =>
      new Date(Date.parse("2026-08-24T10:00:00.000Z") + tick++ * 1_000).toISOString();
    const store = await JsonProductStore.open({ filePath: join(directory, "product.json"), now });
    const sourcePort = {
      kind: "codex" as const,
      list: async () => [],
      load: async () => structuredClone(source),
    };
    const memorySessionSources: MemorySessionSourceRegistryPort = {
      get: () => sourcePort,
    };
    const provider = {
      describeProvider: () => DESCRIPTOR,
      writeMemory: async (input: { readonly operationId: string }) => ({
        externalObjectId: `memory:${input.operationId}`,
        responseSha256: "b".repeat(64),
      }),
      reconcileMemoryWrite: async (input: { readonly operationId: string }) => ({
        status: "materialized" as const,
        accepted: {
          externalObjectId: `memory:${input.operationId}`,
          responseSha256: "b".repeat(64),
        },
        verificationKind: "provider_query",
        verificationSha256: "c".repeat(64),
      }),
    };
    const workflowMemoryProviders: WorkflowMemoryProviderRegistryPort = {
      list: () => [DESCRIPTOR],
      getQuery: () => undefined,
      getWrite: (providerId) => (providerId === PROVIDER_ID ? provider : undefined),
    };
    const deps: ApplicationDeps = {
      store,
      now,
      ids: ids(),
      memorySessionSources,
      workflowMemoryProviders,
    };
    const sourceRef = { kind: "codex" as const, codexSessionId: CODEX_ID as never };
    const firstPreview = (
      await previewMemorySessionImport(deps, {
        principalId: PRINCIPAL,
        source: sourceRef,
        providerId: PROVIDER_ID,
      })
    ).preview;
    expect(firstPreview).toMatchObject({ newItemCount: 2, existingItemCount: 0 });
    expect((await store.read({ kind: "committedSnapshot" })).snapshot.storeRevision).toBe(0);

    const first = await createMemorySessionImport(deps, {
      principalId: PRINCIPAL,
      commandId: "cmd_sessionimport1" as CommandId,
      payload: {
        source: sourceRef,
        providerId: PROVIDER_ID,
        sourceSnapshotSha256: firstPreview.sourceSnapshotSha256,
        previewSha256: firstPreview.previewSha256,
      },
    });
    expect(first.memorySessionImport).toMatchObject({
      status: "processing",
      createdItemCount: 2,
      existingItemCount: 0,
      resultCounts: { queued: 2 },
    });
    let snapshot = (await store.read({ kind: "committedSnapshot" })).snapshot;
    expect(Object.keys(snapshot.entities.memoryWriteIntents)).toHaveLength(2);
    expect(Object.keys(snapshot.outbox)).toHaveLength(2);

    const replayed = await createMemorySessionImport(deps, {
      principalId: PRINCIPAL,
      commandId: "cmd_sessionimport2" as CommandId,
      payload: {
        source: sourceRef,
        providerId: PROVIDER_ID,
        sourceSnapshotSha256: firstPreview.sourceSnapshotSha256,
        previewSha256: firstPreview.previewSha256,
      },
    });
    expect(replayed.memorySessionImport.memorySessionImportId).toBe(
      first.memorySessionImport.memorySessionImportId,
    );
    snapshot = (await store.read({ kind: "committedSnapshot" })).snapshot;
    expect(Object.keys(snapshot.entities.memoryWriteIntents)).toHaveLength(2);
    expect(Object.keys(snapshot.outbox)).toHaveLength(2);

    source = {
      ...source,
      updatedAt: "2026-08-24T09:05:00.000Z",
      messages: [
        ...source.messages,
        {
          sourceMessageKey: "turn-3:user",
          role: "user",
          text: "只导入新增内容。",
          createdAt: "2026-08-24T09:05:00.000Z",
        },
      ],
    };
    const lostResponseReplay = await createMemorySessionImport(deps, {
      principalId: PRINCIPAL,
      commandId: "cmd_sessionimport1" as CommandId,
      payload: {
        source: sourceRef,
        providerId: PROVIDER_ID,
        sourceSnapshotSha256: firstPreview.sourceSnapshotSha256,
        previewSha256: firstPreview.previewSha256,
      },
    });
    expect(lostResponseReplay.memorySessionImport.memorySessionImportId).toBe(
      first.memorySessionImport.memorySessionImportId,
    );
    await expect(
      createMemorySessionImport(deps, {
        principalId: PRINCIPAL,
        commandId: "cmd_sessionimport3" as CommandId,
        payload: {
          source: sourceRef,
          providerId: PROVIDER_ID,
          sourceSnapshotSha256: firstPreview.sourceSnapshotSha256,
          previewSha256: firstPreview.previewSha256,
        },
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });

    const secondPreview = (
      await previewMemorySessionImport(deps, {
        principalId: PRINCIPAL,
        source: sourceRef,
        providerId: PROVIDER_ID,
      })
    ).preview;
    expect(secondPreview).toMatchObject({ newItemCount: 1, existingItemCount: 2 });
    const second = await createMemorySessionImport(deps, {
      principalId: PRINCIPAL,
      commandId: "cmd_sessionimport4" as CommandId,
      payload: {
        source: sourceRef,
        providerId: PROVIDER_ID,
        sourceSnapshotSha256: secondPreview.sourceSnapshotSha256,
        previewSha256: secondPreview.previewSha256,
      },
    });
    expect(second.memorySessionImport.items.map((item) => item.disposition)).toEqual([
      "existing",
      "existing",
      "created",
    ]);
    snapshot = (await store.read({ kind: "committedSnapshot" })).snapshot;
    expect(Object.keys(snapshot.entities.memorySessionImports)).toHaveLength(2);
    expect(Object.keys(snapshot.entities.memoryWriteIntents)).toHaveLength(3);
    expect(Object.keys(snapshot.outbox)).toHaveLength(3);
    expect(() => assertSnapshotIntegrity(snapshot)).not.toThrow();

    const created = second.memorySessionImport.items.at(-1)!;
    const result = Object.values(snapshot.entities.memoryWriteResults).find(
      (candidate) => candidate.memoryWriteIntentId === created.memoryWriteIntentId,
    )!;
    const loaded = await loadMemoryWriteForRuntime(deps, {
      memoryWriteIntentId: created.memoryWriteIntentId,
      memoryWriteResultId: result.memoryWriteResultId,
    });
    expect(loaded.adapterInput).toMatchObject({
      sessionKey: `codex-session:${CODEX_ID}`,
      turnKey: "turn-3:user",
      content: "用户：\n只导入新增内容。",
    });
    await expect(
      getMemorySessionImport(deps, {
        principalId: PRINCIPAL,
        memorySessionImportId: second.memorySessionImport.memorySessionImportId,
      }),
    ).resolves.toEqual(second);
  });
});
