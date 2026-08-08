import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const repoRoot = resolve(process.cwd(), "../..");
const dataRoot = resolve(repoRoot, ".data/e2e/memory-planning-real");
const memmyRoot = resolve(dataRoot, "memmy");
const sharedEnv = {
  CHAT_REPO_ROOT: repoRoot,
  CHAT_RUNTIME_KEY: "rtk_memoryreale2etestonly00000000",
  CHAT_TRACE_DIR: resolve(dataRoot, "traces"),
};

/**
 * M1 付费里程碑门：固定 memmy 真服务 + 真 Workflow + 真 pi + 百炼 qwen3.7-plus。
 * Spec 使用 `.e2e.ts` 后缀，普通 Playwright 默认匹配不会误触发付费调用。
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "memory-planning-real.e2e.ts",
  globalSetup: "./e2e/memory-planning-real.setup.mjs",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 18 * 60_000,
  expect: { timeout: 30_000 },
  use: {
    actionTimeout: 30_000,
    baseURL: "http://127.0.0.1:43110",
    // 网络 trace/截图/录像会复制 Memory 与 Plan 正文；产品证据只保存严格系统 Trace。
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: [
    {
      command: "node ../../scripts/memory/start-fixed-memmy.mjs",
      url: "http://127.0.0.1:18960/api/v1/health",
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...sharedEnv,
        CHAT_MEMMY_RUN_ROOT: memmyRoot,
        CHAT_MEMMY_DB_PATH: resolve(memmyRoot, "memory.sqlite"),
      },
    },
    {
      command: "pnpm --filter @chat/workflows start:runtime",
      url: "http://127.0.0.1:43112/healthz",
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        ...sharedEnv,
        CHAT_WORKFLOW_PORT: "43112",
        CHAT_WORKFLOW_DATA_DIR: resolve(dataRoot, "workflow"),
        CHAT_RUNTIME_BINDINGS_PATH: resolve(dataRoot, "runtime-bindings.v1.json"),
        CHAT_API_INTERNAL_BASE_URL: "http://127.0.0.1:43111",
      },
    },
    {
      command: "pnpm --filter @chat/api start",
      url: "http://127.0.0.1:43111/api/readyz",
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        ...sharedEnv,
        PORT: "43111",
        CHAT_API_HOST: "127.0.0.1",
        CHAT_PRODUCT_STORE_PATH: resolve(dataRoot, "product-store.v2.json"),
        CHAT_WORKFLOW_BASE_URL: "http://127.0.0.1:43112",
        CHAT_MEMMY_BASE_URL: "http://127.0.0.1:18960",
      },
    },
    {
      command:
        "pnpm --filter @chat/web build && pnpm --filter @chat/web exec vite preview --host 127.0.0.1 --port 43110 --strictPort",
      url: "http://127.0.0.1:43110/",
      reuseExistingServer: false,
      timeout: 240_000,
      env: { ...sharedEnv, CHAT_API_PROXY_URL: "http://127.0.0.1:43111" },
    },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
