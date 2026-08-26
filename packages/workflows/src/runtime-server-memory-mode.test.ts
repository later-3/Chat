import { describe, expect, it, vi } from "vitest";
import { computeMemoryProviderDescriptorSha256 } from "@chat/domain";
import { createMemoryRegistrySet, parseMemoryMode } from "@chat/memory-runtime";
import {
  composeRuntimeMemoryRegistries,
  composeRuntimeWorkflowMemoryProviders,
} from "./runtime-server.js";

// 本测试只验证组合根配置门，不加载受管Pi Fork或发起任何模型调用。
vi.mock("@chat/pi-runtime", () => ({
  createPiDirectExecutorServiceClient: vi.fn(),
  createPiExecutorServiceClient: vi.fn(),
  loadBailianConfig: vi.fn(),
  runPiGovernanceReview: vi.fn(),
  runPiMemoryRetrievalAgent: vi.fn(),
  runPiMemoryWriteAgent: vi.fn(),
  runPiNoteCapture: vi.fn(),
  runPiPlanner: vi.fn(),
}));

const enabledEnv = (mode: "memorycore" | "memmy" | "compare"): NodeJS.ProcessEnv => ({
  CHAT_MEMORY_MODE: mode,
  CHAT_TENCENT_MEMORYCORE_BASE_URL: "http://127.0.0.1:18970",
  CHAT_MEMMY_BASE_URL: "http://127.0.0.1:18960",
});

describe("Workflow Runtime Memory组合根门", () => {
  it("mode缺省或off时都忽略遗留Provider配置并冻结空Registry", () => {
    const legacyEnv: NodeJS.ProcessEnv = {
      CHAT_TENCENT_MEMORYCORE_BASE_URL: "legacy-invalid-endpoint",
      CHAT_TENCENT_MEMORYCORE_TOKEN: "legacy-token-present",
      CHAT_MEMMY_BASE_URL: "legacy-invalid-endpoint",
      CHAT_MEMMY_TOKEN: "legacy-token-present",
    };

    for (const env of [legacyEnv, { ...legacyEnv, CHAT_MEMORY_MODE: "off" }]) {
      const composed = composeRuntimeMemoryRegistries(env);
      expect(composed.memoryBackends.list()).toEqual([]);
      expect(composed.memoryImportBackends.list()).toEqual([]);
      expect(composed.workflowMemoryProviders.list()).toEqual([]);
    }
  });

  it.each([
    ["off", []],
    ["memorycore", ["mbk_tencentmemorycore"]],
    ["memmy", ["mbk_memmy"]],
    ["compare", ["mbk_memmy", "mbk_tencentmemorycore"]],
  ] as const)("%s模式把同一Adapter装配到legacy query/import与Workflow", (mode, ids) => {
    const env = mode === "off" ? { CHAT_MEMORY_MODE: mode } : enabledEnv(mode);
    const canonicalMode = parseMemoryMode(env);
    const canonical = createMemoryRegistrySet(env, { mode: canonicalMode });
    const composed = composeRuntimeMemoryRegistries(env);
    const canonicalDescriptorSet = canonical.workflowMemoryProviders.list().map((descriptor) => ({
      providerId: descriptor.providerId,
      descriptorSha256: computeMemoryProviderDescriptorSha256(descriptor),
    }));
    const composedDescriptorSet = composed.workflowMemoryProviders.list().map((descriptor) => ({
      providerId: descriptor.providerId,
      descriptorSha256: computeMemoryProviderDescriptorSha256(descriptor),
    }));

    expect(composedDescriptorSet).toEqual(canonicalDescriptorSet);
    expect(composeRuntimeWorkflowMemoryProviders(env).list()).toEqual(
      composed.workflowMemoryProviders.list(),
    );
    expect(composed.workflowMemoryProviders.list().map(({ providerId }) => providerId)).toEqual(
      ids,
    );
    expect(composed.memoryImportBackends).toBe(composed.memoryBackends);
    for (const id of ids) {
      const legacy = composed.memoryBackends.get(id as never);
      expect(composed.memoryImportBackends.get(id as never)).toBe(legacy);
      expect(composed.workflowMemoryProviders.getQuery(id)).toBe(legacy);
      expect(composed.workflowMemoryProviders.getWrite(id)).toBe(legacy);
    }
  });

  it("显式空mode在打开Runtime耐久数据前失败关闭", () => {
    expect(() => composeRuntimeMemoryRegistries({ CHAT_MEMORY_MODE: "" })).toThrow(
      "CHAT_MEMORY_MODE",
    );
  });
});
