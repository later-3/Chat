import { describe, expect, it } from "vitest";
import { previewMemoryProviderComparisonPayloadSchema } from "./memory-provider-comparison.js";

describe("Memory Provider比较公开合同", () => {
  it("要求至少两个不重复Provider并拒绝运行时配置注入", () => {
    const source = {
      kind: "codex" as const,
      codexSessionId: "019db07f-953c-7fc2-95b6-d38228810e64",
    };
    expect(
      previewMemoryProviderComparisonPayloadSchema.parse({
        source,
        query: "发布前需要完成什么？",
        providerIds: ["mbk_memmy", "mbk_tencentmemorycore"],
      }),
    ).toMatchObject({ maxResults: 8, maxContextCharacters: 8_000 });
    expect(() =>
      previewMemoryProviderComparisonPayloadSchema.parse({
        source,
        query: "发布前需要完成什么？",
        providerIds: ["mbk_memmy", "mbk_memmy"],
      }),
    ).toThrow();
    expect(() =>
      previewMemoryProviderComparisonPayloadSchema.parse({
        source,
        query: "发布前需要完成什么？",
        providerIds: ["mbk_memmy", "mbk_tencentmemorycore"],
        endpoint: "https://attacker.invalid",
      }),
    ).toThrow();
  });
});
