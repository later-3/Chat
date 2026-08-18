import { defineConfig } from "vitest/config";

/** 完整AgentSession真实付费门；普通CI与旧单轮Provider门都不会隐式运行。 */
export default defineConfig({
  test: {
    include: ["src/provider-bailian-coding.real.ts"],
    testTimeout: 600_000,
  },
});
