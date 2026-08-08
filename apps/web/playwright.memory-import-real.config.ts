import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const repoRoot = resolve(process.cwd(), "../..");
const dataRoot = resolve(repoRoot, ".data/e2e/memory-import-real");
const memmyRoot = resolve(dataRoot, "memmy");
const sharedEnv = {
  CHAT_REPO_ROOT: repoRoot,
  CHAT_RUNTIME_KEY: "rtk_memoryimportreale2e000000000",
  CHAT_TRACE_DIR: resolve(dataRoot, "traces"),
};
const providerIsolatedEnv = {
  ...sharedEnv,
  DASHSCOPE_API_KEY: "",
  DASHSCOPE_BASE_URL: "",
};

/** M2 付费门：真实消息导入 -> 重启恢复 -> 新会话检索 -> 真实规划与执行。 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "memory-import-real.e2e.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 22 * 60_000,
  expect: { timeout: 30_000 },
  use: {
    actionTimeout: 30_000,
    baseURL: "http://127.0.0.1:43110",
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
        ...providerIsolatedEnv,
        CHAT_MEMMY_RUN_ROOT: memmyRoot,
        CHAT_MEMMY_DB_PATH: resolve(memmyRoot, "memory.sqlite"),
      },
    },
    {
      command: "node ../../scripts/e2e/restartable-service.mjs workflow",
      url: "http://127.0.0.1:43112/healthz",
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        ...sharedEnv,
        CHAT_E2E_RESTART_ROOT: resolve(dataRoot, "restarts"),
        CHAT_WORKFLOW_PORT: "43112",
        CHAT_WORKFLOW_DATA_DIR: resolve(dataRoot, "workflow"),
        CHAT_RUNTIME_BINDINGS_PATH: resolve(dataRoot, "runtime-bindings.v2.json"),
        CHAT_API_INTERNAL_BASE_URL: "http://127.0.0.1:43111",
      },
    },
    {
      command: "node ../../scripts/e2e/restartable-service.mjs api",
      url: "http://127.0.0.1:43111/api/readyz",
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        ...providerIsolatedEnv,
        CHAT_E2E_RESTART_ROOT: resolve(dataRoot, "restarts"),
        PORT: "43111",
        CHAT_API_HOST: "127.0.0.1",
        CHAT_PRODUCT_STORE_PATH: resolve(dataRoot, "product-store.v3.json"),
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
      env: { ...providerIsolatedEnv, CHAT_API_PROXY_URL: "http://127.0.0.1:43111" },
    },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
