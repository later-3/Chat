import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  FROZEN_PORTS,
  ROLE_COMMAND_FRAGMENTS,
  checkPorts,
  frozenPortList,
  loadPidEntries,
  recordPidEntry,
  removePidEntry,
  terminateRecorded,
} from "../debug/lib.mjs";
import { ensureFixedMemmy } from "../memory/fixed-memmy.mjs";
import { ensureFixedMemoryCore } from "../memory/fixed-memorycore.mjs";
import { cleanupOwnedDebugBrowser } from "./browser-lifecycle.mjs";

export const MEMORY_PROFILES = Object.freeze(["all", "memmy", "memorycore"]);
const READY_POLL_INTERVAL_MS = 250;
const READY_REQUEST_TIMEOUT_MS = 1_500;

export function parseDevArgs(argv) {
  const options = { debug: false, help: false, memory: "all" };
  for (const argument of argv) {
    if (argument === "--debug") {
      options.debug = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument.startsWith("--memory=")) {
      const value = argument.slice("--memory=".length);
      if (!MEMORY_PROFILES.includes(value)) {
        throw new Error(`--memory只支持 ${MEMORY_PROFILES.join("、")}`);
      }
      options.memory = value;
      continue;
    }
    throw new Error(`未知参数：${argument}`);
  }
  return options;
}

export function devUsage() {
  return [
    "用法: pnpm dev [-- --memory=all|memmy|memorycore]",
    "      pnpm dev:debug [-- --memory=all|memmy|memorycore]",
    "",
    "默认启动两套本地Memory依赖、Workflow、API和Web。",
  ].join("\n");
}

export function sharedCacheRootFromGitCommonDir(root, gitCommonDir) {
  const commonDirectory = resolve(root, gitCommonDir);
  if (!commonDirectory.endsWith("/.git")) {
    throw new Error(`无法从Git Common Directory确定共享缓存根：${commonDirectory}`);
  }
  return join(resolve(commonDirectory, ".."), ".data/cache");
}

