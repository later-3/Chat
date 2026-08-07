import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const repoRoot = resolve(process.cwd(), "../..");
const dataRoot = resolve(repoRoot, ".data/e2e/planning-execution-real");
const sharedEnv = {
  CHAT_REPO_ROOT: repoRoot,
  CHAT_RUNTIME_KEY: "rtk_planningreale2etestonly000000",
  CHAT_TRACE_DIR: resolve(dataRoot, "traces"),
};

/**
 * 真实浏览器闭环：固定端口、真实JSON Store、真实Workflow、真实pi与百炼。
 * 该配置只由pnpm test:e2e:planning-execution:real显式运行，普通CI不产生费用。
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "planning-execution-real.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 12 * 60_000,
  expect: { timeout: 5 * 60_000 },
  use: {
    baseURL: "http://127.0.0.1:43110",
    // 网络Trace/截图/录像会复制消息与Plan正文；B2证据只保留脱敏系统Trace。
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: [
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
        CHAT_PRODUCT_STORE_PATH: resolve(dataRoot, "product-store.v1.json"),
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
