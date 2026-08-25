import { defineConfig } from "vitest/config";

/** Planner/Executor真实Provider门；另外两个真实入口各自使用独立Config。 */
export default defineConfig({
  test: {
    include: ["src/provider-bailian.real.ts"],
    testTimeout: 240_000,
  },
});
