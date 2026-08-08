import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const service = process.argv[2];
const commands = {
  api: ["pnpm", ["--filter", "@chat/api", "start"]],
  workflow: ["pnpm", ["--filter", "@chat/workflows", "start:runtime"]],
};
const command = commands[service];
if (command === undefined) throw new Error("restartable service仅支持api/workflow");

const repoRoot = resolve(process.env.CHAT_REPO_ROOT ?? process.cwd());
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

function atomicEvidence(value) {
  const temporary = `${generationPath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, generationPath);
}

function start(requestId) {
  generation += 1;
  child = spawn(command[0], command[1], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    detached: true,
  });
  if (child.pid === undefined) throw new Error(`${service}子进程无PID`);
  atomicEvidence({
    schemaVersion: "chat-e2e-service-generation.v1",
    service,
    generation,
    requestId,
    childPid: child.pid,
    command: basename(command[0]),
    startedAt: new Date().toISOString(),
  });
  child.once("exit", (code, signal) => {
    if (!stopping && !restarting) {
      console.error(
        `[e2e-supervisor] ${service}意外退出 code=${String(code)} signal=${String(signal)}`,
      );
      process.exitCode = 1;
    }
  });
}

async function stopChild() {
  if (child === undefined || child.exitCode !== null || child.pid === undefined) return;
  const pid = child.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  const exited = await Promise.race([
    new Promise((resolveExit) => child.once("exit", () => resolveExit(true))),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 7_000)),
  ]);
  if (!exited) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

async function restart(requestId) {
  restarting = true;
  await stopChild();
  start(requestId);
  handledRequestId = requestId;
  restarting = false;
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
  await stopChild();
  process.exit(signal === "SIGTERM" ? 0 : 130);
}

start("initial");
const timer = setInterval(() => void inspectRequest(), 100);
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
