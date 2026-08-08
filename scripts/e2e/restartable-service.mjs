import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const service = process.argv[2];
const repoRoot = resolve(process.env.CHAT_REPO_ROOT ?? process.cwd());
function directTsxCommand(packageRoot, entry) {
  const tsxRoot = resolve(repoRoot, packageRoot, "node_modules/tsx/dist");
  return [
    process.execPath,
    [
      "--require",
      resolve(tsxRoot, "preflight.cjs"),
      "--import",
      pathToFileURL(resolve(tsxRoot, "loader.mjs")).href,
      resolve(repoRoot, entry),
    ],
  ];
}
const commands = {
  api: directTsxCommand("apps/api", "apps/api/src/index.ts"),
  workflow: directTsxCommand("packages/workflows", "packages/workflows/src/runtime-main.ts"),
};
const command = commands[service];
if (command === undefined) throw new Error("restartable service仅支持api/workflow");

const restartRoot = resolve(process.env.CHAT_E2E_RESTART_ROOT ?? "");
if (!restartRoot.startsWith(resolve(repoRoot, ".data/e2e/") + "/")) {
  throw new Error("restart evidence必须位于Chat .data/e2e下");
}
mkdirSync(restartRoot, { recursive: true });
const requestPath = resolve(restartRoot, `${service}.request.json`);
const generationPath = resolve(restartRoot, `${service}.generation.json`);
let generation = 0;
let child;
let stopping = false;
let restarting = false;
let handledRequestId;
let transition = Promise.resolve();

function enqueueTransition(work) {
  const pending = transition.then(work, work);
  transition = pending.catch(() => undefined);
  return pending;
}

function atomicEvidence(value) {
  const temporary = `${generationPath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, generationPath);
}

function start(requestId) {
  generation += 1;
  const started = spawn(command[0], command[1], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (started.pid === undefined) throw new Error(`${service}子进程无PID`);
  child = started;
  atomicEvidence({
    schemaVersion: "chat-e2e-service-generation.v1",
    service,
    generation,
    requestId,
    childPid: started.pid,
    command: basename(command[0]),
    startedAt: new Date().toISOString(),
  });
  started.once("exit", (code, signal) => {
    if (child === started && !stopping && !restarting) {
      console.error(
        `[e2e-supervisor] ${service}意外退出 code=${String(code)} signal=${String(signal)}`,
      );
      process.exitCode = 1;
    }
  });
}

async function stopChild() {
  if (child === undefined || child.exitCode !== null || child.pid === undefined) return;
  const stoppingChild = child;
  stoppingChild.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolveExit) => stoppingChild.once("exit", () => resolveExit(true))),
    // 子进程直接运行tsx loader，没有pnpm/tsx孙进程；先TERM，1.5秒仍未退出才KILL。
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 1_500)),
  ]);
  if (!exited) stoppingChild.kill("SIGKILL");
  if (child === stoppingChild) child = undefined;
}

async function restart(requestId) {
  restarting = true;
  try {
    await enqueueTransition(async () => {
      await stopChild();
      // shutdown可能在stopChild等待期间到达；此时绝不能再拉起一个孤儿子进程。
      if (stopping) return;
      start(requestId);
      handledRequestId = requestId;
    });
  } finally {
    restarting = false;
  }
}

async function inspectRequest() {
  if (stopping || restarting || !existsSync(requestPath)) return;
  let request;
  try {
    request = JSON.parse(readFileSync(requestPath, "utf8"));
  } catch {
    return;
  }
  if (
    request?.schemaVersion !== "chat-e2e-service-restart.v1" ||
    typeof request?.requestId !== "string" ||
    request.requestId === handledRequestId
  )
    return;
  await restart(request.requestId);
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await enqueueTransition(stopChild);
  process.exit(signal === "SIGTERM" ? 0 : 130);
}

start("initial");
const timer = setInterval(
  () =>
    void inspectRequest().catch(() => {
      console.error(`[e2e-supervisor] ${service}重启失败`);
      process.exitCode = 1;
    }),
  100,
);
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
