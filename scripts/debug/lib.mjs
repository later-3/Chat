import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readlinkSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";

/**
 * Chat本地调试进程管理共享库（任务书§8）。
 *
 * 安全规则：
 * - PID登记由同一Git仓库的所有worktree共享，因为固定端口本来就是仓库级排他资源；
 * - 优先终止登记过且通过身份复核（命令片段+启动时间）的进程；
 * - 登记丢失时，只回收“固定端口角色+命令签名+进程cwd+Git Common Directory”四重匹配的Chat进程；
 * - 端口被其他应用占用时安全失败并报告端口/PID/进程名，绝不杀未知进程；
 * - 禁止使用pkill、killall或按模糊名称终止进程。
 */

export const FROZEN_PORTS = Object.freeze({
  web: 43110,
  webInternal: 43114,
  api: 43111,
  workflow: 43112,
  workbenchLease: 43119,
  memory: 18960,
  memoryCore: 18970,
  apiInspector: 43120,
  workflowInspector: 43121,
});

// 43113曾经暴露无认证code-server。它不再是可回收服务端口：任何监听者（即使看似
// 属于旧Chat wrapper）都必须在启动清理发生前失败关闭，由维护者显式处置。
export const RETIRED_MUST_BE_EMPTY_PORTS = Object.freeze([43113]);

/** 各调试角色的命令行身份片段（用于PID复用复核）。 */
export const ROLE_COMMAND_FRAGMENTS = Object.freeze({
  api: ["src/index.ts", "tsx"],
  workflow: ["runtime-main.ts", "tsx"],
  memory: ["start-fixed-memmy.mjs"],
  memoryCore: ["start-fixed-memorycore.mjs"],
  workbench: ["start-fixed-code-server.mjs"],
  web: ["scripts/dsh/start-web.mjs"],
});

/** 记录启动时间与ps lstart的允许偏差（防御PID复用）。 */
const START_TIME_TOLERANCE_MS = 120_000;
const MEMORY_WRAPPER_TERM_WAIT_MS = 7_000;
const WORKBENCH_WRAPPER_TERM_WAIT_MS = 7_000;

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

export function repoRoot() {
  if (process.env.CHAT_REPO_ROOT) return resolve(process.env.CHAT_REPO_ROOT);
  return resolve(SCRIPTS_DIR, "../..");
}

export function sharedDebugDirFromGitCommonDir(root, gitCommonDir) {
  const commonDirectory = resolve(root, gitCommonDir);
  if (!commonDirectory.endsWith("/.git")) {
    throw new Error(`无法从Git Common Directory确定共享调试目录：${commonDirectory}`);
  }
  return join(resolve(commonDirectory, ".."), ".data", "debug");
}

