import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import {
  DSH_PROMPT_STUDIO_E2E_PORTS,
  DSH_PROMPT_THREE_GATES_E2E_PORTS,
  DSH_PROJECT_BOOTSTRAP_E2E_PORTS,
  DSH_REAL_E2E_PORTS,
  dshRealWebEnvironment,
  dshRealWorkbenchEnvironment,
} from "../../scripts/e2e/dsh-real-environment.mjs";

const workbenchOnly = process.env.CHAT_DSH_E2E_MODE === "workbench-only";
const pwaOnly = process.env.CHAT_DSH_E2E_MODE === "pwa-only";
const trajectoryOnly = process.env.CHAT_DSH_E2E_MODE === "trajectory-only";
const promptStudioOnly = process.env.CHAT_DSH_E2E_MODE === "prompt-studio-only";
const promptThreeGatesOnly = process.env.CHAT_DSH_E2E_MODE === "prompt-three-gates-only";
const projectBootstrapOnly = process.env.CHAT_DSH_E2E_MODE === "project-bootstrap-only";
const providerEnvironmentModule = "../../scripts/debug/load-provider-env.mjs";
if (!workbenchOnly && !pwaOnly && !trajectoryOnly && !promptStudioOnly && !projectBootstrapOnly)
  await import(providerEnvironmentModule);

const repoRoot = resolve(import.meta.dirname, "../..");
const dataRoot = resolve(
  repoRoot,
  promptThreeGatesOnly
    ? ".data/e2e/dsh-prompt-three-gates-real"
    : projectBootstrapOnly
      ? ".data/e2e/dsh-project-bootstrap-real"
      : ".data/e2e/dsh-real",
);
const sharedEnvironment = {
  ...process.env,
  CHAT_REPO_ROOT: repoRoot,
  CHAT_RUNTIME_KEY: "rtk_dshreale2etestonly0000000000",
  CHAT_TRACE_DIR: resolve(dataRoot, "traces"),
  CHAT_RUN_ACTIVITY_DIR: resolve(dataRoot, "run-activity"),
};
const promptThreeGatesEnvironment = {
  ...sharedEnvironment,
  CHAT_DSH_E2E_DATA_ROOT: dataRoot,
  CHAT_DSH_E2E_TEMP_ROOT: resolve(repoRoot, ".data/e2e/dsh-t3-tmp"),
  CHAT_PROJECT_ROOTS_JSON: JSON.stringify([
    {
      rootId: "root_chat",
      displayName: "Chat 工作区",
      canonicalPath: repoRoot,
      enabledAdapters: [
        "local-git-workspace.v1",
        "project-document-manifest.v1",
        "package-script-catalog.v1",
      ],
    },
  ]),
};

