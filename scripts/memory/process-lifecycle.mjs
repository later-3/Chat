import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  describeProcess,
  findListenerPid,
  isEffectivelyAlive,
  processWorkingDirectory,
} from "../debug/lib.mjs";
import { FIXED_MEMMY_COMMIT, fixedMemmyCacheRoot, fixedMemmyServerEntry } from "./fixed-memmy.mjs";
import { FIXED_MEMORYCORE_COMMIT, fixedMemoryCoreRoot } from "./fixed-memorycore.mjs";

export const MEMORY_PROCESS_EVIDENCE_SCHEMA = "chat-fixed-memory-process.v2";
export const MANAGED_MEMORY_MODES = Object.freeze(["off", "memorycore", "memmy", "compare"]);

const PROVIDERS_BY_MODE = Object.freeze({
  off: Object.freeze([]),
  memmy: Object.freeze(["memmy"]),
  memorycore: Object.freeze(["memorycore"]),
  compare: Object.freeze(["memmy", "memorycore"]),
});
const LEGACY_SCHEMAS = Object.freeze({
  memmy: "chat-fixed-memmy-process.v1",
  memorycore: "chat-fixed-memorycore-process.v1",
});

/**
 * Memory正文、索引、配置和进程证据都属于私有本机数据。只处理调用方已经限定在
 * Chat `.data`内的runRoot；符号链接失败关闭，避免权限递归越出受管目录。
 */
export function secureMemoryDataTree(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const visit = (path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new Error(`Memory数据树不允许符号链接：${path}`);
    }
    if (stat.isDirectory()) {
      chmodSync(path, 0o700);
      for (const entry of readdirSync(path)) visit(join(path, entry));
      return;
    }
    if (stat.isFile()) {
      chmodSync(path, 0o600);
      return;
    }
    throw new Error(`Memory数据树包含不支持的文件类型：${path}`);
  };
  visit(resolve(root));
}

function assertMemoryMode(memory) {
  if (!MANAGED_MEMORY_MODES.includes(memory)) throw new Error(`未知Memory Profile：${memory}`);
  return memory;
}

