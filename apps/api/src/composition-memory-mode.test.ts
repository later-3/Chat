import { describe, expect, it, vi } from "vitest";
import { computeMemoryProviderDescriptorSha256 } from "@chat/domain";
import { createMemoryRegistrySet, parseMemoryMode } from "@chat/memory-runtime";
import { composeApiMemoryRegistries, composeApiWorkflowMemoryProviders } from "./composition.js";

// 本测试只验证组合根配置门，不加载受管Pi Fork或发起任何模型调用。
vi.mock("@chat/pi-runtime", () => ({
  loadProjectModelProfile: vi.fn(),
  PiProjectAdvancementUnderstandingAdapter: class {},
  PiProjectIntakeUnderstandingAdapter: class {},
}));

const enabledEnv = (mode: "memorycore" | "memmy" | "compare"): NodeJS.ProcessEnv => ({
  CHAT_MEMORY_MODE: mode,
  CHAT_TENCENT_MEMORYCORE_BASE_URL: "http://127.0.0.1:18970",
  CHAT_MEMMY_BASE_URL: "http://127.0.0.1:18960",
});

describe("API Memory组合根门", () => {
  it("mode缺省或off时都忽略遗留Provider配置并冻结空Registry", () => {
    const legacyEnv: NodeJS.ProcessEnv = {
      CHAT_TENCENT_MEMORYCORE_BASE_URL: "legacy-invalid-endpoint",
      CHAT_TENCENT_MEMORYCORE_TOKEN: "legacy-token-present",
      CHAT_MEMMY_BASE_URL: "legacy-invalid-endpoint",
      CHAT_MEMMY_TOKEN: "legacy-token-present",
    };

    for (const env of [legacyEnv, { ...legacyEnv, CHAT_MEMORY_MODE: "off" }]) {
      const composed = composeApiMemoryRegistries(env);
      expect(composed.memoryBackends.list()).toEqual([]);
      expect(composed.workflowMemoryProviders.list()).toEqual([]);
      expect("memoryImportBackends" in composed).toBe(false);
    }
  });

  it.each([
    ["off", []],
    ["memorycore", ["mbk_tencentmemorycore"]],
    ["memmy", ["mbk_memmy"]],
    ["compare", ["mbk_memmy", "mbk_tencentmemorycore"]],
  ] as const)("%s模式装配legacy query与Workflow Provider的canonical同源集合", (mode, ids) => {
    const env = mode === "off" ? { CHAT_MEMORY_MODE: mode } : enabledEnv(mode);
    const canonicalMode = parseMemoryMode(env);
    const canonical = createMemoryRegistrySet(env, { mode: canonicalMode });
    const composed = composeApiMemoryRegistries(env);
    const canonicalDescriptorSet = canonical.workflowMemoryProviders.list().map((descriptor) => ({
      providerId: descriptor.providerId,
      descriptorSha256: computeMemoryProviderDescriptorSha256(descriptor),
    }));
    const composedDescriptorSet = composed.workflowMemoryProviders.list().map((descriptor) => ({
      providerId: descriptor.providerId,
      descriptorSha256: computeMemoryProviderDescriptorSha256(descriptor),
    }));

    expect(composedDescriptorSet).toEqual(canonicalDescriptorSet);
    expect(composeApiWorkflowMemoryProviders(env).list()).toEqual(
      composed.workflowMemoryProviders.list(),
    );
    expect(composed.workflowMemoryProviders.list().map(({ providerId }) => providerId)).toEqual(
      ids,
    );
    expect(composed.memoryBackends.list().map((backend) => backend.describe().backendId)).toEqual(
      ids,
    );
    for (const id of ids) {
      const legacy = composed.memoryBackends.get(id as never);
      expect(composed.workflowMemoryProviders.getQuery(id)).toBe(legacy);
      expect(composed.workflowMemoryProviders.getWrite(id)).toBe(legacy);
    }
    expect("memoryImportBackends" in composed).toBe(false);
  });

  it("显式空mode在打开Product Store前失败关闭", () => {
    expect(() => composeApiMemoryRegistries({ CHAT_MEMORY_MODE: "" })).toThrow("CHAT_MEMORY_MODE");
  });
});
