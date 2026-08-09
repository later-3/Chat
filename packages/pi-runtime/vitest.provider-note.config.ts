import { defineConfig } from "vitest/config";

/** Note真实Provider独立门：确保一次最小付费调用，不顺带执行Planner/Executor门。 */
export default defineConfig({
  test: {
    include: ["src/provider-bailian-note.real.ts"],
    testTimeout: 240_000,
  },
});
