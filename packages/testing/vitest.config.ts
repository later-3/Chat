import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["../workflows/vitest.global-setup.ts"],
    testTimeout: 90_000,
    hookTimeout: 120_000,
  },
});
