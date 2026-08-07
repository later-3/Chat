import { defineConfig } from "vitest/config";

/** 真实Provider门专用配置：只运行*.real.ts；普通CI不运行付费测试。 */
export default defineConfig({
  test: {
    include: ["src/**/*.real.ts"],
    testTimeout: 240_000,
  },
});
