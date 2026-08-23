import { describe, expect, it } from "vitest";
import { MEMMY_BACKEND_ID } from "./memmy-adapter.js";
import {
  createMemoryBackendRegistry,
  createMemoryRegistrySet,
  createWorkflowMemoryProviderRegistry,
  parseMemoryMode,
  type MemoryRuntimeMode,
} from "./registry.js";
import { TENCENT_MEMORYCORE_BACKEND_ID } from "./tencent-memorycore-adapter.js";

const ALL_TENCENT_CONFIGURATION = {
  CHAT_TENCENT_MEMORYCORE_TOKEN: "private-test-token",
  CHAT_TENCENT_MEMORYCORE_SERVICE_ID: "chat-service",
  CHAT_TENCENT_MEMORYCORE_TEAM_ID: "chat-team",
  CHAT_TENCENT_MEMORYCORE_USER_ID: "chat-user",
  CHAT_TENCENT_MEMORYCORE_AGENT_ID: "chat-agent",
  CHAT_TENCENT_MEMORYCORE_CREDENTIAL_REVISION: "test-key-v1",
} as const;

describe("Workflow Memory Provider activation", () => {
  it.each([
    [undefined, "off"],
    ["off", "off"],
    ["memorycore", "memorycore"],
    ["memmy", "memmy"],
    ["compare", "compare"],
    ["  memmy  ", "memmy"],
  ] as const)("严格解析CHAT_MEMORY_MODE=%s", (raw, expected) => {
    expect(parseMemoryMode(raw === undefined ? {} : { CHAT_MEMORY_MODE: raw })).toBe(expected);
  });

  it.each(["", "   ", "tencent", "all", "MEMMY"])("拒绝显式非法模式 %j", (mode) => {
    expect(() => parseMemoryMode({ CHAT_MEMORY_MODE: mode })).toThrowError(
      "CHAT_MEMORY_MODE必须是off、memorycore、memmy或compare",
    );
  });

  it("off在遗留配置无效时仍返回legacy+workflow真正空Registry", () => {
    const registries = createMemoryRegistrySet(
      {
        CHAT_MEMORY_MODE: "off",
        CHAT_MEMMY_BASE_URL: "not-a-url",
        CHAT_MEMMY_TOKEN: "legacy-secret-without-revision",
        CHAT_TENCENT_MEMORYCORE_BASE_URL: "http://remote.example.com",
        ...ALL_TENCENT_CONFIGURATION,
      },
      {
        mode: "off",
        memmy: { baseUrl: "still-not-a-url" },
        tencentMemoryCore: { baseUrl: "also-not-a-url" },
      },
    );
    expect(registries.memoryBackends.list()).toEqual([]);
    expect(registries.memoryImportBackends.list()).toEqual([]);
    expect(registries.workflowMemoryProviders.list()).toEqual([]);
    expect(registries.memoryImportBackends).toBe(registries.memoryBackends);
    expect(registries.workflowMemoryProviders.getQuery(MEMMY_BACKEND_ID)).toBeUndefined();
    expect(
      registries.workflowMemoryProviders.getWrite(TENCENT_MEMORYCORE_BACKEND_ID),
    ).toBeUndefined();
    expect(
      createMemoryBackendRegistry({
        CHAT_MEMMY_BASE_URL: "not-a-url",
        CHAT_MEMMY_TOKEN: "legacy-secret-without-revision",
      }).list(),
    ).toEqual([]);
  });

  it.each<{
    mode: MemoryRuntimeMode;
    ids: readonly string[];
  }>([
    { mode: "off", ids: [] },
    { mode: "memorycore", ids: [TENCENT_MEMORYCORE_BACKEND_ID] },
    { mode: "memmy", ids: [MEMMY_BACKEND_ID] },
    { mode: "compare", ids: [MEMMY_BACKEND_ID, TENCENT_MEMORYCORE_BACKEND_ID] },
  ])("$mode只实例化目标Adapter，并把同一实例投影到四种能力", ({ mode, ids }) => {
    const registries = createMemoryRegistrySet(
      { CHAT_MEMORY_MODE: "off", ...ALL_TENCENT_CONFIGURATION },
      { mode },
    );
    expect(registries.memoryBackends.list().map((backend) => backend.describe().backendId)).toEqual(
      ids,
    );
    expect(
      registries.memoryImportBackends
        .list()
        .map((backend) => backend.describeImport().descriptor.backendId),
    ).toEqual(ids);
    expect(registries.workflowMemoryProviders.list().map(({ providerId }) => providerId)).toEqual(
      ids,
    );
    expect(registries.memoryImportBackends).toBe(registries.memoryBackends);
    for (const id of ids) {
      const legacyQuery = registries.memoryBackends.get(id as never);
      const legacyImport = registries.memoryImportBackends.get(id as never);
      const workflowQuery = registries.workflowMemoryProviders.getQuery(id);
      const workflowWrite = registries.workflowMemoryProviders.getWrite(id);
      const frozenDescriptor = registries.workflowMemoryProviders
        .list()
        .find(({ providerId }) => providerId === id);

      expect(legacyQuery).toBeDefined();
      expect(legacyImport).toBe(legacyQuery);
      expect(workflowQuery).toBe(legacyQuery);
      expect(workflowWrite).toBe(legacyQuery);
      expect(workflowQuery?.describeProvider()).toEqual(frozenDescriptor);
      expect(workflowWrite?.describeProvider()).toEqual(frozenDescriptor);
    }
  });

  it("descriptor准确声明配置状态、HTTP传输与未接入的管理能力", () => {
    const unconfiguredTencent = createWorkflowMemoryProviderRegistry(
      {},
      { mode: "memorycore" },
    ).list()[0];
    expect(unconfiguredTencent).toMatchObject({
      providerId: TENCENT_MEMORYCORE_BACKEND_ID,
      configured: false,
      transport: "http",
      capabilities: { reconcile: true },
    });

    const descriptors = createWorkflowMemoryProviderRegistry(ALL_TENCENT_CONFIGURATION, {
      mode: "compare",
    }).list();
    expect(descriptors).toHaveLength(2);
    for (const descriptor of descriptors) {
      expect(descriptor).toMatchObject({
        configured: true,
        transport: "http",
        capabilities: {
          query: expect.any(Object),
          write: expect.any(Object),
          reconcile: true,
          management: { list: false, get: false, update: false, delete: false, history: false },
        },
      });
    }
  });
});
