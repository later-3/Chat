import "../../scripts/debug/load-provider-env.mjs";

import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { dshRealWebEnvironment } from "../../scripts/e2e/dsh-real-environment.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const dataRoot = resolve(repoRoot, ".data/e2e/dsh-real");
const sharedEnvironment = {
  ...process.env,
  CHAT_REPO_ROOT: repoRoot,
  CHAT_RUNTIME_KEY: "rtk_dshreale2etestonly0000000000",
  CHAT_TRACE_DIR: resolve(dataRoot, "traces"),
};

/**
 * 付费完成门只由显式test:e2e:dsh-real运行。3个服务使用真实JSON Product Store、
 * Vercel Workflow World、pi与百炼；DSH使用rc.6 Host和浏览器Client factory。
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "dsh-planning-real.spec.ts",
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
      command: "pnpm --filter @chat/workflows start:runtime",
      cwd: repoRoot,
      url: "http://127.0.0.1:43112/healthz",
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        ...sharedEnvironment,
        CHAT_WORKFLOW_PORT: "43112",
        CHAT_WORKFLOW_DATA_DIR: resolve(dataRoot, "workflow"),
        CHAT_RUNTIME_BINDINGS_PATH: resolve(dataRoot, "runtime-bindings.v1.json"),
        CHAT_API_INTERNAL_BASE_URL: "http://127.0.0.1:43111",
      },
    },
    {
      command: "pnpm --filter @chat/api start",
      cwd: repoRoot,
      url: "http://127.0.0.1:43111/api/readyz",
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        ...sharedEnvironment,
        PORT: "43111",
        CHAT_API_HOST: "127.0.0.1",
        CHAT_PRODUCT_STORE_PATH: resolve(dataRoot, "product-store.v1.json"),
        CHAT_WORKFLOW_BASE_URL: "http://127.0.0.1:43112",
      },
    },
    {
      command: "node scripts/e2e/start-dsh-real.mjs",
      cwd: repoRoot,
      url: "http://127.0.0.1:43110/",
      reuseExistingServer: false,
      timeout: 120_000,
      env: dshRealWebEnvironment(repoRoot, process.env),
    },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