/** 返回指定目录所属仓库的Git Common Directory；非Git目录返回null。 */
export function gitCommonDirForPath(path) {
  try {
    const commonDirectory = execFileSync("git", ["-C", path, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return normalizeExistingPath(resolve(path, commonDirectory));
  } catch {
    return null;
  }
}

export function debugDir() {
  if (process.env.CHAT_DEBUG_DIR) return resolve(process.env.CHAT_DEBUG_DIR);
  const root = repoRoot();
  const commonDirectory = gitCommonDirForPath(root);
  if (commonDirectory) {
    try {
      return sharedDebugDirFromGitCommonDir(root, commonDirectory);
    } catch {
      // 非标准Git布局回退到当前worktree；端口身份检查仍会失败关闭。
    }
  }
  return join(repoRoot(), ".data", "debug");
}

export function pidsPath() {
  return join(debugDir(), "pids.json");
}

export function frozenPortList() {
  if (process.env.CHAT_DEBUG_PORTS) {
    return process.env.CHAT_DEBUG_PORTS.split(",")
      .map((part) => Number.parseInt(part.trim(), 10))
      .filter((port) => Number.isInteger(port));
  }
  return Object.values(FROZEN_PORTS);
}

/**
 * 读取pids.json。文件不存在返回[]；损坏时不删除原文件，
 * 改名为pids.corrupt-<ts>.json并返回[]（端口检查仍会失败关闭）。
 */
export function loadPidEntries() {
  const path = pidsPath();
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  try {
    const parsed = JSON.parse(raw);
    const processes = Array.isArray(parsed?.processes) ? parsed.processes : [];
    const valid = processes.filter(
      (entry) =>
        entry &&
        typeof entry.role === "string" &&
        Number.isInteger(entry.pid) &&
        typeof entry.startedAt === "string" &&
        Array.isArray(entry.commandFragments),
    );
    // PID登记只是可重建的本地运行投影，不是产品事实。终端可能把SIGINT同时发送给
    // pnpm、监督器和全部子进程，使监督器来不及执行异步finally；读取时安全剔除
    // 已确认退出/僵尸的记录。仍存活（包括PID复用）的条目保留，后续继续做身份复核。
    const active = valid.filter((entry) => isEffectivelyAlive(entry.pid));
    if (active.length !== valid.length || valid.length !== processes.length) {
      savePidEntries(active);
    }
    return active;
  } catch {
    const backup = `${path}.corrupt-${Date.now()}`;
    renameSync(path, backup);
    console.error(`[debug] pids.json损坏，已保留为 ${backup}，按空记录继续（端口检查仍失败关闭）`);
    return [];
  }
}

export function savePidEntries(entries) {
  mkdirSync(debugDir(), { recursive: true });
  const tmp = `${pidsPath()}.tmp`;
  writeFileSync(
    tmp,
    `${JSON.stringify({ schemaVersion: 1, workspaceRoot: repoRoot(), processes: entries }, null, 2)}\n`,
    "utf8",
  );
  renameSync(tmp, pidsPath());
}

export function removePidsFile() {
  try {
    renameSync(pidsPath(), `${pidsPath()}.done-${Date.now()}`);
  } catch {
    // 文件不存在时无需处理
  }
}

/** 登记/替换一个角色的进程记录（由应用监督器和保留的低层调试入口调用）。 */
export function recordPidEntry(entry) {
  const entries = loadPidEntries().filter(
    (existing) => !(existing.role === entry.role && existing.pid === entry.pid),
  );
  entries.push({ ...entry, workspaceRoot: repoRoot() });
  savePidEntries(entries);
}

export function removePidEntry(role, pid) {
  const entries = loadPidEntries().filter((entry) => !(entry.role === role && entry.pid === pid));
  savePidEntries(entries);
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isZombie(pid) {
  try {
    const stat = execFileSync("ps", ["-p", String(pid), "-o", "stat="], {
      encoding: "utf8",
    }).trim();
    return stat.startsWith("Z");
  } catch {
    return false;
  }
}

/** 进程是否实质存活（排除已退出未回收的僵尸）。 */
export function isEffectivelyAlive(pid) {
  return isAlive(pid) && !isZombie(pid);
}

/** 返回 { startedAtMs, command }；仅供内部身份复核，不得输出到报告或Trace。 */
export function describeProcess(pid) {
  try {
    const lstart = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
    }).trim();
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    }).trim();
    return { startedAtMs: Date.parse(lstart), command };
  } catch {
    return null;
  }
}

/** 查询进程cwd；Linux优先/proc，macOS等平台回退到lsof。 */
export function processWorkingDirectory(pid) {
  try {
    return normalizeExistingPath(readlinkSync(`/proc/${String(pid)}/cwd`));
  } catch {
    // macOS没有/proc，继续使用lsof。
  }
  const output = tryExec(
    ["lsof", "/usr/sbin/lsof", "/sbin/lsof"],
    ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
  );
  if (!output) return null;
  const match = output.match(/^n(.+)$/m);
  return match?.[1] ? normalizeExistingPath(match[1]) : null;
}