const codeServer = {
  command: "node scripts/workbench/start-fixed-code-server.mjs",
  cwd: repoRoot,
  port: DSH_REAL_E2E_PORTS.workbenchLease,
  reuseExistingServer: false,
  timeout: 180_000,
  env: dshRealWorkbenchEnvironment(repoRoot, process.env),
} as const;
const workflow = {
  command: "pnpm --filter @chat/workflows start:runtime",
  cwd: repoRoot,
  url: `http://127.0.0.1:${String(DSH_REAL_E2E_PORTS.workflow)}/healthz`,
  reuseExistingServer: false,
  timeout: 180_000,
  env: {
    ...sharedEnvironment,
    CHAT_WORKFLOW_PORT: String(DSH_REAL_E2E_PORTS.workflow),
    CHAT_WORKFLOW_DATA_DIR: resolve(dataRoot, "workflow"),
    CHAT_RUNTIME_BINDINGS_PATH: resolve(dataRoot, "runtime-bindings.v1.json"),
    CHAT_API_INTERNAL_BASE_URL: `http://127.0.0.1:${String(DSH_REAL_E2E_PORTS.api)}`,
    CHAT_PI_EXECUTOR_INTERNAL_BASE_URL: `http://127.0.0.1:${String(DSH_REAL_E2E_PORTS.piExecutor)}`,
  },
} as const;
const piExecutor = {
  command: "pnpm --filter @chat/pi-executor start",
  cwd: repoRoot,
  url: `http://127.0.0.1:${String(DSH_REAL_E2E_PORTS.piExecutor)}/healthz`,
  reuseExistingServer: false,
  timeout: 180_000,
  env: {
    ...sharedEnvironment,
    CHAT_PI_EXECUTOR_PORT: String(DSH_REAL_E2E_PORTS.piExecutor),
    CHAT_PI_EXECUTOR_DATA_DIR: resolve(dataRoot, "pi-executor"),
    CHAT_API_INTERNAL_BASE_URL: `http://127.0.0.1:${String(DSH_REAL_E2E_PORTS.api)}`,
  },
} as const;
const api = {
  command: "pnpm --filter @chat/api start",
  cwd: repoRoot,
  url: `http://127.0.0.1:${String(DSH_REAL_E2E_PORTS.api)}/api/readyz`,
  reuseExistingServer: false,
  timeout: 180_000,
  env: {
    ...sharedEnvironment,
    PORT: String(DSH_REAL_E2E_PORTS.api),
    CHAT_API_HOST: "127.0.0.1",
    CHAT_PRODUCT_STORE_PATH: resolve(dataRoot, "product-store.v1.json"),
    CHAT_WORKFLOW_BASE_URL: `http://127.0.0.1:${String(DSH_REAL_E2E_PORTS.workflow)}`,
    CHAT_PI_EXECUTOR_INTERNAL_BASE_URL: `http://127.0.0.1:${String(DSH_REAL_E2E_PORTS.piExecutor)}`,
  },
} as const;
const dsh = {
  command: "node scripts/e2e/start-dsh-real.mjs",
  cwd: repoRoot,
  url: `http://127.0.0.1:${String(DSH_REAL_E2E_PORTS.web)}/`,
  reuseExistingServer: false,
  timeout: 120_000,
  env: dshRealWebEnvironment(repoRoot, process.env),
} as const;
const dshPwa = {
  command: "node scripts/e2e/start-dsh-pwa-real.mjs",
  cwd: repoRoot,
  url: `http://127.0.0.1:${String(DSH_REAL_E2E_PORTS.web)}/healthz`,
  reuseExistingServer: false,
  timeout: 120_000,
  env: dshRealWebEnvironment(repoRoot, process.env),
} as const;
const trajectoryDsh = {
  ...dshPwa,
  env: dshRealWebEnvironment(repoRoot, {
    ...sharedEnvironment,
    CHAT_WEB_AUTH_REQUIRED: "0",
    CHAT_PUBLIC_WEB_HOSTNAME: undefined,
  }),
} as const;
const trajectoryApi = {
  command: "node scripts/e2e/start-dsh-trajectory-api.mjs",
  cwd: repoRoot,
  url: `http://127.0.0.1:${String(DSH_REAL_E2E_PORTS.api)}/api/readyz`,
  reuseExistingServer: false,
  timeout: 30_000,
  env: { ...sharedEnvironment, PORT: String(DSH_REAL_E2E_PORTS.api) },
} as const;
const projectBootstrapEnvironment = {
  ...sharedEnvironment,
  CHAT_DSH_E2E_DATA_ROOT: dataRoot,
  CHAT_PROJECT_ROOTS_JSON: JSON.stringify([
    {
      rootId: "root_chat",
      displayName: "Chat",
      canonicalPath: repoRoot,
      enabledAdapters: [
        "local-git-workspace.v1",
        "project-document-manifest.v1",
        "package-script-catalog.v1",
      ],
    },
  ]),
  CHAT_PROJECT_CREATION_ROOTS_JSON: JSON.stringify([
    {
      rootId: "root_code",
      displayName: "Code",
      canonicalPath: resolve(dataRoot, "workspace-root"),
    },
  ]),
};
const projectBootstrapApi = {
  command: "pnpm --filter @chat/api exec tsx e2e/dsh-project-bootstrap-runtime.ts",
  cwd: repoRoot,
  url: `http://127.0.0.1:${String(DSH_PROJECT_BOOTSTRAP_E2E_PORTS.api)}/api/readyz`,
  reuseExistingServer: false,
  timeout: 60_000,
  env: {
    ...projectBootstrapEnvironment,
    PORT: String(DSH_PROJECT_BOOTSTRAP_E2E_PORTS.api),
    CHAT_PRODUCT_STORE_PATH: resolve(dataRoot, "product-store.v1.json"),
  },
} as const;
const projectBootstrapDsh = {
  command: "node scripts/e2e/start-dsh-pwa-real.mjs",
  cwd: repoRoot,
  url: `http://127.0.0.1:${String(DSH_PROJECT_BOOTSTRAP_E2E_PORTS.web)}/healthz`,
  reuseExistingServer: false,
  timeout: 120_000,
  env: dshRealWebEnvironment(repoRoot, {
    ...projectBootstrapEnvironment,
    CHAT_API_BASE_URL: `http://127.0.0.1:${String(DSH_PROJECT_BOOTSTRAP_E2E_PORTS.api)}`,
    CHAT_PUBLIC_WEB_PORT: String(DSH_PROJECT_BOOTSTRAP_E2E_PORTS.web),
    CHAT_DSH_INTERNAL_WEB_PORT: String(DSH_PROJECT_BOOTSTRAP_E2E_PORTS.webInternal),
    CHAT_PUBLIC_WEB_HOSTNAME: undefined,
    CHAT_WEB_AUTH_REQUIRED: "0",
  }),
} as const;
const promptStudioRuntime = {
  command: "node scripts/e2e/start-dsh-prompt-studio-real.mjs",
  cwd: repoRoot,
  url: `http://127.0.0.1:${String(DSH_PROMPT_STUDIO_E2E_PORTS.web)}/healthz`,
  reuseExistingServer: false,
  timeout: 180_000,
  env: sharedEnvironment,
} as const;
const promptThreeGatesPiExecutor = {
  command: "pnpm --filter @chat/pi-executor start",
  cwd: repoRoot,
  url: `http://127.0.0.1:${String(DSH_PROMPT_THREE_GATES_E2E_PORTS.piExecutor)}/healthz`,
  reuseExistingServer: false,
  timeout: 180_000,
  env: {
    ...promptThreeGatesEnvironment,
    CHAT_PI_EXECUTOR_PORT: String(DSH_PROMPT_THREE_GATES_E2E_PORTS.piExecutor),
    CHAT_PI_EXECUTOR_DATA_DIR: resolve(dataRoot, "pi-executor"),
    CHAT_API_INTERNAL_BASE_URL: `http://127.0.0.1:${String(DSH_PROMPT_THREE_GATES_E2E_PORTS.api)}`,
  },
} as const;
const promptThreeGatesWorkflow = {
  command: "pnpm --filter @chat/workflows start:runtime",
  cwd: repoRoot,
  url: `http://127.0.0.1:${String(DSH_PROMPT_THREE_GATES_E2E_PORTS.workflow)}/healthz`,
  reuseExistingServer: false,
  timeout: 180_000,
  env: {
    ...promptThreeGatesEnvironment,
    CHAT_WORKFLOW_PORT: String(DSH_PROMPT_THREE_GATES_E2E_PORTS.workflow),
    CHAT_WORKFLOW_DATA_DIR: resolve(dataRoot, "workflow"),
    CHAT_RUNTIME_BINDINGS_PATH: resolve(dataRoot, "runtime-bindings.v1.json"),
    CHAT_API_INTERNAL_BASE_URL: `http://127.0.0.1:${String(DSH_PROMPT_THREE_GATES_E2E_PORTS.api)}`,
    CHAT_PI_EXECUTOR_INTERNAL_BASE_URL: `http://127.0.0.1:${String(DSH_PROMPT_THREE_GATES_E2E_PORTS.piExecutor)}`,
  },
} as const;
const promptThreeGatesApi = {
  command: "pnpm --filter @chat/api start",
  cwd: repoRoot,
  url: `http://127.0.0.1:${String(DSH_PROMPT_THREE_GATES_E2E_PORTS.api)}/api/readyz`,
  reuseExistingServer: false,
  timeout: 180_000,
  env: {
    ...promptThreeGatesEnvironment,
    PORT: String(DSH_PROMPT_THREE_GATES_E2E_PORTS.api),
    CHAT_API_HOST: "127.0.0.1",
    CHAT_PRODUCT_STORE_PATH: resolve(dataRoot, "product-store.v1.json"),
    CHAT_WORKFLOW_BASE_URL: `http://127.0.0.1:${String(DSH_PROMPT_THREE_GATES_E2E_PORTS.workflow)}`,
    CHAT_PI_EXECUTOR_INTERNAL_BASE_URL: `http://127.0.0.1:${String(DSH_PROMPT_THREE_GATES_E2E_PORTS.piExecutor)}`,
  },
} as const;
const promptThreeGatesDsh = {
  command: "node scripts/e2e/start-dsh-pwa-real.mjs",
  cwd: repoRoot,
  url: `http://127.0.0.1:${String(DSH_PROMPT_THREE_GATES_E2E_PORTS.web)}/healthz`,
  reuseExistingServer: false,
  timeout: 120_000,
  env: dshRealWebEnvironment(repoRoot, {
    ...promptThreeGatesEnvironment,
    CHAT_API_BASE_URL: `http://127.0.0.1:${String(DSH_PROMPT_THREE_GATES_E2E_PORTS.api)}`,
    CHAT_PUBLIC_WEB_PORT: String(DSH_PROMPT_THREE_GATES_E2E_PORTS.web),
    CHAT_DSH_INTERNAL_WEB_PORT: String(DSH_PROMPT_THREE_GATES_E2E_PORTS.webInternal),
    // 该门只监听隔离loopback端口，浏览器又使用全新无状态Context；不得继承
    // 正式部署的Web登录开关或读取用户凭据文件。Provider配置仍只给API/Pi进程。
    CHAT_PUBLIC_WEB_HOSTNAME: undefined,
    CHAT_WEB_AUTH_REQUIRED: "0",
  }),
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
      ? ["dsh-pwa-real.spec.ts", "dsh-mobile-hanui-real.spec.ts"]
      : promptStudioOnly
        ? "dsh-prompt-studio-real.spec.ts"
        : projectBootstrapOnly
          ? "dsh-project-bootstrap-real.spec.ts"
          : promptThreeGatesOnly
            ? "dsh-prompt-three-gates-real.spec.ts"
            : trajectoryOnly
              ? "dsh-trajectory-real.spec.ts"
              : "dsh-planning-real.spec.ts",
  ...(promptThreeGatesOnly || projectBootstrapOnly
    ? {}
    : { globalTeardown: resolve(repoRoot, "scripts/e2e/dsh-real-workbench-lifecycle.mjs") }),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 12 * 60_000,
  expect: { timeout: promptThreeGatesOnly ? 30_000 : 5 * 60_000 },
  use: {
    baseURL: `http://127.0.0.1:${String(
      promptStudioOnly
        ? DSH_PROMPT_STUDIO_E2E_PORTS.web
        : projectBootstrapOnly
          ? DSH_PROJECT_BOOTSTRAP_E2E_PORTS.web
          : promptThreeGatesOnly
            ? DSH_PROMPT_THREE_GATES_E2E_PORTS.web
            : DSH_REAL_E2E_PORTS.web,
    )}`,
    trace: "off",
    screenshot: "off",
    video: "off",
    actionTimeout: promptThreeGatesOnly ? 30_000 : 0,
  },
  webServer: workbenchOnly
    ? [codeServer, dsh]
    : pwaOnly
      ? [dshPwa]
      : promptStudioOnly
        ? [promptStudioRuntime]
        : projectBootstrapOnly
          ? [projectBootstrapApi, projectBootstrapDsh]
          : promptThreeGatesOnly
            ? [
                promptThreeGatesPiExecutor,
                promptThreeGatesWorkflow,
                promptThreeGatesApi,
                promptThreeGatesDsh,
              ]
            : trajectoryOnly
              ? [trajectoryApi, trajectoryDsh]
              : [codeServer, piExecutor, workflow, api, dsh],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
