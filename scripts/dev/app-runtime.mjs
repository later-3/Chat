import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  FROZEN_PORTS,
  ROLE_COMMAND_FRAGMENTS,
  assertRetiredPortsEmpty,
  checkPorts,
  frozenPortList,
  loadPidEntries,
  recordPidEntry,
  removePidEntry,
  terminateOwnedChatPortProcesses,
  terminateRecorded,
} from "../debug/lib.mjs";
import { ensureFixedMemmy } from "../memory/fixed-memmy.mjs";
import { ensureFixedMemoryCore } from "../memory/fixed-memorycore.mjs";
import { assertDshCliRuntimeClosure, dshWebEnvironment } from "../dsh/profile-runtime.mjs";
import {
  codeServerRunRoot,
  ensureFixedCodeServer,
  probeCodeServerSocketReady,
  resolveCodeServerTemporaryParent,
} from "../workbench/fixed-code-server.mjs";
import { reconcileManagedWorkbench } from "../workbench/process-lifecycle.mjs";
export { reconcileManagedWorkbench } from "../workbench/process-lifecycle.mjs";
import { cleanupOwnedDebugBrowser } from "./browser-lifecycle.mjs";

export const MEMORY_PROFILES = Object.freeze(["all", "memmy", "memorycore"]);
export const WORKBENCH_PROFILES = Object.freeze(["off", "code-server"]);
const READY_POLL_INTERVAL_MS = 250;
const READY_REQUEST_TIMEOUT_MS = 1_500;

export function parseDevArgs(argv) {
  const options = { debug: false, help: false, memory: "all", workbench: "code-server" };
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
    if (argument.startsWith("--workbench=")) {
      const value = argument.slice("--workbench=".length);
      if (!WORKBENCH_PROFILES.includes(value)) {
        throw new Error(`--workbench只支持 ${WORKBENCH_PROFILES.join("、")}`);
      }
      options.workbench = value;
      continue;
    }
    throw new Error(`未知参数：${argument}`);
  }
  return options;
}

