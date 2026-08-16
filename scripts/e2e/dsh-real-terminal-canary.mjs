import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  describeProcess,
  gitCommonDirForPath,
  identityMatches,
  isEffectivelyAlive,
  parentPid,
  processWorkingDirectory,
} from "../debug/lib.mjs";
import { readCodeServerProcessEvidence } from "../workbench/fixed-code-server.mjs";
import {
  dshRealWorkbenchEnvironment,
  resolveDshRealWorkbenchFixtureRoot,
  resolveDshRealWorkbenchRunRoot,
} from "./dsh-real-environment.mjs";

export const DSH_REAL_TERMINAL_CANARY_SCHEMA = "chat-dsh-terminal-canary.v1";
const CANARY_PATTERN = /^chat-dsh-workbench-terminal-[a-z0-9-]{12,160}$/u;

export function resolveDshRealTerminalCanaryEvidencePath(root) {
  return join(resolveDshRealWorkbenchRunRoot(root), "terminal-process.json");
}

function atomicWriteEvidence(path, evidence) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${String(process.pid)}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function processRows() {
  const output = execFileSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return output
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(.+)$/u))
    .filter((match) => match !== null)
    .map((match) => ({ pid: Number.parseInt(match[1], 10), command: match[2] }));
}

function descendantOf(pid, ancestorPid, parent = parentPid) {
  const seen = new Set();
  let cursor = pid;
  while (Number.isInteger(cursor) && cursor > 0 && !seen.has(cursor)) {
    if (cursor === ancestorPid) return true;
    seen.add(cursor);
    cursor = parent(cursor);
  }
  return false;
}

/**
 * 只复核、不发信号。唯一argv canary、完整命令、精确OS启动秒、cwd/Git与
 * code-server后代链缺一不可；因此PID复用或证据被替换时只能失败关闭。
 */
export function assertDshRealTerminalCanaryProcessIdentity(
  evidence,
  {
    isAlive = isEffectivelyAlive,
    describe = describeProcess,
    workingDirectory = processWorkingDirectory,
    findGitCommonDir = gitCommonDirForPath,
    findParentPid = parentPid,
  } = {},
) {
  if (!isAlive(evidence.pid)) throw new Error("Terminal canary已提前退出");
  const description = describe(evidence.pid);
  const recordedStartedAtMs = Date.parse(evidence.startedAt);
  if (
    !identityMatches(
      {
        startedAt: evidence.startedAt,
        commandFragments: evidence.commandFragments,
      },
      description,
    ) ||
    description?.command !== evidence.command ||
    description.startedAtMs !== recordedStartedAtMs
  ) {
    throw new Error("Terminal canary PID/命令/启动时间身份不匹配");
  }
  const cwd = workingDirectory(evidence.pid);
  if (cwd !== evidence.cwd || findGitCommonDir(cwd) !== findGitCommonDir(evidence.workspaceRoot)) {
    throw new Error("Terminal canary cwd/Git身份不匹配");
  }
  if (!descendantOf(evidence.pid, evidence.codeServerChildPid, findParentPid)) {
    throw new Error("Terminal canary不是已记录code-server child后代");
  }
  return evidence;
}

function parseEvidence(value, expectedWorkspaceRoot, evidencePath) {
  const expectedRoot = realpathSync(resolve(expectedWorkspaceRoot));
  if (
    value?.schemaVersion !== DSH_REAL_TERMINAL_CANARY_SCHEMA ||
    !Number.isInteger(value?.pid) ||
    value.pid <= 0 ||
    typeof value?.startedAt !== "string" ||
    Number.isNaN(Date.parse(value.startedAt)) ||
    typeof value?.command !== "string" ||
    typeof value?.canary !== "string" ||
    !CANARY_PATTERN.test(value.canary) ||
    !Array.isArray(value?.commandFragments) ||
    value.commandFragments.length !== 1 ||
    value.commandFragments[0] !== value.canary ||
    !value.command.includes(value.canary) ||
    value.cwd !== expectedRoot ||
    value.workspaceRoot !== expectedRoot ||
    !Number.isInteger(value?.codeServerChildPid) ||
    typeof value?.codeServerInstanceId !== "string" ||
    typeof value?.recordedAt !== "string"
  ) {
    throw new Error("Terminal canary evidence不符合固定身份合同");
  }
  return Object.freeze({ ...value, evidencePath });
}