function normalizeSecond(instant, label) {
  const milliseconds = Date.parse(instant);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label}不是合法时间`);
  return new Date(Math.trunc(milliseconds / 1_000) * 1_000).toISOString();
}

function samePath(left, right) {
  return resolve(left) === resolve(right);
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${String(process.pid)}-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function providerContract({ root, runtime, provider, environment }) {
  const repoRoot = resolve(root);
  if (provider === "memmy") {
    const runRoot = join(runtime.dataRoot, "memory", "memmy");
    const port = runtime.ports.memory;
    return Object.freeze({
      provider,
      role: "memory",
      runtimeInstance: runtime.name,
      sourceCommit: FIXED_MEMMY_COMMIT,
      port,
      runRoot,
      evidencePath: join(runRoot, "service-process.json"),
      childCwd: fixedMemmyCacheRoot(repoRoot, environment),
      commandFragments: Object.freeze([
        fixedMemmyServerEntry(repoRoot, environment),
        "--port",
        String(port),
        "--db",
        join(runRoot, "memory.sqlite"),
        "--config",
        join(runRoot, "config.json"),
      ]),
    });
  }
  if (provider === "memorycore") {
    const runRoot = join(runtime.dataRoot, "memory", "memorycore");
    const port = runtime.ports.memoryCore;
    return Object.freeze({
      provider,
      role: "memoryCore",
      runtimeInstance: runtime.name,
      sourceCommit: FIXED_MEMORYCORE_COMMIT,
      port,
      runRoot,
      evidencePath: join(runRoot, "service-process.json"),
      childCwd: fixedMemoryCoreRoot(repoRoot, environment),
      commandFragments: Object.freeze(["--import", "tsx", "src/gateway/server.ts"]),
    });
  }
  throw new Error(`未知Memory Provider：${String(provider)}`);
}

/**
 * 预期身份全部从当前runtime、固定Provider源码和当前cache合同推导，绝不接受evidence
 * 反向指定命令、cwd、端口或commit。`off`在创建合同前直接返回，因而不会读取历史文件。
 */
export function memorySidecarContractsForRuntime({
  root,
  runtime,
  memory = "off",
  environment = process.env,
}) {
  return PROVIDERS_BY_MODE[assertMemoryMode(memory)].map((provider) =>
    providerContract({ root, runtime, provider, environment }),
  );
}

/** 仅供wrapper和隔离纵向传入已验证的运行边界；生产preflight使用上面的runtime工厂。 */
export function createMemorySidecarContract({
  root,
  provider,
  runtimeInstance,
  sourceCommit,
  port,
  runRoot,
  childCwd,
  commandFragments,
}) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Memory端口无效");
  if (!Array.isArray(commandFragments) || commandFragments.length === 0) {
    throw new Error("Memory命令身份不能为空");
  }
  const normalizedRunRoot = resolve(runRoot);
  return Object.freeze({
    provider,
    role: provider === "memmy" ? "memory" : "memoryCore",
    runtimeInstance,
    sourceCommit,
    port,
    runRoot: normalizedRunRoot,
    evidencePath: join(normalizedRunRoot, "service-process.json"),
    childCwd: resolve(childCwd),
    commandFragments: Object.freeze([...commandFragments]),
    root: resolve(root),
  });
}

function validateStaticEvidence(contract, evidence) {
  if (
    evidence.provider !== contract.provider ||
    evidence.runtimeInstance !== contract.runtimeInstance ||
    evidence.sourceCommit !== contract.sourceCommit ||
    evidence.port !== contract.port ||
    typeof evidence.runRoot !== "string" ||
    !samePath(evidence.runRoot, contract.runRoot) ||
    typeof evidence.childCwd !== "string" ||
    !samePath(evidence.childCwd, contract.childCwd)
  ) {
    throw new Error(
      `${contract.provider}进程证据与当前runtime/provider合同不一致；已保留证据且未发送信号`,
    );
  }
}

function validateRunningEvidence(contract, evidence) {
  validateStaticEvidence(contract, evidence);
  if (
    evidence.status !== "running" ||
    typeof evidence.instanceId !== "string" ||
    evidence.instanceId.length < 16 ||
    !Number.isInteger(evidence.wrapperPid) ||
    evidence.wrapperPid < 2 ||
    !Number.isInteger(evidence.childPid) ||
    evidence.childPid < 2 ||
    evidence.childProcessGroupId !== evidence.childPid ||
    typeof evidence.childStartedAt !== "string" ||
    normalizeSecond(evidence.childStartedAt, "Memory childStartedAt") !== evidence.childStartedAt
  ) {
    throw new Error(`${contract.provider} v2运行证据不完整；已保留证据且未发送信号`);
  }
  return evidence;
}

export function readMemoryProcessEvidence(contract) {
  if (!existsSync(contract.evidencePath)) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(contract.evidencePath, "utf8"));
  } catch {
    throw new Error(`${contract.provider}进程证据损坏；已保留原文件且未发送信号`);
  }
  if (parsed?.schemaVersion === LEGACY_SCHEMAS[contract.provider]) {
    return Object.freeze({
      status: parsed.stoppedAt === undefined ? "legacy-running" : "legacy-stopped",
      raw: parsed,
    });
  }
  if (parsed?.schemaVersion !== MEMORY_PROCESS_EVIDENCE_SCHEMA) {
    throw new Error(`${contract.provider}进程证据schema未知；已保留原文件且未发送信号`);
  }
  if (parsed.status === "starting") {
    validateStaticEvidence(contract, parsed);
    if (
      typeof parsed.instanceId !== "string" ||
      parsed.instanceId.length < 16 ||
      !Number.isInteger(parsed.wrapperPid) ||
      parsed.wrapperPid < 2
    ) {
      throw new Error(`${contract.provider} v2启动证据不完整；已保留原文件`);
    }
    return Object.freeze({ ...parsed });
  }
  if (parsed.status === "stopped") {
    validateStaticEvidence(contract, parsed);
    if (typeof parsed.instanceId !== "string" || typeof parsed.stoppedAt !== "string") {
      throw new Error(`${contract.provider} v2停止证据不完整；已保留原文件`);
    }
    return Object.freeze({ ...parsed });
  }
  return Object.freeze({ ...validateRunningEvidence(contract, parsed) });
}

function baseEvidence(contract, instanceId) {
  return {
    schemaVersion: MEMORY_PROCESS_EVIDENCE_SCHEMA,
    provider: contract.provider,
    instanceId,
    runtimeInstance: contract.runtimeInstance,
    sourceCommit: contract.sourceCommit,
    port: contract.port,
    runRoot: contract.runRoot,
    childCwd: contract.childCwd,
  };
}

export function writeMemoryStartingEvidence(contract, { instanceId, wrapperPid }) {
  atomicWriteJson(contract.evidencePath, {
    ...baseEvidence(contract, instanceId),
    status: "starting",
    wrapperPid,
    startedAt: new Date().toISOString(),
  });
}

export function writeMemoryRunningEvidence(
  contract,
  { instanceId, wrapperPid, childPid, childStartedAt, childProcessGroupId },
) {
  atomicWriteJson(contract.evidencePath, {
    ...baseEvidence(contract, instanceId),
    status: "running",
    wrapperPid,
    childPid,
    childProcessGroupId,
    childStartedAt: normalizeSecond(childStartedAt, "Memory childStartedAt"),
    startedAt: new Date().toISOString(),
  });
}

export function writeMemoryStoppedEvidence(contract, instanceId, extra = {}) {
  const current = readMemoryProcessEvidence(contract);
  const confirmedStaleLegacy =
    current?.status === "legacy-running" &&
    extra.migratedFrom === LEGACY_SCHEMAS[contract.provider] &&
    extra.legacyProcessesConfirmedExited === true;
  if (
    current !== undefined &&
    !["legacy-stopped"].includes(current.status) &&
    !confirmedStaleLegacy &&
    current.instanceId !== instanceId
  ) {
    throw new Error(`${contract.provider} evidence已由另一instance接管；拒绝覆盖停止证据`);
  }
  atomicWriteJson(contract.evidencePath, {
    ...baseEvidence(contract, instanceId),
    status: "stopped",
    stoppedAt: new Date().toISOString(),
    ...extra,
  });
}

export function processGroupId(pid) {
  try {
    const value = execFileSync("ps", ["-p", String(pid), "-o", "pgid="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 1 ? parsed : null;
  } catch {
    return null;
  }
}

export function isProcessGroupAlive(processGroup) {
  try {
    process.kill(-processGroup, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

export function signalProcessGroup(processGroup, signal) {
  process.kill(-processGroup, signal);
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** wrapper只登记OS已经确认的新组leader，避免用本地时钟伪造可回收身份。 */
export function captureSpawnedMemoryChildIdentity(contract, childPid, options = {}) {
  const describe = options.describe ?? describeProcess;
  const workingDirectory = options.workingDirectory ?? processWorkingDirectory;
  const groupFor = options.processGroup ?? processGroupId;
  const sleep = options.sleep ?? sleepSync;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 1_000);
  for (;;) {
    const description = describe(childPid);
    const cwd = workingDirectory(childPid);
    const group = groupFor(childPid);
    if (
      description &&
      Number.isFinite(description.startedAtMs) &&
      contract.commandFragments.every((fragment) => description.command.includes(fragment)) &&
      cwd !== null &&
      samePath(cwd, contract.childCwd) &&
      group === childPid
    ) {
      return Object.freeze({
        childPid,
        childProcessGroupId: group,
        childStartedAt: new Date(description.startedAtMs).toISOString(),
      });
    }
    if (now() >= deadline) {
      throw new Error(`${contract.provider}新子进程无法建立命令/cwd/独立进程组证据`);
    }
    sleep(10);
  }
}

function sameRunningInstance(expected, current) {
  return (
    current?.status === "running" &&
    current.instanceId === expected.instanceId &&
    current.childPid === expected.childPid &&
    current.childProcessGroupId === expected.childProcessGroupId &&
    current.childStartedAt === expected.childStartedAt
  );
}

function sameLegacyEvidence(expected, current) {
  return (
    current?.status === "legacy-running" &&
    JSON.stringify(current.raw) === JSON.stringify(expected.raw)
  );
}

function assertLiveIdentity(contract, evidence, dependencies, { requireListener }) {
  const description = dependencies.describe(evidence.childPid);
  const cwd = dependencies.workingDirectory(evidence.childPid);
  const listenerPid = dependencies.listener(contract.port);
  const group = dependencies.processGroup(evidence.childPid);
  const describedStartedAt = Number.isFinite(description?.startedAtMs)
    ? new Date(Math.trunc(description.startedAtMs / 1_000) * 1_000).toISOString()
    : null;
  const listenerMatches = requireListener
    ? listenerPid === evidence.childPid
    : listenerPid === null || listenerPid === evidence.childPid;
  if (
    !description ||
    describedStartedAt !== evidence.childStartedAt ||
    !contract.commandFragments.every((fragment) => description.command.includes(fragment)) ||
    cwd === null ||
    !samePath(cwd, contract.childCwd) ||
    group !== evidence.childProcessGroupId ||
    !listenerMatches
  ) {
    throw new Error(
      `${contract.provider} listener/启动秒/命令/cwd/process-group身份不匹配；未发送后续信号`,
    );
  }
}

function waitForGroupExit(evidence, contract, dependencies, timeoutMs) {
  const deadline = dependencies.now() + timeoutMs;
  while (dependencies.now() < deadline) {
    if (
      !dependencies.isAlive(evidence.childPid) &&
      !dependencies.groupAlive(evidence.childProcessGroupId) &&
      dependencies.listener(contract.port) === null
    ) {
      return true;
    }
    dependencies.sleep(50);
  }
  return false;
}

function defaultDependencies(options) {
  return {
    readEvidence: options.readEvidence ?? readMemoryProcessEvidence,
    writeStopped: options.writeStopped ?? writeMemoryStoppedEvidence,
    describe: options.describe ?? describeProcess,
    workingDirectory: options.workingDirectory ?? processWorkingDirectory,
    listener: options.listener ?? findListenerPid,
    processGroup: options.processGroup ?? processGroupId,
    isAlive: options.isAlive ?? isEffectivelyAlive,
    groupAlive: options.groupAlive ?? isProcessGroupAlive,
    signalGroup: options.signalGroup ?? signalProcessGroup,
    sleep: options.sleep ?? sleepSync,
    now: options.now ?? Date.now,
  };
}

/**
 * 回收一个固定Memory Sidecar的孤儿进程组。第一次完整身份检查后复读evidence与全部
 * 运行身份，只有同一instance仍成立才发TERM；升级KILL前再做一次相同复核。
 */
export function reconcileManagedMemorySidecar(contract, options = {}) {
  const dependencies = defaultDependencies(options);
  const evidence = dependencies.readEvidence(contract);
  if (evidence === undefined) return { provider: contract.provider, action: "no-evidence" };
  if (evidence.status === "legacy-stopped") {
    dependencies.writeStopped(contract, randomUUID(), {
      migratedFrom: LEGACY_SCHEMAS[contract.provider],
    });
    return { provider: contract.provider, action: "migrated-legacy-stopped" };
  }
  if (evidence.status === "legacy-running") {
    const wrapperPid = evidence.raw?.wrapperPid;
    const childPid = evidence.raw?.childPid;
    if (
      !Number.isInteger(wrapperPid) ||
      wrapperPid < 2 ||
      !Number.isInteger(childPid) ||
      childPid < 2 ||
      dependencies.isAlive(wrapperPid) ||
      dependencies.isAlive(childPid) ||
      dependencies.listener(contract.port) !== null
    ) {
      throw new Error(`${contract.provider}旧进程证据仍可能对应活动进程；已保留证据且未发送信号`);
    }
    const current = dependencies.readEvidence(contract);
    if (
      !sameLegacyEvidence(evidence, current) ||
      dependencies.isAlive(wrapperPid) ||
      dependencies.isAlive(childPid) ||
      dependencies.listener(contract.port) !== null
    ) {
      throw new Error(`${contract.provider}旧进程证据在迁移前变化；已保留证据且未发送信号`);
    }
    dependencies.writeStopped(contract, randomUUID(), {
      migratedFrom: LEGACY_SCHEMAS[contract.provider],
      legacyProcessesConfirmedExited: true,
    });
    return { provider: contract.provider, action: "migrated-stale-legacy-running" };
  }
  if (evidence.status === "starting") {
    throw new Error(`${contract.provider}缺少可安全回收的完整v2运行证据；已保留证据且未发送信号`);
  }
  if (evidence.status === "stopped") {
    return { provider: contract.provider, action: "already-stopped" };
  }
  validateRunningEvidence(contract, evidence);

  if (!dependencies.isAlive(evidence.childPid)) {
    if (
      dependencies.listener(contract.port) !== null ||
      dependencies.groupAlive(evidence.childProcessGroupId)
    ) {
      throw new Error(`${contract.provider}主进程已退出但端口或进程组仍存在；身份不足，未发送信号`);
    }
    dependencies.writeStopped(contract, evidence.instanceId, {
      recoveredAt: new Date().toISOString(),
    });
    return { provider: contract.provider, action: "stale-evidence" };
  }

  assertLiveIdentity(contract, evidence, dependencies, { requireListener: true });
  const secondEvidence = dependencies.readEvidence(contract);
  if (!sameRunningInstance(evidence, secondEvidence)) {
    throw new Error(`${contract.provider} evidence在TERM前变化；未发送信号`);
  }
  assertLiveIdentity(contract, secondEvidence, dependencies, { requireListener: true });
  dependencies.signalGroup(evidence.childProcessGroupId, "SIGTERM");
  let action = "terminated";
  if (!waitForGroupExit(evidence, contract, dependencies, options.termWaitMs ?? 5_000)) {
    const beforeKill = dependencies.readEvidence(contract);
    if (!sameRunningInstance(evidence, beforeKill)) {
      throw new Error(`${contract.provider} evidence在KILL前变化；拒绝升级信号`);
    }
    if (!dependencies.isAlive(evidence.childPid)) {
      throw new Error(`${contract.provider}组leader已退出但进程组仍存活；拒绝向复用组发送KILL`);
    }
    assertLiveIdentity(contract, beforeKill, dependencies, { requireListener: false });
    dependencies.signalGroup(evidence.childProcessGroupId, "SIGKILL");
    action = "killed";
    if (!waitForGroupExit(evidence, contract, dependencies, options.killWaitMs ?? 1_500)) {
      throw new Error(`${contract.provider}受管进程组在KILL后仍存活`);
    }
  }
  const current = dependencies.readEvidence(contract);
  if (current?.status === "running") {
    if (!sameRunningInstance(evidence, current)) {
      throw new Error(`${contract.provider} evidence在回收后由另一instance接管；拒绝覆盖`);
    }
    dependencies.writeStopped(contract, evidence.instanceId, {
      recoveredAt: new Date().toISOString(),
      recoveryAction: action,
    });
  } else if (current?.status !== "stopped") {
    throw new Error(`${contract.provider}回收后evidence状态不确定；拒绝覆盖`);
  }
  return { provider: contract.provider, action };
}

export function reconcileSelectedMemorySidecars(
  { root, runtime, memory = "off", environment = process.env },
  options = {},
) {
  const createContracts = options.createContracts ?? memorySidecarContractsForRuntime;
  const reconcile = options.reconcile ?? reconcileManagedMemorySidecar;
  // 这条早返回是off零读取的硬门；不能先枚举runRoot或尝试迁移历史evidence。
  if (assertMemoryMode(memory) === "off") return [];
  return createContracts({ root, runtime, memory, environment }).map((contract) =>
    reconcile(contract, options),
  );
}
