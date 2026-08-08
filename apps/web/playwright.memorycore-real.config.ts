import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const repoRoot = resolve(process.cwd(), "../..");
const dataRoot = resolve(repoRoot, ".data/e2e/memorycore-real");
const memoryCoreRoot = resolve(dataRoot, "memorycore");
const sharedEnv = {
  CHAT_REPO_ROOT: repoRoot,
  CHAT_RUNTIME_KEY: "rtk_memorycorereale2e000000000",
  CHAT_TRACE_DIR: resolve(dataRoot, "traces"),
  CHAT_TENCENT_MEMORYCORE_BASE_URL: "http://127.0.0.1:18970",
  CHAT_TENCENT_MEMORYCORE_TOKEN: "chat-memorycore-e2e-local",
  CHAT_TENCENT_MEMORYCORE_SERVICE_ID: "chat-memorycore-e2e-service",
  CHAT_TENCENT_MEMORYCORE_TEAM_ID: "chat-memorycore-e2e-team",
  CHAT_TENCENT_MEMORYCORE_USER_ID: "chat-memorycore-e2e-user",
  CHAT_TENCENT_MEMORYCORE_AGENT_ID: "chat-memorycore-e2e-agent",
  CHAT_TENCENT_MEMORYCORE_CONFIG_REVISION: "fixed-3a9748d",
  CHAT_TENCENT_MEMORYCORE_CREDENTIAL_REVISION: "memorycore-e2e-key-v1",
};

/** M3付费门：真实MemoryCore + Workflow + pi + 百炼qwen3.7-plus。 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "memorycore-real.e2e.ts",
  globalSetup: "./e2e/memorycore-real.setup.mjs",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 12 * 60_000,
  expect: { timeout: 5 * 60_000 },
  use: {
    baseURL: "http://127.0.0.1:43110",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: [
    {
      command: "node ../../scripts/memory/start-fixed-memorycore.mjs",
      url: "http://127.0.0.1:18970/health",
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...sharedEnv,
        CHAT_TENCENT_MEMORYCORE_RUN_ROOT: memoryCoreRoot,
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
        CHAT_RUNTIME_BINDINGS_PATH: resolve(dataRoot, "runtime-bindings.v2.json"),
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
        CHAT_PRODUCT_STORE_PATH: resolve(dataRoot, "product-store.v3.json"),
        CHAT_WORKFLOW_BASE_URL: "http://127.0.0.1:43112",
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