export function resolveSharedFixedCacheRoot(root, environment = process.env) {
  const configured = environment.CHAT_FIXED_SOURCE_CACHE_ROOT?.trim();
  if (configured) return resolve(configured);
  try {
    const commonDirectory = execFileSync("git", ["-C", root, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return sharedCacheRootFromGitCommonDir(root, commonDirectory);
  } catch {
    return join(root, ".data/cache");
  }
}

function withoutVsCodeAutoAttach(environment) {
  const isolated = { ...environment };
  if (isolated.VSCODE_INSPECTOR_OPTIONS !== undefined) {
    delete isolated.VSCODE_INSPECTOR_OPTIONS;
    delete isolated.NODE_OPTIONS;
  }
  return isolated;
}

function commonEnvironment(root, environment) {
  return {
    ...environment,
    CHAT_REPO_ROOT: root,
  };
}

export function createServiceDefinitions({
  root,
  debug = false,
  memory = "all",
  environment = process.env,
}) {
  if (!MEMORY_PROFILES.includes(memory)) throw new Error(`未知Memory Profile：${memory}`);
  const repoRoot = resolve(root);
  const memoryCoreEnvironment = join(repoRoot, "scripts/debug/load-memorycore-debug-env.mjs");
  const providerEnvironment = join(repoRoot, "scripts/debug/load-provider-env.mjs");
  const services = [];

  if (memory === "all" || memory === "memmy") {
    services.push({
      id: "memmy",
      role: "memory",
      port: FROZEN_PORTS.memory,
      command: process.execPath,
      args: [join(repoRoot, "scripts/memory/start-fixed-memmy.mjs")],
      cwd: repoRoot,
      env: commonEnvironment(repoRoot, withoutVsCodeAutoAttach(environment)),
      readyUrl: `http://127.0.0.1:${FROZEN_PORTS.memory}/api/v1/health`,
      timeoutMs: 180_000,
      stopTimeoutMs: 7_000,
    });
  }

  if (memory === "all" || memory === "memorycore") {
    services.push({
      id: "memorycore",
      role: "memoryCore",
      port: FROZEN_PORTS.memoryCore,
      command: process.execPath,
      args: [
        "--import",
        memoryCoreEnvironment,
        join(repoRoot, "scripts/memory/start-fixed-memorycore.mjs"),
      ],
      cwd: repoRoot,
      env: {
        ...commonEnvironment(repoRoot, withoutVsCodeAutoAttach(environment)),
        CHAT_TENCENT_MEMORYCORE_RUN_ROOT: join(repoRoot, ".data/debug/memorycore"),
      },
      readyUrl: `http://127.0.0.1:${FROZEN_PORTS.memoryCore}/health`,
      timeoutMs: 180_000,
      stopTimeoutMs: 7_000,
    });
  }

  const workflowArgs = [];
  if (debug) workflowArgs.push(`--inspect=127.0.0.1:${FROZEN_PORTS.workflowInspector}`);
  workflowArgs.push(
    "--import",
    providerEnvironment,
    "--import",
    memoryCoreEnvironment,
    "--import",
    join(repoRoot, "packages/workflows/node_modules/tsx/dist/loader.mjs"),
    join(repoRoot, "packages/workflows/src/runtime-main.ts"),
  );
  services.push({
    id: "workflow",
    role: "workflow",
    port: FROZEN_PORTS.workflow,
    command: process.execPath,
    args: workflowArgs,
    cwd: repoRoot,
    env: {
      ...commonEnvironment(repoRoot, environment),
      CHAT_WORKFLOW_PORT: String(FROZEN_PORTS.workflow),
    },
    readyUrl: `http://127.0.0.1:${FROZEN_PORTS.workflow}/healthz`,
    timeoutMs: 30_000,
    stopTimeoutMs: 3_000,
  });

  const apiArgs = [];
  if (debug) apiArgs.push(`--inspect=127.0.0.1:${FROZEN_PORTS.apiInspector}`);
  apiArgs.push(
    "--import",
    join(repoRoot, "scripts/load-env.mjs"),
    "--import",
    memoryCoreEnvironment,
    "--import",
    join(repoRoot, "apps/api/node_modules/tsx/dist/loader.mjs"),
    join(repoRoot, "apps/api/src/index.ts"),
  );
  services.push({
    id: "api",
    role: "api",
    port: FROZEN_PORTS.api,
    command: process.execPath,
    args: apiArgs,
    cwd: join(repoRoot, "apps/api"),
    env: {
      ...commonEnvironment(repoRoot, environment),
      PORT: String(FROZEN_PORTS.api),
    },
    readyUrl: `http://127.0.0.1:${FROZEN_PORTS.api}/api/readyz`,
    timeoutMs: 30_000,
    stopTimeoutMs: 3_000,
  });

  services.push({
    id: "web",
    role: "web",
    port: FROZEN_PORTS.web,
    command: process.execPath,
    args: [
      join(repoRoot, "apps/web/node_modules/vite/bin/vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      String(FROZEN_PORTS.web),
      "--strictPort",
    ],
    cwd: join(repoRoot, "apps/web"),
    env: {
      ...commonEnvironment(repoRoot, withoutVsCodeAutoAttach(environment)),
      CHAT_API_PROXY_URL: `http://127.0.0.1:${FROZEN_PORTS.api}`,
    },
    readyUrl: `http://127.0.0.1:${FROZEN_PORTS.web}/`,
    timeoutMs: 30_000,
    stopTimeoutMs: 3_000,
  });

  return services;
}

function pnpmExecutable() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function forwardLines(stream, prefix, output) {
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/u);
    buffered = lines.pop() ?? "";
    for (const line of lines) output.write(`[${prefix}] ${line}\n`);
  });
  stream.once("end", () => {
    if (buffered !== "") output.write(`[${prefix}] ${buffered}\n`);
  });
}

