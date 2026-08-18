import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  ROLE_COMMAND_FRAGMENTS,
  assertRetiredPortsEmpty,
  checkPorts,
  loadPidEntries,
  probeRetiredPort,
  recordPidEntry,
  removePidEntry,
  terminateOwnedChatPortProcesses,
  terminateRecorded,
} from "../debug/lib.mjs";
import { assertSupportedRuntimeLibc, detectRuntimeLibc } from "../memory/fixed-memmy.mjs";
import { assertDshCliRuntimeClosure, dshWebEnvironment } from "../dsh/profile-runtime.mjs";
import {
  codeServerRunRoot,
  ensureFixedCodeServer,
  probeCodeServerSocketReady,
  readCodeServerProcessEvidence,
  resolveCodeServerTemporaryParent,
} from "../workbench/fixed-code-server.mjs";
import { reconcileManagedWorkbench } from "../workbench/process-lifecycle.mjs";
export { reconcileManagedWorkbench } from "../workbench/process-lifecycle.mjs";
import { cleanupOwnedDebugBrowser } from "./browser-lifecycle.mjs";
import { resolveRuntimeInstance } from "./runtime-instance.mjs";

/** Memory当前冻结关闭；保留字段只为旧命令给出明确失败，而不是保留隐式启用入口。 */
export const MEMORY_PROFILES = Object.freeze(["off"]);
export const WORKBENCH_PROFILES = Object.freeze(["off", "code-server"]);
export const LOCAL_SETUP_NODE_MAJOR = 24;
export const LOCAL_SETUP_NODE_ABI = "137";
export const LOCAL_SETUP_PNPM_VERSION = "10.13.1";
const READY_POLL_INTERVAL_MS = 250;
const READY_REQUEST_TIMEOUT_MS = 1_500;

