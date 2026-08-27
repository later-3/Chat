import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { DSH_PROMPT_STUDIO_E2E_PORTS, dshRealWebEnvironment } from "./dsh-real-environment.mjs";

/**
 * Prompt Studio真实门使用Chat API、DSH与Pi Executor的只读Agent配置接口。
 * 不启动Workflow，也不发起Provider请求；三个进程由同一个Playwright webServer
 * 根进程监督，避免独立pnpm包装器在Playwright收敛时互相丢失生命周期。
 */
const repoRoot = resolve(import.meta.dirname, "../..");
const dataRoot = resolve(repoRoot, ".data/e2e/dsh-real");
const ports = DSH_PROMPT_STUDIO_E2E_PORTS;
const children = new Map();
let stopping = false;

function start(name, command, args, environment) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: environment,
    stdio: "inherit",
  });
  children.set(name, child);
  child.once("error", (error) => {
    console.error(`[prompt-studio-e2e] ${name}无法启动：${error.message}`);
    stop("SIGTERM");
    process.exitCode = 1;
  });
  child.once("close", (code, signal) => {
    children.delete(name);
    if (stopping) return;
    console.error(
      `[prompt-studio-e2e] ${name}意外退出：exit=${String(code)} signal=${String(signal)}`,
    );
    process.exitCode = 1;
    stop("SIGTERM");
  });
  return child;
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  for (const child of children.values()) child.kill(signal);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => stop(signal));
}

const sharedEnvironment = {
  ...process.env,
  CHAT_REPO_ROOT: repoRoot,
  CHAT_WORKSPACE_ROOTS_JSON: JSON.stringify([
    {
      rootId: "root_chat",
      displayName: "Chat 工作区",
      canonicalPath: repoRoot,
    },
  ]),
  CHAT_RUNTIME_KEY: "rtk_dshreale2etestonly0000000000",
  CHAT_TRACE_DIR: resolve(dataRoot, "traces"),
};
start(
  "piExecutor",
  process.execPath,
  [
    "--import",
    resolve(repoRoot, "apps/pi-executor/node_modules/tsx/dist/loader.mjs"),
    "apps/pi-executor/src/index.ts",
  ],
  {
    ...sharedEnvironment,
    CHAT_PI_EXECUTOR_PORT: String(ports.piExecutor),
    CHAT_PI_EXECUTOR_DATA_DIR: resolve(dataRoot, "pi-executor-profile"),
    CHAT_API_INTERNAL_BASE_URL: `http://127.0.0.1:${String(ports.api)}`,
  },
);
start(
  "api",
  process.execPath,
  [
    "--import",
    resolve(repoRoot, "apps/api/node_modules/tsx/dist/loader.mjs"),
    "apps/api/src/index.ts",
  ],
  {
    ...sharedEnvironment,
    PORT: String(ports.api),
    CHAT_API_HOST: "127.0.0.1",
    CHAT_PRODUCT_STORE_PATH: resolve(dataRoot, "product-store.v1.json"),
    // Prompt Studio没有Workflow动作；保留组合根要求的私有地址，但不启动Runtime。
    CHAT_WORKFLOW_BASE_URL: `http://127.0.0.1:${String(ports.workflowPlaceholder)}`,
    CHAT_PI_EXECUTOR_INTERNAL_BASE_URL: `http://127.0.0.1:${String(ports.piExecutor)}`,
  },
);
start("dsh", process.execPath, ["scripts/e2e/start-dsh-pwa-real.mjs"], {
  ...dshRealWebEnvironment(repoRoot, {
    ...sharedEnvironment,
    CHAT_API_BASE_URL: `http://127.0.0.1:${String(ports.api)}`,
    CHAT_PUBLIC_WEB_PORT: String(ports.web),
    CHAT_DSH_INTERNAL_WEB_PORT: String(ports.webInternal),
  }),
});

await new Promise((resolveExit) => {
  const timer = setInterval(() => {
    if (children.size === 0) {
      clearInterval(timer);
      resolveExit();
    }
  }, 50);
});