export function runPreparationCommand({
  root,
  signal,
  spawnImpl = spawn,
  environment = process.env,
}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawnImpl(pnpmExecutable(), ["--filter", "@chat/workflows", "build:bundles"], {
      cwd: root,
      env: {
        ...withoutVsCodeAutoAttach(environment),
        CHAT_REPO_ROOT: root,
      },
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    forwardLines(child.stdout, "prepare", process.stdout);
    forwardLines(child.stderr, "prepare", process.stderr);
    child.once("error", rejectRun);
    child.once("close", (code, childSignal) => {
      if (code === 0) resolveRun();
      else
        rejectRun(
          new Error(
            `Workflow Bundle构建失败（code=${String(code)} signal=${childSignal ?? "none"}）`,
          ),
        );
    });
  });
}

export async function preflightLocalRuntime(root) {
  const entries = loadPidEntries();
  for (const result of terminateRecorded(entries)) {
    console.log(`[chat] 清理 ${result.role} pid=${result.pid}: ${result.action}`);
  }
  if (entries.length > 0) await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  const browserCleanup = await cleanupOwnedDebugBrowser(root);
  if (browserCleanup.terminatedPids.length > 0 || browserCleanup.removedLocks.length > 0) {
    console.log(
      `[chat] 清理专属调试浏览器：processes=${browserCleanup.terminatedPids.length}, locks=${browserCleanup.removedLocks.length}`,
    );
  }
  const occupied = checkPorts();
  if (occupied.length === 0) {
    console.log(`[chat] 固定端口可用：${frozenPortList().join(", ")}`);
    return;
  }
  const details = occupied
    .map((item) => `${item.port}(pid=${item.pid}, process=${item.processName})`)
    .join("、");
  throw new Error(`固定端口被未登记进程占用，已拒绝清理：${details}`);
}

export async function prepareLocalRuntime({ root, memory, signal }) {
  await preflightLocalRuntime(root);
  if (signal?.aborted) throw signal.reason ?? new Error("启动已取消");
  const sharedCacheRoot = resolveSharedFixedCacheRoot(root);
  process.env.CHAT_FIXED_SOURCE_CACHE_ROOT = sharedCacheRoot;
  console.log(`[chat] 固定源码缓存：${sharedCacheRoot}`);
  if (memory === "all" || memory === "memmy") ensureFixedMemmy(root);
  if (signal?.aborted) throw signal.reason ?? new Error("启动已取消");
  if (memory === "all" || memory === "memorycore") ensureFixedMemoryCore(root);
  if (signal?.aborted) throw signal.reason ?? new Error("启动已取消");
  console.log("[chat] 构建Workflow Bundles…");
  await runPreparationCommand({ root, signal });
}

export async function waitForServiceReady({
  definition,
  state,
  signal,
  fetchImpl = fetch,
  now = Date.now,
  sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms)),
}) {
  const startedAt = now();
  const deadline = startedAt + definition.timeoutMs;
  for (;;) {
    if (signal?.aborted) throw signal.reason ?? new Error("启动已取消");
    if (state.spawnError) throw state.spawnError;
    if (state.exited) {
      throw new Error(
        `${definition.id}在就绪前退出（code=${String(state.exited.code)} signal=${state.exited.signal ?? "none"}）`,
      );
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error(
        `${definition.id}启动超时（${definition.timeoutMs}ms，${definition.readyUrl}）`,
      );
    }
    try {
      const response = await fetchImpl(definition.readyUrl, {
        signal: AbortSignal.timeout(Math.min(READY_REQUEST_TIMEOUT_MS, remaining)),
      });
      if (response.ok) return now() - startedAt;
    } catch {
      // 进程仍在启动；下一轮同时复核子进程状态与HTTP探针。
    }
    await sleep(Math.min(READY_POLL_INTERVAL_MS, Math.max(1, remaining)));
  }
}