/** 查询父PID；进程已退出或系统不支持ps时返回null。 */
export function parentPid(pid) {
  try {
    const value = execFileSync("ps", ["-p", String(pid), "-o", "ppid="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 面向用户报告的安全进程名：仅argv[0]的可执行文件basename。
 * 后续argv可能包含其他应用的Token、密码或私有路径，绝不输出。
 */
export function safeProcessName(pid) {
  try {
    const args = execFileSync("ps", ["-p", String(pid), "-o", "args="], {
      encoding: "utf8",
    }).trim();
    const argv0 = args.split(/\s+/)[0] ?? "";
    const basename = (argv0.split("/").pop() ?? argv0).slice(0, 64);
    return basename || "unknown";
  } catch {
    return "unknown";
  }
}

function tryExec(candidates, args) {
  for (const command of candidates) {
    try {
      return execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (error) {
      // 退出码非0（如无匹配）属于正常结果，继续回退仅针对命令不存在
      if (error && error.code === "ENOENT") continue;
      if (error && typeof error.status === "number" && error.status !== 0) return null;
    }
  }
  return undefined;
}

function normalizeExistingPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** 通过lsof查找监听端口的PID；无监听者返回null。lsof不可用时尝试ss。 */
export function findListenerPid(port) {
  // 调试环境PATH可能不含/usr/sbin，使用绝对路径候选
  const lsofOut = tryExec(
    ["lsof", "/usr/sbin/lsof", "/sbin/lsof"],
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"],
  );
  if (lsofOut !== undefined) {
    const match = lsofOut === null ? null : lsofOut.match(/^p(\d+)$/m);
    return match ? Number.parseInt(match[1], 10) : null;
  }
  const ssOut = tryExec(["ss", "/usr/sbin/ss", "/bin/ss"], ["-ltnpH", `sport = :${port}`]);
  if (ssOut !== undefined) {
    const match = ssOut === null ? null : ssOut.match(/pid=(\d+)/);
    return match ? Number.parseInt(match[1], 10) : null;
  }
  return null;
}

/** 身份复核：命令片段全部命中且启动时间在容差内。 */
export function identityMatches(entry, description) {
  if (!description) return false;
  const fragments = entry.commandFragments ?? [];
  if (!fragments.every((fragment) => description.command.includes(fragment))) return false;
  const recorded = Date.parse(entry.startedAt);
  if (Number.isNaN(recorded) || Number.isNaN(description.startedAtMs)) return false;
  return Math.abs(description.startedAtMs - recorded) <= START_TIME_TOLERANCE_MS;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function signal(entry, sig) {
  try {
    if (entry.killScope === "group") {
      process.kill(-entry.pid, sig);
    } else {
      process.kill(entry.pid, sig);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Memory/code-server包装进程收到SIGTERM后最多用5秒向真实服务子进程转发并等待退出。
 * 调试清理必须比该上限更长，避免先杀包装器而遗留未登记的子进程。
 */
export function termWaitMsForEntry(entry, requestedTermWaitMs = 3000) {
  if (entry.role === "memory" || entry.role === "memoryCore") {
    return Math.max(requestedTermWaitMs, MEMORY_WRAPPER_TERM_WAIT_MS);
  }
  if (entry.role === "workbench") {
    return Math.max(requestedTermWaitMs, WORKBENCH_WRAPPER_TERM_WAIT_MS);
  }
  return requestedTermWaitMs;
}

/**
 * 终止一条记录：SIGTERM后有限等待，仍存活且身份一致才SIGKILL。
 * 任何身份不匹配都跳过并报告，绝不强行终止。
 */
export function terminateEntry(entry, { termWaitMs = 3000 } = {}) {
  const { pid, role } = entry;
  if (!isEffectivelyAlive(pid)) return { role, pid, action: "already-exited" };
  if (!identityMatches(entry, describeProcess(pid))) {
    return { role, pid, action: "skipped-identity-mismatch" };
  }
  signal(entry, "SIGTERM");
  const deadline = Date.now() + termWaitMsForEntry(entry, termWaitMs);
  while (Date.now() < deadline) {
    if (!isEffectivelyAlive(pid)) return { role, pid, action: "terminated" };
    sleepSync(100);
  }
  if (!identityMatches(entry, describeProcess(pid))) {
    return { role, pid, action: "skipped-identity-mismatch-before-kill" };
  }
  signal(entry, "SIGKILL");
  const killDeadline = Date.now() + 1500;
  while (Date.now() < killDeadline) {
    if (!isEffectivelyAlive(pid)) return { role, pid, action: "killed" };
    sleepSync(100);
  }
  return { role, pid, action: "kill-failed" };
}

/**
 * 终止一批记录并收缩pids.json：
 * 已解决的记录移除；身份不匹配而跳过的记录保留，供下次preclean复查，
 * 避免把仍存活的记录进程降级为“未知占用者”。
 */
export function terminateRecorded(entries, options) {
  const results = entries.map((entry) => terminateEntry(entry, options));
  const remaining = entries.filter((entry, index) => results[index]?.action.startsWith("skipped"));
  if (remaining.length > 0) {
    savePidEntries(remaining);
  } else if (entries.length > 0) {
    removePidsFile();
  }
  return results;
}

/** 检查端口占用，返回 [{ port, pid, processName }]（只含安全进程名，不含argv）。 */
export function checkPorts(ports = frozenPortList()) {
  const occupied = [];
  for (const port of ports) {
    const pid = findListenerPid(port);
    if (pid === null) continue;
    occupied.push({ port, pid, processName: safeProcessName(pid) });
  }
  return occupied;
}

function destroyProbeSockets(sockets) {
  for (const socket of sockets) socket.destroy();
}

async function closeProbeServer(
  server,
  sockets,
  { closeTimeoutMs, scheduleTimeout, cancelTimeout },
) {
  // close只停止新accept，已accept连接仍会阻塞callback；必须先主动销毁。
  destroyProbeSockets(sockets);
  await new Promise((resolveClose, rejectClose) => {
    let settled = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cancelTimeout(timer);
      if (error === undefined) resolveClose();
      else rejectClose(error);
    };
    timer = scheduleTimeout(() => {
      finish(
        Object.assign(new Error("retired port probe close timeout"), { code: "CLOSE_TIMEOUT" }),
      );
    }, closeTimeoutMs);
    try {
      server.close((error) => finish(error));
    } catch (error) {
      finish(error);
    }
  });
}

/** 只有Node成功独占bind并成功close才证明端口为空；进程查询工具不参与安全判断。 */
export async function probeRetiredPort(
  port,
  {
    createServer = createNetServer,
    closeTimeoutMs = 1_000,
    scheduleTimeout = setTimeout,
    cancelTimeout = clearTimeout,
  } = {},
) {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.destroy();
  });
  const closeOptions = { closeTimeoutMs, scheduleTimeout, cancelTimeout };
  try {
    await new Promise((resolveListen, rejectListen) => {
      const onError = (error) => {
        server.off("listening", onListening);
        rejectListen(error);
      };
      const onListening = () => {
        server.off("error", onError);
        server.unref?.();
        resolveListen();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      try {
        server.listen({ host: "127.0.0.1", port, exclusive: true });
      } catch (error) {
        server.off("error", onError);
        server.off("listening", onListening);
        rejectListen(error);
      }
    });
  } catch (error) {
    if (server.listening) {
      try {
        await closeProbeServer(server, sockets, closeOptions);
      } catch (closeError) {
        return Object.freeze({
          port,
          state: "unknown",
          errorCode: typeof closeError?.code === "string" ? closeError.code : "CLOSE_FAILED",
        });
      } finally {
        destroyProbeSockets(sockets);
      }
    }
    destroyProbeSockets(sockets);
    return Object.freeze({
      port,
      state: error?.code === "EADDRINUSE" ? "occupied" : "unknown",
      errorCode: typeof error?.code === "string" ? error.code : "UNKNOWN",
    });
  }

  try {
    await closeProbeServer(server, sockets, closeOptions);
    return Object.freeze({ port, state: "free" });
  } catch (error) {
    return Object.freeze({
      port,
      state: "unknown",
      errorCode: typeof error?.code === "string" ? error.code : "CLOSE_FAILED",
    });
  } finally {
    destroyProbeSockets(sockets);
  }
}

export async function probeRetiredPorts({
  ports = RETIRED_MUST_BE_EMPTY_PORTS,
  probe = probeRetiredPort,
} = {}) {
  const results = [];
  for (const port of ports) results.push(await probe(port));
  return Object.freeze(results);
}

export function formatRetiredPortStatus(result, diagnostic) {
  const identity =
    diagnostic === undefined
      ? ""
      : ` pid=${String(diagnostic.pid)} process=${diagnostic.processName}`;
  const reason = result.errorCode === undefined ? "" : ` error=${result.errorCode}`;
  return `[chat] 退役端口 ${String(result.port)} ${result.state}${identity}${reason}`;
}

export async function assertRetiredPortsEmpty({
  ports = RETIRED_MUST_BE_EMPTY_PORTS,
  probePorts = probeRetiredPorts,
  diagnose = checkPorts,
} = {}) {
  const results = await probePorts({ ports });
  const failures = results.filter((result) => result.state !== "free");
  if (failures.length === 0) return results;
  let diagnostics = [];
  try {
    diagnostics = diagnose(failures.map((result) => result.port));
  } catch {
    // lsof/ss只补诊断；缺失或失败不能把Node权威探针降级成free。
  }
  const details = failures
    .map((result) => {
      const diagnostic = diagnostics.find((item) => item.port === result.port);
      return formatRetiredPortStatus(result, diagnostic).replace(/^\[chat\] /u, "");
    })
    .join("、");
  throw new Error(
    `退役Workbench TCP端口未被权威证明为空，且不会自动终止任何占用者：${details}；请人工确认并释放后重试`,
  );
}

/** 固定端口到Chat服务角色的唯一映射；未知端口永远不参与自动回收。 */
export function roleForFrozenPort(port) {
  if (port === FROZEN_PORTS.web || port === FROZEN_PORTS.webInternal) return "web";
  if (port === FROZEN_PORTS.api || port === FROZEN_PORTS.apiInspector) return "api";
  if (port === FROZEN_PORTS.workflow || port === FROZEN_PORTS.workflowInspector) {
    return "workflow";
  }
  if (port === FROZEN_PORTS.memory) return "memory";
  if (port === FROZEN_PORTS.memoryCore) return "memoryCore";
  if (port === FROZEN_PORTS.workbenchLease) return "workbench";
  return null;
}

/**
 * 从监听进程向父进程回溯，寻找能被证明属于同一Chat仓库、同一固定端口角色的进程。
 *
 * 这是PID登记因IDE强停或旧调试方案而丢失时的恢复门。仅有node进程名、端口号或相似命令
 * 都不够；命令签名与进程cwd所属Git Common Directory必须同时匹配。返回的startedAt来自
 * 当前ps快照，后续terminateEntry还会再次复核，防御查询和发信号之间的PID复用。
 */
export function findOwnedChatProcessForPort(
  root,
  occupant,
  {
    describe = describeProcess,
    workingDirectory = processWorkingDirectory,
    findParentPid = parentPid,
    findGitCommonDir = gitCommonDirForPath,
  } = {},
) {
  const role = roleForFrozenPort(occupant.port);
  if (!role) return null;
  const expectedFragments = ROLE_COMMAND_FRAGMENTS[role];
  const rootCommonDirectory = findGitCommonDir(root);
  if (!rootCommonDirectory) return null;

  const visited = new Set();
  let candidatePid = occupant.pid;
  while (Number.isInteger(candidatePid) && candidatePid > 1 && !visited.has(candidatePid)) {
    visited.add(candidatePid);
    const description = describe(candidatePid);
    const cwd = workingDirectory(candidatePid);
    const processCommonDirectory = cwd ? findGitCommonDir(cwd) : null;
    if (
      description &&
      Number.isFinite(description.startedAtMs) &&
      expectedFragments.every((fragment) => description.command.includes(fragment)) &&
      processCommonDirectory === rootCommonDirectory
    ) {
      return {
        role,
        pid: candidatePid,
        port: occupant.port,
        killScope: "process",
        startedAt: new Date(description.startedAtMs).toISOString(),
        commandFragments: expectedFragments,
        workspaceRoot: cwd,
      };
    }
    candidatePid = findParentPid(candidatePid);
  }
  return null;
}

/** 同一监听PID（例如API与Inspector）只生成一条回收记录。 */
export function findOwnedChatPortProcesses(root, occupied, dependencies) {
  const owned = [];
  const seen = new Set();
  for (const occupant of occupied) {
    const entry = findOwnedChatProcessForPort(root, occupant, dependencies);
    if (!entry || seen.has(entry.pid)) continue;
    seen.add(entry.pid);
    owned.push(entry);
  }
  return owned;
}

/** 识别后逐条复用terminateEntry的二次身份校验与有限等待。 */
export function terminateOwnedChatPortProcesses(
  root,
  occupied,
  { findOwned = findOwnedChatPortProcesses, terminate = terminateEntry } = {},
) {
  return findOwned(root, occupied).map((entry) => terminate(entry));
}
