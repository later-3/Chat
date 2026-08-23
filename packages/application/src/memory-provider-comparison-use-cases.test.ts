import { createEmptySnapshot, type MemoryProviderDescriptor } from "@chat/contracts";
import { describe, expect, it } from "vitest";
import type { ApplicationDeps } from "./deps.js";
import { previewMemoryProviderComparison } from "./memory-provider-comparison-use-cases.js";

const SOURCE_ID = "019db07f-953c-7fc2-95b6-d38228810e64";

function descriptor(providerId: string, materialization: "synchronous" | "accepted_only") {
  return {
    schemaVersion: "memory-provider-descriptor.v1",
    providerId,
    displayName: providerId,
    providerKind: "fixture",
    transport: "http",
    adapterContractVersion: "fixture.v1",
    configured: true,
    configurationFingerprint: "a".repeat(64),
    capabilities: {
      query: { maxResults: 20, maxContextCharacters: 50_000 },
      write: {
        maxContentCharacters: 50_000,
        materialization,
        idempotency: "provider_key",
      },
      reconcile: true,
      management: { list: false, get: false, update: false, delete: false, history: false },
    },
    authMode: "none",
    credentialRevision: "none",
  } as MemoryProviderDescriptor;
}

describe("Memory Provider并行比较Preview", () => {
  it("同一namespace并行查询、报告精确交集且不写Product Store", async () => {
    const snapshot = createEmptySnapshot("2026-08-24T12:00:00.000Z");
    const started = new Set<string>();
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    let transactionCalls = 0;
    const descriptors = [
      descriptor("mbk_alpha", "synchronous"),
      descriptor("mbk_zeta", "accepted_only"),
    ];
    const deps = {
      now: () => "2026-08-24T12:01:00.000Z",
      store: {
        read: async () => ({ snapshot }),
        transact: async () => {
          transactionCalls += 1;
          throw new Error("只读比较不得进入事务");
        },
      },
      memorySessionSources: {
        get: () => ({
          kind: "codex" as const,
          list: async () => [],
          load: async () => ({
            sourceKind: "codex" as const,
            sourceSessionId: SOURCE_ID,
            title: "比较测试",
            updatedAt: "2026-08-24T12:00:00.000Z",
            messages: [
              {
                sourceMessageKey: "turn-1:user",
                role: "user" as const,
                text: "发布前需要完成浏览器测试。",
                createdAt: "2026-08-24T11:00:00.000Z",
              },
            ],
          }),
        }),
      },
      workflowMemoryProviders: {
        list: () => descriptors,
        getWrite: () => undefined,
        getQuery: (providerId: string) => {
          const found = descriptors.find((candidate) => candidate.providerId === providerId);
          if (found === undefined) return undefined;
          return {
            describeProvider: () => found,
            health: async () => ({ status: "ready" as const }),
            queryMemory: async (input: { readonly sessionKey?: string }) => {
              expect(input.sessionKey).toBe(`codex-session:${SOURCE_ID}`);
              started.add(providerId);
              if (started.size === 2) release();
              await bothStarted;
              const shared = {
                externalObjectIds: [`${providerId}:shared`],
                title: "发布门",
                category: "procedure" as const,
                content: "发布前需要完成浏览器测试。",
                labels: ["release"],
                score: providerId === "mbk_alpha" ? 0.2 : 99,
              };
              return {
                externalQueryId: `query:${providerId}`,
                hitCount: providerId === "mbk_alpha" ? 2 : 1,
                sections:
                  providerId === "mbk_alpha"
                    ? [
                        shared,
                        {
                          externalObjectIds: [`${providerId}:unique`],
                          title: "本地门",
                          category: "fact" as const,
                          content: "本地构建必须通过。",
                          labels: ["local"],
                        },
                      ]
                    : [shared],
              };
            },
          };
        },
      },
    } as unknown as ApplicationDeps;

    const result = await previewMemoryProviderComparison(deps, {
      principalId: "usr_compare1" as never,
      payload: {
        source: { kind: "codex", codexSessionId: SOURCE_ID as never },
        query: "发布前需要完成什么？",
        providerIds: ["mbk_zeta" as never, "mbk_alpha" as never],
        maxResults: 8,
        maxContextCharacters: 8_000,
      },
    });

    expect([...started]).toHaveLength(2);
    expect(transactionCalls).toBe(0);
    expect(result.comparison.providers.map((provider) => provider.providerId)).toEqual([
      "mbk_alpha",
      "mbk_zeta",
    ]);
    expect(result.comparison.pairwise).toEqual([
      {
        leftProviderId: "mbk_alpha",
        rightProviderId: "mbk_zeta",
        exactContentOverlapCount: 1,
        leftUniqueContentCount: 1,
        rightUniqueContentCount: 0,
        sharedLabels: ["release"],
        scoreComparisonAllowed: false,
      },
    ]);
  });

  it("off或所选Provider缺失时在读取Codex文件前失败关闭", async () => {
    let sourceLoads = 0;
    const deps = {
      now: () => "2026-08-24T12:01:00.000Z",
      store: { read: async () => ({ snapshot: createEmptySnapshot("2026-08-24T12:00:00.000Z") }) },
      memorySessionSources: {
        get: () => ({
          kind: "codex" as const,
          list: async () => [],
          load: async () => {
            sourceLoads += 1;
            return undefined;
          },
        }),
      },
      workflowMemoryProviders: {
        list: () => [],
        getQuery: () => undefined,
        getWrite: () => undefined,
      },
    } as unknown as ApplicationDeps;
    await expect(
      previewMemoryProviderComparison(deps, {
        principalId: "usr_compare1" as never,
        payload: {
          source: { kind: "codex", codexSessionId: SOURCE_ID as never },
          query: "发布前需要完成什么？",
          providerIds: ["mbk_alpha" as never, "mbk_zeta" as never],
          maxResults: 8,
          maxContextCharacters: 8_000,
        },
      }),
    ).rejects.toMatchObject({ code: "validation_failed", httpStatus: 409 });
    expect(sourceLoads).toBe(0);
  });
});