export function readDshRealTerminalCanaryEvidence(root) {
  const repoRoot = resolve(root);
  const evidencePath = resolveDshRealTerminalCanaryEvidencePath(repoRoot);
  let raw;
  try {
    const stat = lstatSync(evidencePath);
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      (expectedUid !== undefined && stat.uid !== expectedUid)
    ) {
      throw new Error("Terminal canary evidence必须是当前用户拥有的0600普通文件");
    }
    raw = JSON.parse(readFileSync(evidencePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw new Error("Terminal canary evidence JSON损坏");
    throw error;
  }
  return parseEvidence(raw, resolveDshRealWorkbenchFixtureRoot(repoRoot), evidencePath);
}

/**
 * 复核活着的Terminal进程；PID、完整命令、OS启动时间、cwd、Git仓库与code-server
 * 后代关系必须同时成立。任一不符都失败关闭，调用者不得向该PID发送信号。
 */
export function assertDshRealTerminalCanaryAlive(
  root,
  { environment = process.env, requireRunningWorkbench = false } = {},
) {
  const repoRoot = resolve(root);
  const evidence = readDshRealTerminalCanaryEvidence(repoRoot);
  if (evidence === undefined) throw new Error("缺少Terminal canary evidence");
  assertDshRealTerminalCanaryProcessIdentity(evidence);
  if (requireRunningWorkbench) {
    const workbenchEnvironment = dshRealWorkbenchEnvironment(repoRoot, environment);
    const current = readCodeServerProcessEvidence(evidence.workspaceRoot, workbenchEnvironment);
    if (
      current?.status !== "running" ||
      current.childPid !== evidence.codeServerChildPid ||
      current.instanceId !== evidence.codeServerInstanceId
    ) {
      throw new Error("Terminal canary不属于当前running code-server instance");
    }
  }
  return evidence;
}

export function assertDshRealTerminalCanaryStopped(root) {
  const evidence = readDshRealTerminalCanaryEvidence(root);
  if (evidence !== undefined && isEffectivelyAlive(evidence.pid)) {
    // PID仍存在时先复核。若已经复用也不能把“不认识的新进程”伪装成清理成功。
    assertDshRealTerminalCanaryProcessIdentity(evidence);
    throw new Error("Workbench回收后Terminal canary仍存活");
  }
  return evidence;
}

export async function waitForAndRecordDshRealTerminalCanary(
  root,
  canary,
  { environment = process.env, timeoutMs = 10_000 } = {},
) {
  if (!CANARY_PATTERN.test(canary)) throw new Error("Terminal canary token格式非法");
  const repoRoot = resolve(root);
  const workspaceRoot = realpathSync(resolveDshRealWorkbenchFixtureRoot(repoRoot));
  const workbenchEnvironment = dshRealWorkbenchEnvironment(repoRoot, environment);
  const workbench = readCodeServerProcessEvidence(workspaceRoot, workbenchEnvironment);
  if (
    workbench?.status !== "running" ||
    !Number.isInteger(workbench.childPid) ||
    typeof workbench.instanceId !== "string"
  ) {
    throw new Error("记录Terminal canary前缺少当前running code-server instance");
  }

  const deadline = Date.now() + timeoutMs;
  let matches = [];
  while (Date.now() < deadline) {
    matches = processRows().filter((row) => row.command.includes(canary));
    if (matches.length === 1) break;
    if (matches.length > 1) {
      throw new Error(`Terminal canary进程必须唯一，实际${String(matches.length)}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (matches.length !== 1) throw new Error("未观察到Terminal长寿命canary进程");
  const match = matches[0];
  const description = describeProcess(match.pid);
  const cwd = processWorkingDirectory(match.pid);
  if (
    description === null ||
    cwd !== workspaceRoot ||
    !descendantOf(match.pid, workbench.childPid)
  ) {
    throw new Error("Terminal canary初始进程身份不属于本轮Workspace/code-server");
  }
  const evidence = {
    schemaVersion: DSH_REAL_TERMINAL_CANARY_SCHEMA,
    pid: match.pid,
    startedAt: new Date(description.startedAtMs).toISOString(),
    command: description.command,
    commandFragments: [canary],
    canary,
    cwd,
    workspaceRoot,
    codeServerChildPid: workbench.childPid,
    codeServerInstanceId: workbench.instanceId,
    recordedAt: new Date().toISOString(),
  };
  const evidencePath = resolveDshRealTerminalCanaryEvidencePath(repoRoot);
  atomicWriteEvidence(evidencePath, evidence);
  return assertDshRealTerminalCanaryAlive(repoRoot, {
    environment,
    requireRunningWorkbench: true,
  });
}
