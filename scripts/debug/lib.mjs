import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Chat本地调试进程管理共享库（任务书§8）。
 *
 * 安全规则：
 * - 只终止记录在.data/debug/pids.json中、且通过身份复核（命令片段+启动时间）的进程；
 * - 端口被未知应用占用时安全失败并报告端口/PID/进程名，绝不杀未知进程；
 * - 禁止使用pkill、killall或按模糊名称终止进程。
 */

export const FROZEN_PORTS = Object.freeze({
  web: 43110,
  api: 43111,
  workflow: 43112,
  apiInspector: 43120,
  workflowInspector: 43121,
});

/** 各调试角色的命令行身份片段（用于PID复用复核）。 */
export const ROLE_COMMAND_FRAGMENTS = Object.freeze({
  api: ["src/index.ts", "tsx"],
  workflow: ["workflow-stub.mjs"],
  web: ["vite", "43110"],
});

/** 记录启动时间与ps lstart的允许偏差（防御PID复用）。 */
const START_TIME_TOLERANCE_MS = 120_000;

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

export function repoRoot() {
  if (process.env.CHAT_REPO_ROOT) return resolve(process.env.CHAT_REPO_ROOT);
  return resolve(SCRIPTS_DIR, "../..");
}

export function debugDir() {
  if (process.env.CHAT_DEBUG_DIR) return resolve(process.env.CHAT_DEBUG_DIR);
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
    return processes.filter(
      (entry) =>
        entry &&
        typeof entry.role === "string" &&
        Number.isInteger(entry.pid) &&
        typeof entry.startedAt === "string" &&
        Array.isArray(entry.commandFragments),
    );
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

/** 登记/替换一个角色的进程记录（由register-process.mjs与start-web.mjs调用）。 */
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

/**
 * 面向用户报告的安全进程名：仅可执行文件basename。
 * 完整argv可能包含其他应用的Token、密码或私有路径，绝不输出。
 */
export function safeProcessName(pid) {
  try {
    const comm = execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
      encoding: "utf8",
    }).trim();
    const basename = comm.split("/").pop() ?? comm;
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
  const deadline = Date.now() + termWaitMs;
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
