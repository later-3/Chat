import { describe, expect, it } from "vitest";
import {
  memoryProviderDescriptorSchema,
  memoryWriteIntentSchema,
  workflowMemoryContextSchema,
  workflowMemoryQueryNodeConfigSchema,
} from "./workflow-memory.js";

const SHA = "a".repeat(64);

function provider() {
  return {
    schemaVersion: "memory-provider-descriptor.v1" as const,
    providerId: "mbk_tencentmemorycore",
    displayName: "Tencent MemoryCore",
    providerKind: "tencent_memorycore",
    transport: "http" as const,
    adapterContractVersion: "tencent-memorycore-http.v2",
    configured: true,
    authMode: "bearer" as const,
    credentialRevision: "memorycore-key-v1",
    configurationFingerprint: SHA,
    capabilities: {
      query: { maxResults: 20, maxContextCharacters: 50_000 },
      write: {
        maxContentCharacters: 8_192,
        materialization: "asynchronous" as const,
        idempotency: "chat_reconcile" as const,
      },
      reconcile: true,
      management: { list: false, get: false, update: false, delete: false, history: false },
    },
  };
}

describe("Workflow Memory合同", () => {
  it("Provider描述只表达能力，不写死L0/L1或具体项目联合", () => {
    expect(memoryProviderDescriptorSchema.parse(provider())).toMatchObject({
      providerKind: "tencent_memorycore",
      transport: "http",
      capabilities: { query: { maxResults: 20 }, write: { materialization: "asynchronous" } },
    });
    expect(
      memoryProviderDescriptorSchema.safeParse({
        ...provider(),
        endpoint: "http://127.0.0.1:18970",
      }).success,
    ).toBe(false);
  });

  it("memory.query节点只保留通用查询预算", () => {
    expect(
      workflowMemoryQueryNodeConfigSchema.parse({ providerId: "mbk_tencentmemorycore" }),
    ).toEqual({
      providerId: "mbk_tencentmemorycore",
      required: false,
      querySource: "source_message",
      maxResults: 8,
      maxContextCharacters: 8_000,
    });
    expect(
      workflowMemoryQueryNodeConfigSchema.safeParse({
        providerId: "mbk_tencentmemorycore",
        layers: ["L1"],
      }).success,
    ).toBe(false);
  });

  it("一个Context可以组合多个查询，并记录可选失败", () => {
    const parsed = workflowMemoryContextSchema.parse({
      schemaVersion: "workflow-memory-context.v1",
      workflowMemoryContextId: "wmc_abc",
      productRunId: "run_abc",
      workflowRunSpecId: "wrs_abc",
      workflowRunSpecSha256: SHA,
      queries: [
        {
          workflowMemoryQueryId: "wmq_one",
          revision: 2,
          providerId: "mbk_tencentmemorycore",
          outcome: "completed",
          resultSetSha256: SHA,
        },
        {
          workflowMemoryQueryId: "wmq_two",
          revision: 2,
          providerId: "mbk_other",
          outcome: "optional_failed",
          errorCode: "memory.provider.timeout",
        },
      ],
      items: [],
      totalContentCharacters: 0,
      sha256: SHA,
      revision: 1,
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
    });
    expect(parsed.queries).toHaveLength(2);
  });

  it("显式写入只引用Chat消息，不复制任意Provider参数", () => {
    const parsed = memoryWriteIntentSchema.parse({
      schemaVersion: "memory-write-intent.v1",
      memoryWriteIntentId: "mwi_abc",
      operationId: "mwi_abc",
      requestedByPrincipalId: "usr_abc",
      productSessionId: "psn_abc",
      sourceSelection: {
        kind: "full_message",
        sourceMessageId: "msg_abc",
        sourceMessageSha256: SHA,
      },
      contentType: "conversation_turn",
      providerId: "mbk_tencentmemorycore",
      providerDescriptor: provider(),
      providerDescriptorSha256: SHA,
      requestSha256: SHA,
      semanticDedupeSha256: SHA,
      revision: 1,
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
    });
    expect(parsed.sourceSelection.kind).toBe("full_message");
  });
});
