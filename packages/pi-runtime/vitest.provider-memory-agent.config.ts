import { defineConfig } from "vitest/config";

/** Memory Agent独立真实付费门；泛`test:provider:bailian`仍会包含所有*.real.ts付费门。 */
export default defineConfig({
  test: {
    include: ["src/provider-bailian-memory-agent.real.ts"],
    testTimeout: 300_000,
  },
});