export function devUsage() {
  return [
    "用法: pnpm dev [-- --memory=all|memmy|memorycore] [--workbench=off|code-server]",
    "      pnpm dev:debug [-- --memory=all|memmy|memorycore] [--workbench=off|code-server]",
    "",
    "默认启动两套本地Memory依赖、Workflow、API、code-server Workbench和DSH Web。",
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

/**
 * 本地launcher、独立status与prepare必须各自从同一repo/env确定合同，不能依赖launcher
 * 曾经临时改写自身process.env。显式配置仍可用；默认cache按Git common-dir共享。
 */
export function resolveLocalWorkbenchRuntimeContract(root, environment = process.env) {
  const repoRoot = resolve(root);
  return Object.freeze({
    CHAT_CODE_WORKBENCH_RUN_ROOT: codeServerRunRoot(repoRoot, environment),
    CHAT_CODE_WORKBENCH_TEMP_PARENT: resolveCodeServerTemporaryParent(environment),
    CHAT_FIXED_SOURCE_CACHE_ROOT: resolveSharedFixedCacheRoot(repoRoot, environment),
  });
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
  workbench = "code-server",
  environment = process.env,
}) {
  if (!MEMORY_PROFILES.includes(memory)) throw new Error(`未知Memory Profile：${memory}`);
  if (!WORKBENCH_PROFILES.includes(workbench)) {
    throw new Error(`未知Workbench Profile：${workbench}`);
  }
  const repoRoot = resolve(root);
  const workbenchRuntime = resolveLocalWorkbenchRuntimeContract(repoRoot, environment);
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

  if (workbench === "code-server") {
    const workbenchEnvironment = {};
    for (const name of [
      "PATH",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "TZ",
      "SHELL",
      "TERM",
      "TMPDIR",
      "TMP",
      "TEMP",
    ]) {
      const value = environment[name];
      if (typeof value === "string" && value !== "") workbenchEnvironment[name] = value;
    }
    services.push({
      id: "workbench",
      role: "workbench",
      command: process.execPath,
      args: [join(repoRoot, "scripts/workbench/start-fixed-code-server.mjs")],
      cwd: repoRoot,
      env: {
        ...workbenchEnvironment,
        CHAT_REPO_ROOT: repoRoot,
        CHAT_CODE_WORKBENCH_ROOT: repoRoot,
        ...workbenchRuntime,
      },
      readyDescription: "受管0600 Unix socket /healthz",
      readyProbe: ({ timeoutMs }) =>
        probeCodeServerSocketReady(repoRoot, {
          environment: workbenchRuntime,
          timeoutMs,
        }),
      timeoutMs: 30_000,
      stopTimeoutMs: 7_000,
    });
  }

  services.push({
    id: "web",
    role: "web",
    port: FROZEN_PORTS.web,
    command: process.execPath,
    args: [join(repoRoot, "scripts/dsh/start-web.mjs")],
    cwd: repoRoot,
    env: dshWebEnvironment(repoRoot, {
      ...environment,
      CHAT_CODE_WORKBENCH_ENABLED: workbench === "code-server" ? "1" : "0",
      ...workbenchRuntime,
    }),
    readyUrl: `http://127.0.0.1:${FROZEN_PORTS.web}/`,
    timeoutMs: 60_000,
    // rc.6为整棵Cordis应用保留5秒dispose窗口；监督器稍晚再升级SIGKILL。
    stopTimeoutMs: 7_000,
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

export function runVersionRecoveryCommand({
  root,
  signal,
  spawnImpl = spawn,
  environment = process.env,
}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawnImpl(
      pnpmExecutable(),
      [
        "--filter",
        "@chat/api",
        "exec",
        "tsx",
        "../../scripts/dev/settle-incompatible-workflows.ts",
      ],
      {
        cwd: root,
        env: {
          ...withoutVsCodeAutoAttach(environment),
          CHAT_REPO_ROOT: root,
        },
        stdio: ["ignore", "pipe", "pipe"],
        signal,
      },
    );
    forwardLines(child.stdout, "prepare", process.stdout);
    forwardLines(child.stderr, "prepare", process.stderr);
    child.once("error", rejectRun);
    child.once("close", (code, childSignal) => {
      if (code === 0) resolveRun();
      else
        rejectRun(
          new Error(
            `Workflow版本恢复检查失败（code=${String(code)} signal=${childSignal ?? "none"}）`,
          ),
        );
    });
  });
}

export function runDshPreparationCommand({
  root,
  signal,
  spawnImpl = spawn,
  environment = process.env,
}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawnImpl(pnpmExecutable(), ["--filter", "@chat/dsh-web", "prepare:profile"], {
      cwd: root,
      env: dshWebEnvironment(root, environment),
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    forwardLines(child.stdout, "prepare", process.stdout);
    forwardLines(child.stderr, "prepare", process.stderr);
    child.once("error", rejectRun);
    child.once("close", (code, childSignal) => {
      if (code === 0) resolveRun();
      else {
        rejectRun(
          new Error(
            `DSH Web Profile准备失败（code=${String(code)} signal=${childSignal ?? "none"}）`,
          ),
        );
      }
    });
  });
}

/**
 * 回收登记丢失但仍可严格证明属于同一Git仓库的Chat固定端口进程。
 * 身份识别与最终发信号之间还会由terminateEntry再次校验命令和启动时间。
 */
export function reclaimOwnedPortOccupants(root, occupied, dependencies) {
  return terminateOwnedChatPortProcesses(root, occupied, dependencies);
}

export async function preflightLocalRuntime(
  root,
  { workbench = "code-server" } = {},
  { retiredPortGuard = assertRetiredPortsEmpty } = {},
) {
  if (!WORKBENCH_PROFILES.includes(workbench)) {
    throw new Error(`未知Workbench Profile：${workbench}`);
  }
  // 退役43113永远只检查不回收，且必须发生在PID登记/legacy evidence清理之前。
  await retiredPortGuard();
  const activePorts = frozenPortList();
  const entries = loadPidEntries();
  for (const result of terminateRecorded(entries)) {
    console.log(`[chat] 清理 ${result.role} pid=${result.pid}: ${result.action}`);
  }
  if (entries.length > 0) await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  const workbenchRecovery = await reconcileManagedWorkbench(root);
  if (
    workbenchRecovery.action !== "no-evidence" &&
    workbenchRecovery.action !== "already-stopped"
  ) {
    console.log(`[chat] 清理Unix socket Workbench：${workbenchRecovery.action}`);
  }
  const browserCleanup = await cleanupOwnedDebugBrowser(root);
  if (browserCleanup.terminatedPids.length > 0 || browserCleanup.removedLocks.length > 0) {
    console.log(
      `[chat] 清理专属调试浏览器：processes=${browserCleanup.terminatedPids.length}, locks=${browserCleanup.removedLocks.length}`,
    );
  }
  let occupied = checkPorts(activePorts);
  if (occupied.length > 0) {
    const recovered = reclaimOwnedPortOccupants(root, occupied);
    for (const result of recovered) {
      console.log(`[chat] 清理同仓库遗留 ${result.role} pid=${result.pid}: ${result.action}`);
    }
    if (recovered.length > 0) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      occupied = checkPorts(activePorts);
    }
  }
  if (occupied.length === 0) {
    console.log(`[chat] 固定端口可用：${activePorts.join(", ")}`);
    return;
  }
  const details = occupied
    .map((item) => `${item.port}(pid=${item.pid}, process=${item.processName})`)
    .join("、");
  throw new Error(`固定端口被未登记进程占用，已拒绝清理：${details}`);
}

export async function prepareLocalRuntime({ root, memory, workbench = "code-server", signal }) {
  await preflightLocalRuntime(root, { workbench });
  if (signal?.aborted) throw signal.reason ?? new Error("启动已取消");
  const workbenchRuntime = resolveLocalWorkbenchRuntimeContract(root);
  console.log(`[chat] 固定源码缓存：${workbenchRuntime.CHAT_FIXED_SOURCE_CACHE_ROOT}`);
  if (memory === "all" || memory === "memmy") ensureFixedMemmy(root);
  if (signal?.aborted) throw signal.reason ?? new Error("启动已取消");
  if (memory === "all" || memory === "memorycore") ensureFixedMemoryCore(root);
  if (signal?.aborted) throw signal.reason ?? new Error("启动已取消");
  if (workbench === "code-server") {
    console.log("[chat] 准备固定code-server Workbench…");
    await ensureFixedCodeServer(root, { environment: workbenchRuntime });
  }
  if (signal?.aborted) throw signal.reason ?? new Error("启动已取消");
  console.log("[chat] 构建Workflow Bundles…");
  await runPreparationCommand({ root, signal });
  if (signal?.aborted) throw signal.reason ?? new Error("启动已取消");
  console.log("[chat] 检查活动Workflow版本兼容性…");
  await runVersionRecoveryCommand({ root, signal });
  if (signal?.aborted) throw signal.reason ?? new Error("启动已取消");
  console.log("[chat] 准备DSH Web Profile与LifeOS Bridge…");
  await runDshPreparationCommand({ root, signal });
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
        `${definition.id}启动超时（${definition.timeoutMs}ms，${definition.readyDescription ?? definition.readyUrl}）`,
      );
    }
    try {
      if (definition.readyProbe !== undefined) {
        await definition.readyProbe({
          timeoutMs: Math.min(READY_REQUEST_TIMEOUT_MS, remaining),
          signal,
        });
        return now() - startedAt;
      }
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
    "apps/dsh-web/node_modules/@deepseek-ai/dsh/package.json",
    "apps/api/node_modules/tsx/dist/loader.mjs",
    "packages/dsh-lifeos-bridge/package.json",
    "packages/workflows/node_modules/tsx/dist/loader.mjs",
  ];
  const missing = required.filter((path) => !existsSync(join(root, path)));
  if (missing.length > 0) {
    throw new Error(
      `依赖未安装或Workspace链接缺失：${missing.join("、")}；请先运行 pnpm install --frozen-lockfile`,
    );
  }
  assertDshCliRuntimeClosure(root);
}