function nodeMajor(version) {
  const [major = 0] = String(version)
    .replace(/^v/u, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  return major;
}

/**
 * `pnpm run setup`的机器边界。第三方固定工件目前只发布macOS/Linux的x64/arm64，
 * 因此未知平台必须在下载或改写`.data`前失败，而不是准备到一半才报错。
 */
export function assertLocalSetupPrerequisites({
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.versions.node,
  nodeModuleAbi = process.versions.modules,
  libc = detectRuntimeLibc(platform),
  commandVersion = (command, args) =>
    execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim(),
} = {}) {
  if (!(["darwin", "linux"].includes(platform) && ["arm64", "x64"].includes(arch))) {
    throw new Error(`本地一键安装暂不支持 ${platform}/${arch}；仅支持macOS/Linux的arm64/x64`);
  }
  assertSupportedRuntimeLibc(platform, libc);
  if (nodeMajor(nodeVersion) !== LOCAL_SETUP_NODE_MAJOR || nodeModuleAbi !== LOCAL_SETUP_NODE_ABI) {
    throw new Error(
      `Node.js运行时不匹配：${nodeVersion} / ABI ${String(nodeModuleAbi)}；本地安装固定要求Node 24 / ABI ${LOCAL_SETUP_NODE_ABI}`,
    );
  }

  let pnpmVersion;
  try {
    pnpmVersion = commandVersion("pnpm", ["--version"]);
  } catch {
    throw new Error("缺少本地安装工具：pnpm；请先启用Corepack");
  }
  if (pnpmVersion !== LOCAL_SETUP_PNPM_VERSION) {
    throw new Error(
      `pnpm版本不匹配：${pnpmVersion || "unknown"}；请通过Corepack使用${LOCAL_SETUP_PNPM_VERSION}`,
    );
  }
  for (const [command, args] of [
    ["git", ["--version"]],
    ["tar", ["--version"]],
    ["npm", ["--version"]],
  ]) {
    try {
      commandVersion(command, args);
    } catch {
      throw new Error(`缺少本地安装工具：${command}`);
    }
  }
  return Object.freeze({
    platform,
    arch,
    libc,
    nodeVersion,
    nodeModuleAbi,
    pnpmVersion,
  });
}

export function parseDevArgs(argv) {
  const options = {
    debug: false,
    help: false,
    instance: "production",
    memory: "off",
    workbench: "code-server",
  };
  let workbenchExplicit = false;
  for (const argument of argv) {
    if (argument === "--debug") {
      options.debug = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument.startsWith("--instance=")) {
      const value = argument.slice("--instance=".length);
      if (!["production", "debug"].includes(value)) {
        throw new Error("--instance只支持 production、debug");
      }
      options.instance = value;
      continue;
    }
    if (argument.startsWith("--memory=")) {
      const value = argument.slice("--memory=".length);
      if (!MEMORY_PROFILES.includes(value)) {
        throw new Error("Memory当前冻结关闭；统一启动器只接受--memory=off");
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
      workbenchExplicit = true;
      continue;
    }
    throw new Error(`未知参数：${argument}`);
  }
  if (options.debug && options.instance !== "debug") {
    throw new Error("--debug必须配合--instance=debug，避免附加或停止production实例");
  }
  if (options.instance === "debug") {
    if (workbenchExplicit && options.workbench !== "off") {
      throw new Error("debug实例当前只支持--workbench=off；Workbench Beta仍属于production本地纵向");
    }
    options.workbench = "off";
  }
  return options;
}

export function devUsage() {
  return [
    "用法: pnpm dev [-- --workbench=off|code-server]",
    "      pnpm dev:debug",
    "",
    "pnpm dev使用production实例；pnpm dev:debug使用隔离端口与独立数据的debug实例。",
    "默认不启动或装配Memory；debug实例固定关闭Beta Code Workbench。",
    "Memory代码与独立测试保留；当前统一启动器不提供启用入口。",
  ].join("\n");
}

export function setupUsage() {
  return [
    "用法: pnpm run setup [--workbench=off|code-server] [--instance=production|debug]",
    "",
    "默认只准备Workflow Bundle、DSH Profile与code-server工件，不准备或启动Memory。",
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

/**
 * VS Code的Node调试器通过这两个变量认领launcher子进程。DSH Host仍使用严格环境白名单：
 * 这里只在debug进程创建瞬间传入调试握手，start-web完成附加后会再次安装受管环境并删除它们，
 * 因而Bridge和其他DSH插件看不到调试控制面，也不会因此重新继承Provider或云端凭据。
 */
function vsCodeAutoAttachEnvironment(environment) {
  const inspectorOptions = environment.VSCODE_INSPECTOR_OPTIONS;
  const nodeOptions = environment.NODE_OPTIONS;
  if (
    typeof inspectorOptions !== "string" ||
    inspectorOptions === "" ||
    typeof nodeOptions !== "string" ||
    nodeOptions === ""
  ) {
    return {};
  }
  return {
    VSCODE_INSPECTOR_OPTIONS: inspectorOptions,
    NODE_OPTIONS: nodeOptions,
  };
}

function commonEnvironment(root, environment) {
  return {
    ...environment,
    CHAT_REPO_ROOT: root,
  };
}

function assertRuntimeProfile(instance, workbench, debug = false) {
  if (debug && instance !== "debug") {
    throw new Error("Inspector调试只能运行在隔离debug实例");
  }
  if (instance === "debug" && workbench !== "off") {
    throw new Error("debug实例当前固定关闭Beta Code Workbench");
  }
}

export function createServiceDefinitions({
  root,
  debug = false,
  instance = "production",
  memory = "off",
  workbench = "code-server",
  environment = process.env,
}) {
  if (!MEMORY_PROFILES.includes(memory)) throw new Error(`未知Memory Profile：${memory}`);
  if (!WORKBENCH_PROFILES.includes(workbench)) {
    throw new Error(`未知Workbench Profile：${workbench}`);
  }
  assertRuntimeProfile(instance, workbench, debug);
  const repoRoot = resolve(root);
  const runtime = resolveRuntimeInstance(repoRoot, instance, environment);
  const managedEnvironment = { ...environment, ...runtime.environment };
  const ports = runtime.ports;
  const workbenchRuntime = resolveLocalWorkbenchRuntimeContract(repoRoot, managedEnvironment);
  const providerEnvironment = join(repoRoot, "scripts/debug/load-provider-env.mjs");
  const services = [];

  const executorArgs = [];
  if (debug) executorArgs.push(`--inspect=127.0.0.1:${ports.piExecutorInspector}`);
  executorArgs.push("--import", providerEnvironment);
  executorArgs.push(
    "--import",
    join(repoRoot, "apps/pi-executor/node_modules/tsx/dist/loader.mjs"),
    join(repoRoot, "apps/pi-executor/src/index.ts"),
  );
  services.push({
    id: "piExecutor",
    role: "piExecutor",
    port: ports.piExecutor,
    command: process.execPath,
    args: executorArgs,
    cwd: repoRoot,
    env: {
      ...commonEnvironment(repoRoot, managedEnvironment),
      CHAT_PI_EXECUTOR_PORT: String(ports.piExecutor),
    },
    readyUrl: `http://127.0.0.1:${ports.piExecutor}/healthz`,
    timeoutMs: 30_000,
    stopTimeoutMs: 10_000,
  });

  const workflowArgs = [];
  if (debug) workflowArgs.push(`--inspect=127.0.0.1:${ports.workflowInspector}`);
  workflowArgs.push("--import", providerEnvironment);
  workflowArgs.push(
    "--import",
    join(repoRoot, "packages/workflows/node_modules/tsx/dist/loader.mjs"),
    join(repoRoot, "packages/workflows/src/runtime-main.ts"),
  );
  services.push({
    id: "workflow",
    role: "workflow",
    port: ports.workflow,
    command: process.execPath,
    args: workflowArgs,
    cwd: repoRoot,
    env: {
      ...commonEnvironment(repoRoot, managedEnvironment),
      CHAT_MEMORY_ENABLED: "0",
      CHAT_WORKFLOW_PORT: String(ports.workflow),
      CHAT_PI_EXECUTOR_INTERNAL_BASE_URL: `http://127.0.0.1:${ports.piExecutor}`,
    },
    readyUrl: `http://127.0.0.1:${ports.workflow}/healthz`,
    timeoutMs: 30_000,
    stopTimeoutMs: 3_000,
  });

  const apiArgs = [];
  if (debug) apiArgs.push(`--inspect=127.0.0.1:${ports.apiInspector}`);
  apiArgs.push("--import", join(repoRoot, "scripts/load-env.mjs"));
  apiArgs.push(
    "--import",
    join(repoRoot, "apps/api/node_modules/tsx/dist/loader.mjs"),
    join(repoRoot, "apps/api/src/index.ts"),
  );
  services.push({
    id: "api",
    role: "api",
    port: ports.api,
    command: process.execPath,
    args: apiArgs,
    cwd: join(repoRoot, "apps/api"),
    env: {
      ...commonEnvironment(repoRoot, managedEnvironment),
      CHAT_MEMORY_ENABLED: "0",
      PORT: String(ports.api),
    },
    readyUrl: `http://127.0.0.1:${ports.api}/api/readyz`,
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
      const value = managedEnvironment[name];
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

  const webArgs = [];
  if (debug) webArgs.push(`--inspect=127.0.0.1:${ports.webInspector}`);
  webArgs.push(
    "--import",
    join(repoRoot, "scripts/load-env.mjs"),
    join(repoRoot, "scripts/dsh/start-web.mjs"),
  );
  services.push({
    id: "web",
    role: "web",
    port: ports.web,
    command: process.execPath,
    // load-env 让服务器部署模式的公开主机名/认证文件路径与 API 共用同一
    // .env 配置源；它不覆盖已有环境变量，也不打印任何值。
    args: webArgs,
    cwd: repoRoot,
    env: {
      ...dshWebEnvironment(repoRoot, {
        ...managedEnvironment,
        CHAT_CODE_WORKBENCH_ENABLED: workbench === "code-server" ? "1" : "0",
        ...workbenchRuntime,
      }),
      ...(debug ? vsCodeAutoAttachEnvironment(managedEnvironment) : {}),
    },
    // /healthz 由网关本地回答：认证模式下 / 会 302 到登录页，不能作就绪证据。
    readyUrl: `http://127.0.0.1:${ports.web}/healthz`,
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
  { instance = "production", workbench = "code-server", environment = process.env } = {},
  { retiredPortGuard = assertRetiredPortsEmpty } = {},
) {
  if (!WORKBENCH_PROFILES.includes(workbench)) {
    throw new Error(`未知Workbench Profile：${workbench}`);
  }
  assertRuntimeProfile(instance, workbench);
  const runtime = resolveRuntimeInstance(root, instance, environment);
  // 退役43113永远只检查不回收，且必须发生在PID登记/legacy evidence清理之前。
  await retiredPortGuard();
  const activePorts = runtime.portList;
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
  const browserCleanup = await cleanupOwnedDebugBrowser(root, {
    profileRoot: runtime.browserProfile,
  });
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

/**
 * 安装准备只能读取活动状态并失败关闭，不能终止进程、清理浏览器或修改Product Run。
 * 端口使用Node独占bind作为权威证据；PID/进程名只属于dev preflight的诊断与回收。
 */
export async function assertLocalSetupIdle(
  root,
  {
    instance = "production",
    environment = process.env,
    probePort = probeRetiredPort,
    readWorkbenchEvidence = readCodeServerProcessEvidence,
  } = {},
) {
  const runtime = resolveRuntimeInstance(root, instance, environment);
  const managedEnvironment = { ...environment, ...runtime.environment };
  const stopCommand = runtime.name === "debug" ? "pnpm dev:debug:stop" : "pnpm dev:stop";
  const results = await Promise.all(runtime.portList.map((port) => probePort(port)));
  const unavailable = results.filter((result) => result.state !== "free");
  if (unavailable.length > 0) {
    const details = unavailable
      .map(
        (result) =>
          `${result.port} ${result.state}${result.errorCode ? `(${result.errorCode})` : ""}`,
      )
      .join("、");
    throw new Error(
      `本地服务仍在运行或端口状态未知：${details}；setup不会自动停止，请先运行 ${stopCommand}`,
    );
  }
  const workbenchEnvironment = resolveLocalWorkbenchRuntimeContract(root, managedEnvironment);
  const evidence = readWorkbenchEvidence(root, workbenchEnvironment);
  if (
    evidence !== undefined &&
    ["starting", "running", "legacy-running"].includes(evidence.status)
  ) {
    throw new Error(
      `Workbench仍处于${evidence.status}；setup不会回收进程，请先运行 ${stopCommand}`,
    );
  }
  console.log(`[setup] ${runtime.name}实例固定端口空闲：${runtime.portList.join(", ")}`);
}

async function preparePinnedRuntimeArtifacts({
  root,
  instance = "production",
  memory,
  workbench = "code-server",
  signal,
  environment = process.env,
}) {
  if (!MEMORY_PROFILES.includes(memory)) throw new Error(`未知Memory Profile：${memory}`);
  if (!WORKBENCH_PROFILES.includes(workbench)) {
    throw new Error(`未知Workbench Profile：${workbench}`);
  }
  assertRuntimeProfile(instance, workbench);
  const runtime = resolveRuntimeInstance(root, instance, environment);
  const managedEnvironment = { ...environment, ...runtime.environment };
  const workbenchRuntime = resolveLocalWorkbenchRuntimeContract(root, managedEnvironment);
  console.log(`[chat] 固定源码缓存：${workbenchRuntime.CHAT_FIXED_SOURCE_CACHE_ROOT}`);
  if (workbench === "code-server") {
    console.log("[chat] 准备固定code-server Workbench…");
    await ensureFixedCodeServer(root, { environment: workbenchRuntime });
  }
  if (signal?.aborted) throw signal.reason ?? new Error("启动已取消");
  console.log("[chat] 构建Workflow Bundles…");
  await runPreparationCommand({ root, signal, environment: managedEnvironment });
}

/** 只准备可重建工件，不清理运行进程，也不读取或收敛活动Product Run。 */
export async function prepareLocalArtifacts({
  root,
  instance = "production",
  memory,
  workbench = "code-server",
  signal,
  environment = process.env,
}) {
  const runtime = resolveRuntimeInstance(root, instance, environment);
  const managedEnvironment = { ...environment, ...runtime.environment };
  await preparePinnedRuntimeArtifacts({
    root,
    instance,
    memory,
    workbench,
    signal,
    environment: managedEnvironment,
  });
  if (signal?.aborted) throw signal.reason ?? new Error("准备已取消");
  console.log("[chat] 准备DSH Web Profile与LifeOS Bridge…");
  await runDshPreparationCommand({ root, signal, environment: managedEnvironment });
}

export async function prepareLocalRuntime({
  root,
  instance = "production",
  memory,
  workbench = "code-server",
  signal,
  environment = process.env,
}) {
  const runtime = resolveRuntimeInstance(root, instance, environment);
  const managedEnvironment = { ...environment, ...runtime.environment };
  await preflightLocalRuntime(root, { instance, workbench, environment: managedEnvironment });
  if (signal?.aborted) throw signal.reason ?? new Error("启动已取消");
  await preparePinnedRuntimeArtifacts({
    root,
    instance,
    memory,
    workbench,
    signal,
    environment: managedEnvironment,
  });
  if (signal?.aborted) throw signal.reason ?? new Error("启动已取消");
  console.log("[chat] 检查活动Workflow版本兼容性…");
  await runVersionRecoveryCommand({ root, signal, environment: managedEnvironment });
  if (signal?.aborted) throw signal.reason ?? new Error("启动已取消");
  console.log("[chat] 准备DSH Web Profile与LifeOS Bridge…");
  await runDshPreparationCommand({ root, signal, environment: managedEnvironment });
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
    "apps/pi-executor/node_modules/tsx/dist/loader.mjs",
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