function waitForExit(state, timeoutMs) {
  if (state.exited) return Promise.resolve(true);
  return Promise.race([
    state.exitPromise.then(() => true),
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), timeoutMs)),
  ]);
}

export class AppSupervisor {
  constructor(
    definitions,
    { spawnImpl = spawn, signal, recordPid = recordPidEntry, removePid = removePidEntry } = {},
  ) {
    this.definitions = definitions;
    this.spawnImpl = spawnImpl;
    this.signal = signal;
    this.recordPid = recordPid;
    this.removePid = removePid;
    this.states = [];
    this.stopping = false;
    this.failureError = undefined;
    this.failure = new Promise((resolveFailure) => {
      this.resolveFailure = resolveFailure;
    });
  }

  async start() {
    for (const definition of this.definitions) {
      if (this.failureError) throw this.failureError;
      await this.startOne(definition);
    }
  }

  async startOne(definition) {
    console.log(`[chat] 启动 ${definition.id}…`);
    const child = this.spawnImpl(definition.command, definition.args, {
      cwd: definition.cwd,
      env: definition.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const state = {
      definition,
      child,
      exited: undefined,
      spawnError: undefined,
      expectedExit: false,
      ready: false,
    };
    if (child.pid === undefined) {
      child.kill("SIGTERM");
      throw new Error(`${definition.id}没有可登记PID`);
    }
    try {
      this.recordPid({
        role: definition.role,
        pid: child.pid,
        port: definition.port,
        killScope: "process",
        startedAt: new Date().toISOString(),
        commandFragments: ROLE_COMMAND_FRAGMENTS[definition.role] ?? [definition.id],
      });
    } catch (error) {
      child.kill("SIGTERM");
      throw new Error(
        `${definition.id}进程登记失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    state.exitPromise = new Promise((resolveExit) => {
      state.resolveExit = resolveExit;
    });
    this.states.push(state);
    forwardLines(child.stdout, definition.id, process.stdout);
    forwardLines(child.stderr, definition.id, process.stderr);
    child.once("error", (error) => {
      state.spawnError = error;
    });
    child.once("close", (code, childSignal) => {
      state.exited = { code, signal: childSignal };
      state.resolveExit();
      try {
        this.removePid(definition.role, child.pid);
      } catch {
        // preclean仍会按端口失败关闭；退出路径只做尽力收敛。
      }
      if (state.ready && !state.expectedExit && !this.stopping) {
        this.fail(
          new Error(
            `${definition.id}意外退出（code=${String(code)} signal=${childSignal ?? "none"}）`,
          ),
        );
      }
    });
    const elapsedMs = await waitForServiceReady({
      definition,
      state,
      signal: this.signal,
    });
    state.ready = true;
    console.log(`[chat] ${definition.id} ready (${elapsedMs}ms)`);
  }

  fail(error) {
    if (this.failureError || this.stopping) return;
    this.failureError = error;
    this.resolveFailure(error);
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    for (const state of [...this.states].reverse()) {
      state.expectedExit = true;
      if (state.exited) {
        this.removePid(state.definition.role, state.child.pid);
        continue;
      }
      console.log(`[chat] 停止 ${state.definition.id}…`);
      state.child.kill("SIGTERM");
      const graceful = await waitForExit(state, state.definition.stopTimeoutMs);
      if (!graceful) {
        state.child.kill("SIGKILL");
        await waitForExit(state, 1_500);
      }
      this.removePid(state.definition.role, state.child.pid);
    }
  }
}

export function assertRuntimeFiles(root) {
  const required = [
    "apps/web/node_modules/vite/bin/vite.js",
    "apps/api/node_modules/tsx/dist/loader.mjs",
    "packages/workflows/node_modules/tsx/dist/loader.mjs",
  ];
  const missing = required.filter((path) => !existsSync(join(root, path)));
  if (missing.length > 0) {
    throw new Error(
      `依赖未安装或Workspace链接缺失：${missing.join("、")}；请先运行 pnpm install --frozen-lockfile`,
    );
  }
}
