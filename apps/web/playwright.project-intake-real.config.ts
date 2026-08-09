import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const repoRoot = resolve(process.cwd(), "../..");
const dataRoot = resolve(repoRoot, ".data/e2e/project-intake-real");
const sharedEnv = {
  CHAT_REPO_ROOT: repoRoot,
  CHAT_RUNTIME_KEY: "rtk_projectintakereale2e000000",
  CHAT_TRACE_DIR: resolve(dataRoot, "traces"),
};

export default defineConfig({
  testDir: "./e2e",
  // 使用.e2e.ts后缀，确保普通PWA配置不会误执行真实Provider专用场景。
  testMatch: "project-intake-real.e2e.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 12 * 60_000,
  expect: { timeout: 5 * 60_000 },
  use: {
    baseURL: "http://127.0.0.1:43110",
    actionTimeout: 30_000,
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
        CHAT_PROJECT_ROOTS_JSON: JSON.stringify([
          {
            rootId: "root_chat",
            displayName: "Chat PS1真实工作区",
            canonicalPath: repoRoot,
            enabledAdapters: [
              "local-git-workspace.v1",
              "project-document-manifest.v1",
              "package-script-catalog.v1",
            ],
          },
        ]),
        CHAT_PROJECT_MODEL_PROVIDER: "bailian",
        CHAT_PROJECT_MODEL_ID: "qwen3.7-plus",
        CHAT_PROJECT_MODEL_DISPLAY_NAME: "Qwen3.7 Plus",
        CHAT_PROJECT_MODEL_PROFILE_VERSION: "bailian.qwen3.7-plus.v1",
        CHAT_PROJECT_MODEL_API_KEY_ENV: "DASHSCOPE_API_KEY",
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
