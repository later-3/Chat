import { spawn } from "node:child_process";
import { createServer } from "node:http";

const host = "127.0.0.1";
const executorPort = Number.parseInt(process.env.CHAT_PI_EXECUTOR_PORT ?? "45515", 10);
const controlPort = Number.parseInt(process.env.CHAT_CAPABILITY_E2E_CONTROL_PORT ?? "45516", 10);
const controlToken = process.env.CHAT_CAPABILITY_E2E_CONTROL_TOKEN ?? "";
if (!Number.isInteger(executorPort) || !Number.isInteger(controlPort) || controlToken === "") {
  throw new Error("Capability E2E Pi supervisor配置不完整");
}

const allowedNames = new Set([
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SHELL",
  "TERM",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "COREPACK_HOME",
  "COREPACK_ENABLE_DOWNLOAD_PROMPT",
  "npm_config_store_dir",
  "CHAT_REPO_ROOT",
  "CHAT_RUNTIME_KEY",
  "CHAT_TRACE_DIR",
  "CHAT_RUN_ACTIVITY_DIR",
  "CHAT_DSH_E2E_DATA_ROOT",
  "CHAT_WORKSPACE_ROOTS_JSON",
  "CHAT_PI_EXECUTOR_PORT",
  "CHAT_PI_EXECUTOR_DATA_DIR",
  "CHAT_API_INTERNAL_BASE_URL",
  "CHAT_CAPABILITY_E2E_ENV_SENTINEL_PATH",
  "CHAT_CAPABILITY_E2E_RESULT_LOSS_MARKER_PATH",
]);
const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry) => allowedNames.has(entry[0]) && typeof entry[1] === "string" && entry[1] !== "",
  ),
);

let child;
let stopping = false;
let restartTail = Promise.resolve();

function spawnChild() {
  const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const next = spawn(
    executable,
    ["--filter", "@chat/pi-executor", "exec", "tsx", "src/capability-governance-e2e.ts"],
    { cwd: process.cwd(), env: childEnvironment, stdio: "inherit" },
  );
  child = next;
  next.once("exit", (code, signal) => {
    if (child === next) child = undefined;
    if (!stopping && code !== 0) {
      process.stderr.write(
        `[capability-e2e-supervisor] Pi child退出 code=${String(code)} signal=${String(signal)}\n`,
      );
    }
  });
  return next;
}

async function waitForExit(target) {
  if (target.exitCode !== null || target.signalCode !== null) return;
  await new Promise((resolve) => target.once("exit", resolve));
}

async function waitForHealth() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${host}:${String(executorPort)}/healthz`);
      if (response.ok) return;
    } catch {
      // 重启窗口内端口暂时关闭是预期状态。
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Capability E2E Pi重启后未恢复健康");
}

async function restartChild() {
  const current = child;
  if (current !== undefined) {
    current.kill("SIGTERM");
    await waitForExit(current);
  }
  spawnChild();
  await waitForHealth();
}

spawnChild();
const control = createServer((request, response) => {
  if (
    request.method !== "POST" ||
    request.url !== "/restart" ||
    request.headers["x-capability-e2e-control"] !== controlToken
  ) {
    response.writeHead(404).end();
    return;
  }
  restartTail = restartTail.then(restartChild);
  void restartTail.then(
    () => {
      response.writeHead(204).end();
    },
    (error) => {
      response
        .writeHead(500, { "content-type": "application/json" })
        .end(JSON.stringify({ error: error instanceof Error ? error.message : "restart failed" }));
    },
  );
});
await new Promise((resolve, reject) => {
  control.once("error", reject);
  control.listen(controlPort, host, resolve);
});

async function shutdown() {
  if (stopping) return;
  stopping = true;
  const current = child;
  if (current !== undefined) current.kill("SIGTERM");
  if (current !== undefined) await waitForExit(current);
  await new Promise((resolve, reject) =>
    control.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => void shutdown().then(() => process.exit(0)));
}
