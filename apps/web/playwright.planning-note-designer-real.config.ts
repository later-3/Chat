import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const repoRoot = resolve(process.cwd(), "../..");
const dataRoot = resolve(repoRoot, ".data/e2e/planning-note-designer-real");
const sharedEnv = {
  CHAT_REPO_ROOT: repoRoot,
  CHAT_RUNTIME_KEY: "rtk_planningnotedesignere2e000000",
  CHAT_TRACE_DIR: resolve(dataRoot, "traces"),
};

/**
 * 串行运行真实Planning、真实Note与Designer三视口；共享真实Store/Workflow Runtime，
 * 普通测试不会加载本配置，也不会产生Provider费用。
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: [
    "planning-execution-real.spec.ts",
    "note-workflow-real.spec.ts",
    "workflow-designer.spec.ts",
  ],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 12 * 60_000,
  expect: { timeout: 5 * 60_000 },
  use: {
    baseURL: "http://127.0.0.1:43210",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: [
    {
      command: "pnpm --filter @chat/workflows start:runtime",
      url: "http://127.0.0.1:43212/healthz",
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        ...sharedEnv,
        CHAT_WORKFLOW_PORT: "43212",
        CHAT_WORKFLOW_DATA_DIR: resolve(dataRoot, "workflow"),
        CHAT_RUNTIME_BINDINGS_PATH: resolve(dataRoot, "runtime-bindings.v1.json"),
        CHAT_API_INTERNAL_BASE_URL: "http://127.0.0.1:43211",
      },
    },
    {
      command: "pnpm --filter @chat/api start",
      url: "http://127.0.0.1:43211/api/readyz",
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        ...sharedEnv,
        PORT: "43211",
        CHAT_API_HOST: "127.0.0.1",
        CHAT_PRODUCT_STORE_PATH: resolve(dataRoot, "product-store.v1.json"),
        CHAT_WORKFLOW_BASE_URL: "http://127.0.0.1:43212",
      },
    },
    {
      command:
        "pnpm --filter @chat/web build && pnpm --filter @chat/web exec vite preview --host 127.0.0.1 --port 43210 --strictPort",
      url: "http://127.0.0.1:43210/",
      reuseExistingServer: false,
      timeout: 240_000,
      env: { ...sharedEnv, CHAT_API_PROXY_URL: "http://127.0.0.1:43211" },
    },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
