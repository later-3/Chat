import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import {
  dshRealWebEnvironment,
  dshRealWorkbenchEnvironment,
} from "../../scripts/e2e/dsh-real-environment.mjs";

const workbenchOnly = process.env.CHAT_DSH_E2E_MODE === "workbench-only";
const pwaOnly = process.env.CHAT_DSH_E2E_MODE === "pwa-only";
const providerEnvironmentModule = "../../scripts/debug/load-provider-env.mjs";
if (!workbenchOnly && !pwaOnly) await import(providerEnvironmentModule);

const repoRoot = resolve(import.meta.dirname, "../..");
const dataRoot = resolve(repoRoot, ".data/e2e/dsh-real");
const sharedEnvironment = {
  ...process.env,
  CHAT_REPO_ROOT: repoRoot,
  CHAT_RUNTIME_KEY: "rtk_dshreale2etestonly0000000000",
  CHAT_TRACE_DIR: resolve(dataRoot, "traces"),
};

const codeServer = {
  command: "node scripts/workbench/start-fixed-code-server.mjs",
  cwd: repoRoot,
  port: 43_119,
  reuseExistingServer: false,
  timeout: 180_000,
  env: dshRealWorkbenchEnvironment(repoRoot, process.env),
} as const;
const workflow = {
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
} as const;
const api = {
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
} as const;
const dsh = {
  command: "node scripts/e2e/start-dsh-real.mjs",
  cwd: repoRoot,
  url: "http://127.0.0.1:43110/",
  reuseExistingServer: false,
  timeout: 120_000,
  env: dshRealWebEnvironment(repoRoot, process.env),
} as const;
const dshPwa = {
  command: "node scripts/e2e/start-dsh-pwa-real.mjs",
  cwd: repoRoot,
  url: "http://127.0.0.1:43110/healthz",
  reuseExistingServer: false,
  timeout: 120_000,
  env: dshRealWebEnvironment(repoRoot, process.env),
} as const;

/**
 * 默认付费门使用真实JSON Product Store、Workflow World、pi与百炼；显式
 * workbench-only模式只监督DSH/Gateway/code-server，从进程拓扑上移除Provider路径。
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: workbenchOnly
    ? "dsh-workbench-real.spec.ts"
    : pwaOnly
      ? "dsh-pwa-real.spec.ts"
      : "dsh-planning-real.spec.ts",
  globalTeardown: resolve(repoRoot, "scripts/e2e/dsh-real-workbench-lifecycle.mjs"),
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
  webServer: workbenchOnly
    ? [codeServer, dsh]
    : pwaOnly
      ? [dshPwa]
      : [codeServer, workflow, api, dsh],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
