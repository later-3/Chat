import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { createSafeChildProcessEnvironment } from "../memory/fixed-memmy.mjs";
import { describeProcess } from "../debug/lib.mjs";

/**
 * code-server 运行工件证据。
 *
 * 版本与平台资产均固定到 Coder 官方 GitHub Release；SHA-256 来自该 Release
 * API 的 digest 字段。这里绝不下载 latest，也不执行 curl | sh。升级必须显式
 * 修改版本、Tag commit、四个平台工件及测试证据。
 */
export const FIXED_CODE_SERVER_VERSION = "4.132.0";
export const FIXED_CODE_SERVER_TAG_COMMIT = "313bf0359b4d391ba18f1fa131aad8a583bc2919";
export const FIXED_CODE_SERVER_PREPARE_LOCK_PORT = 43_119;
export const FIXED_CODE_SERVER_EVIDENCE_FILE = ".chat-fixed-code-server.json";
export const CODE_SERVER_PROCESS_EVIDENCE_SCHEMA = "chat-code-server-process.v2";
export const CODE_SERVER_SOCKET_NAME = "workbench.sock";
export const DISABLED_EXTENSIONS_GALLERY = "{}";
export const EXTENSIONS_GALLERY_HOOK_PATH = "lib/vscode/out/server-main.js";
export const MANAGED_CODE_SERVER_SETTINGS = Object.freeze({
  "chat.disableAIFeatures": true,
  "extensions.autoCheckUpdates": false,
  "extensions.autoUpdate": false,
  "remote.autoForwardPorts": false,
  "task.allowAutomaticTasks": "off",
  // 当前固定VS Code runtime仍注册这3个设置；新旧Telemetry读取路径一并关闭。
  "telemetry.telemetryLevel": "off",
  "telemetry.enableTelemetry": false,
  "telemetry.enableCrashReporter": false,
});

const EVIDENCE_SCHEMA = "chat-fixed-code-server-runtime.v1";
const RELEASE_BASE = `https://github.com/coder/code-server/releases/download/v${FIXED_CODE_SERVER_VERSION}`;
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * 43119只属于production；debug与E2E必须由各自实例显式注入独立租约端口。
 * 端口只承担进程互斥，不提供HTTP或Workbench内容。
 */
export function resolveCodeServerPrepareLeasePort(environment = process.env) {
  const configured = environment.CHAT_CODE_WORKBENCH_LEASE_PORT?.trim();
  if (configured === undefined || configured === "") return FIXED_CODE_SERVER_PREPARE_LOCK_PORT;
  if (!/^\d+$/u.test(configured)) {
    throw new Error("CHAT_CODE_WORKBENCH_LEASE_PORT必须是有效TCP端口");
  }
  const port = Number.parseInt(configured, 10);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("CHAT_CODE_WORKBENCH_LEASE_PORT必须在1024..65535之间");
  }
  return port;
}

export const FIXED_CODE_SERVER_ASSETS = Object.freeze({
  "darwin-arm64": Object.freeze({
    name: `code-server-${FIXED_CODE_SERVER_VERSION}-macos-arm64.tar.gz`,
    directory: `code-server-${FIXED_CODE_SERVER_VERSION}-macos-arm64`,
    size: 211_120_710,
    sha256: "449814f6637faaf9b68544f7bce560f5ec500de688815d5c7f9afa7a51577992",
  }),
  "darwin-x64": Object.freeze({
    name: `code-server-${FIXED_CODE_SERVER_VERSION}-macos-amd64.tar.gz`,
    directory: `code-server-${FIXED_CODE_SERVER_VERSION}-macos-amd64`,
    size: 230_542_235,
    sha256: "eddc7a8ea9d4575ae3e4813c624f7e012be191a0670d2e5187a6301fd59f6307",
  }),
  "linux-arm64": Object.freeze({
    name: `code-server-${FIXED_CODE_SERVER_VERSION}-linux-arm64.tar.gz`,
    directory: `code-server-${FIXED_CODE_SERVER_VERSION}-linux-arm64`,
    size: 232_503_176,
    sha256: "ade569a677d1c04ee66ef153382b7e15bf261f955407663c7ddc6b87f9ee29fc",
  }),
  "linux-x64": Object.freeze({
    name: `code-server-${FIXED_CODE_SERVER_VERSION}-linux-amd64.tar.gz`,
    directory: `code-server-${FIXED_CODE_SERVER_VERSION}-linux-amd64`,
    size: 238_758_593,
    sha256: "a38d26f4cb81f768feddff79e2937fd3f39c83d3da8be3da7225e1087e62e4ed",
  }),
});

export function chatRepoRoot() {
  return resolve(process.env.CHAT_REPO_ROOT ?? resolve(SCRIPTS_DIR, "../.."));
}

export function codeServerRunRoot(repoRoot = chatRepoRoot(), environment = process.env) {
  return resolve(
    environment.CHAT_CODE_WORKBENCH_RUN_ROOT ?? resolve(repoRoot, ".data/workbench/code-server"),
  );
}

export function codeServerProcessEvidencePath(
  repoRoot = chatRepoRoot(),
  environment = process.env,
) {
  return resolve(codeServerRunRoot(repoRoot, environment), "service-process.json");
}

/**
 * stopped只证明“本轮进程与socket已经完全退出”，因此不能继续携带可能被PID复用的
 * 运行身份。instanceId用于并发handoff复核；legacy迁移没有该身份时允许省略。
 */
export function writeCodeServerStoppedTombstone(
  evidencePath,
  { workspaceRoot, instanceId, stoppedAt = new Date().toISOString(), recoveredAt, migratedFrom },
) {
  const tombstone = {
    schemaVersion: CODE_SERVER_PROCESS_EVIDENCE_SCHEMA,
    status: "stopped",
    workspaceRoot,
    ...(instanceId === undefined ? {} : { instanceId }),
    stoppedAt,
    ...(recoveredAt === undefined ? {} : { recoveredAt }),
    ...(migratedFrom === undefined ? {} : { migratedFrom }),
  };
  const temporary = `${evidencePath}.tmp-${String(process.pid)}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(tombstone, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, evidencePath);
  } finally {
    rmSync(temporary, { force: true });
  }
  return Object.freeze(tombstone);
}

function validProcessInstanceId(instanceId) {
  return (
    typeof instanceId === "string" &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(instanceId)
  );
}

/** wrapper、Supervisor readiness与Gateway必须共享同一受信临时父目录，不能各读已清洗环境。 */
export function resolveCodeServerTemporaryParent(environment = process.env) {
  const configured =
    environment.CHAT_CODE_WORKBENCH_TEMP_PARENT ??
    environment.TMPDIR ??
    environment.TMP ??
    environment.TEMP ??
    tmpdir();
  let parent;
  try {
    parent = realpathSync(resolve(configured));
  } catch {
    throw new Error("code-server临时父目录必须是已存在的真实目录");
  }
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("code-server临时父目录必须是非符号链接目录");
  }
  return parent;
}

/**
 * 读取wrapper留下的本地运行证据。该文件不是授权凭据；调用者仍须复核进程身份，
 * 或在代理前调用validateCodeServerSocketEvidence复核私有目录和socket权限。
 */
export function readCodeServerProcessEvidence(
  repoRoot = chatRepoRoot(),
  environment = process.env,
) {
  const path = codeServerProcessEvidencePath(repoRoot, environment);
  if (!existsSync(path)) return undefined;
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("code-server进程证据损坏；拒绝猜测Unix socket或启动第二套服务");
  }
  const managedWorkspace = realpathSync(resolve(repoRoot));
  if (evidence?.schemaVersion === "chat-code-server-process.v1") {
    if (
      evidence.workspaceRoot !== managedWorkspace ||
      !Number.isInteger(evidence.wrapperPid) ||
      !Number.isInteger(evidence.childPid) ||
      evidence.port !== 43_113
    ) {
      throw new Error("旧版code-server进程证据身份不完整；已保留并拒绝自动迁移");
    }
    if (typeof evidence.stoppedAt === "string") {
      return Object.freeze({ ...evidence, status: "legacy-stopped", evidencePath: path });
    }
    if (typeof evidence.startedAt === "string") {
      return Object.freeze({ ...evidence, status: "legacy-running", evidencePath: path });
    }
    throw new Error("旧版code-server进程证据缺少启动/停止时间；已保留并拒绝自动迁移");
  }
  if (
    evidence?.schemaVersion === CODE_SERVER_PROCESS_EVIDENCE_SCHEMA &&
    evidence?.status === "stopped" &&
    evidence?.workspaceRoot === managedWorkspace &&
    evidence?.privateRoot === undefined &&
    evidence?.socketPath === undefined
  ) {
    if (
      typeof evidence.stoppedAt !== "string" ||
      (evidence.instanceId !== undefined && !validProcessInstanceId(evidence.instanceId))
    ) {
      throw new Error("code-server stopped tombstone身份损坏；拒绝检查历史PID");
    }
    return Object.freeze({ ...evidence, evidencePath: path });
  }
  const privateRoot = resolve(String(evidence?.privateRoot ?? ""));
  const socketPath = resolve(String(evidence?.socketPath ?? ""));
  const temporaryParent = resolveCodeServerTemporaryParent(environment);
  let privateParent;
  try {
    privateParent = realpathSync(dirname(privateRoot));
  } catch {
    privateParent = undefined;
  }
  if (
    evidence?.schemaVersion !== CODE_SERVER_PROCESS_EVIDENCE_SCHEMA ||
    !["starting", "running", "stopped"].includes(evidence?.status) ||
    !validProcessInstanceId(evidence?.instanceId) ||
    !Number.isInteger(evidence?.wrapperPid) ||
    (evidence.status === "starting" ||
    (evidence.status === "stopped" && evidence?.childPid === null)
      ? evidence?.childPid !== null
      : !Number.isInteger(evidence?.childPid)) ||
    typeof evidence?.wrapperStartedAt !== "string" ||
    (Number.isInteger(evidence?.childPid) && typeof evidence?.childStartedAt !== "string") ||
    typeof evidence?.workspaceRoot !== "string" ||
    evidence.workspaceRoot !== managedWorkspace ||
    evidence.cacheRoot !==
      fixedCodeServerCacheRoot(repoRoot, process.platform, process.arch, environment) ||
    privateParent !== temporaryParent ||
    dirname(socketPath) !== privateRoot ||
    socketPath !== join(privateRoot, CODE_SERVER_SOCKET_NAME) ||
    !privateRoot.split(sep).at(-1)?.startsWith("chat-cs-")
  ) {
    throw new Error("code-server进程证据不符合受管Unix socket合同；拒绝继续");
  }
  if (existsSync(privateRoot)) {
    const rootStat = lstatSync(privateRoot);
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      rootStat.isSymbolicLink() ||
      !rootStat.isDirectory() ||
      (rootStat.mode & 0o777) !== 0o700 ||
      (expectedUid !== undefined && rootStat.uid !== expectedUid)
    ) {
      throw new Error("code-server privateRoot必须是系统临时目录直属、当前用户拥有的0700真实目录");
    }
  }
  return Object.freeze({ ...evidence, privateRoot, socketPath, evidencePath: path });
}

/** 浏览器代理前必须逐次证明目标确实是本轮0600 Unix socket。 */
export function validateCodeServerSocketEvidence(
  repoRoot = chatRepoRoot(),
  environment = process.env,
) {
  const evidence = readCodeServerProcessEvidence(repoRoot, environment);
  if (evidence === undefined || evidence.status !== "running") {
    throw new Error("code-server Unix socket尚未由受管wrapper声明为running");
  }
  let privateStat;
  let socketStat;
  try {
    privateStat = statSync(evidence.privateRoot);
    socketStat = lstatSync(evidence.socketPath);
  } catch {
    throw new Error("code-server受管Unix socket尚未创建");
  }
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    !privateStat.isDirectory() ||
    (privateStat.mode & 0o777) !== 0o700 ||
    (expectedUid !== undefined && privateStat.uid !== expectedUid) ||
    !socketStat.isSocket() ||
    (socketStat.mode & 0o777) !== 0o600 ||
    (expectedUid !== undefined && socketStat.uid !== expectedUid)
  ) {
    throw new Error("code-server Unix socket必须属于当前用户并位于0700目录、使用0600权限");
  }
  return evidence;
}

export async function probeCodeServerSocketReady(
  repoRoot = chatRepoRoot(),
  { environment = process.env, timeoutMs = 1_500 } = {},
) {
  const evidence = validateCodeServerSocketEvidence(repoRoot, environment);
  await new Promise((resolveReady, rejectReady) => {
    const request = httpRequest(
      {
        socketPath: evidence.socketPath,
        path: "/healthz",
        method: "GET",
        headers: { host: "localhost", connection: "close" },
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          if (response.statusCode === 200) resolveReady();
          else rejectReady(new Error(`code-server health返回HTTP ${String(response.statusCode)}`));
        });
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error("code-server socket就绪超时")));
    request.once("error", rejectReady);
    request.end();
  });
  return evidence;
}

export function codeServerPlatformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

export function fixedCodeServerAsset(platform = process.platform, arch = process.arch) {
  const key = codeServerPlatformKey(platform, arch);
  const asset = FIXED_CODE_SERVER_ASSETS[key];
  if (asset === undefined) {
    throw new Error(`code-server P0 暂不支持平台 ${key}；只支持 macOS/Linux 的 x64/arm64`);
  }
  return Object.freeze({ ...asset, key, url: `${RELEASE_BASE}/${asset.name}` });
}

export function fixedCodeServerCacheRoot(
  repoRoot = chatRepoRoot(),
  platform = process.platform,
  arch = process.arch,
  environment = process.env,
) {
  const cacheRoot = resolve(
    environment.CHAT_FIXED_SOURCE_CACHE_ROOT ?? resolve(repoRoot, ".data/cache"),
  );
  return resolve(
    cacheRoot,
    "code-server",
    `v${FIXED_CODE_SERVER_VERSION}`,
    codeServerPlatformKey(platform, arch),
  );
}

export function fixedCodeServerExecutable(
  repoRoot = chatRepoRoot(),
  platform = process.platform,
  arch = process.arch,
) {
  const executable = platform === "win32" ? "code-server.cmd" : "code-server";
  return join(fixedCodeServerCacheRoot(repoRoot, platform, arch), "runtime", "bin", executable);
}

export function sha256File(path) {
  const hash = createHash("sha256");
  updateHashWithFile(hash, path);
  return hash.digest("hex");
}

function updateHashWithFile(hash, path) {
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
}

function* manifestEntries(root, current = root) {
  for (const name of readdirSync(current).sort()) {
    const absolute = join(current, name);
    const pathFromRoot = relative(root, absolute).split(sep).join("/");
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      yield* manifestEntries(root, absolute);
    } else if (stat.isSymbolicLink()) {
      yield { path: pathFromRoot, link: readlinkSync(absolute) };
    } else if (stat.isFile()) {
      yield { path: pathFromRoot, file: absolute };
    }
  }
}

/** Hash 路径与文件内容，防止已解压 runtime 在缓存中静默漂移。 */
export function runtimeManifestSha256(runtimeRoot) {
  const hash = createHash("sha256");
  for (const entry of manifestEntries(runtimeRoot)) {
    hash.update(entry.path);
    hash.update("\0");
    if (entry.link !== undefined) hash.update(`symlink:${entry.link}`);
    else updateHashWithFile(hash, entry.file);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * 固定code-server在产品初始化时允许EXTENSIONS_GALLERY覆盖Open VSX默认值。
 * 运行时必须保留这个官方hook，才能用空对象关闭serviceUrl；升级后hook漂移时
 * 供应链校验失败关闭，不能静默恢复外部扩展市场。
 */
export function runtimeSupportsManagedExtensionsGallery(runtimeRoot) {
  try {
    const source = readFileSync(join(runtimeRoot, EXTENSIONS_GALLERY_HOOK_PATH), "utf8");
    return /([A-Za-z_$][\w$]*)\.EXTENSIONS_GALLERY\?JSON\.parse\(\1\.EXTENSIONS_GALLERY\):([A-Za-z_$][\w$]*)\.extensionsGallery\|\|/u.test(
      source,
    );
  } catch {
    return false;
  }
}

function readEvidence(cacheRoot) {
  try {
    return JSON.parse(readFileSync(join(cacheRoot, FIXED_CODE_SERVER_EVIDENCE_FILE), "utf8"));
  } catch {
    return undefined;
  }
}

export function validateCodeServerCache({ cacheRoot, asset }) {
  const evidence = readEvidence(cacheRoot);
  const archivePath = join(cacheRoot, "release.tar.gz");
  const runtimeRoot = join(cacheRoot, "runtime");
  const executable = join(runtimeRoot, "bin", "code-server");
  if (
    evidence?.schemaVersion !== EVIDENCE_SCHEMA ||
    evidence?.version !== FIXED_CODE_SERVER_VERSION ||
    evidence?.tagCommit !== FIXED_CODE_SERVER_TAG_COMMIT ||
    evidence?.platform !== asset.key ||
    evidence?.asset !== asset.name ||
    evidence?.assetSha256 !== asset.sha256 ||
    !/^[0-9a-f]{64}$/u.test(evidence?.runtimeManifestSha256 ?? "") ||
    !existsSync(archivePath) ||
    !existsSync(executable)
  ) {
    return false;
  }
  try {
    return (
      lstatSync(archivePath).size === asset.size &&
      sha256File(archivePath) === asset.sha256 &&
      runtimeSupportsManagedExtensionsGallery(runtimeRoot) &&
      runtimeManifestSha256(runtimeRoot) === evidence.runtimeManifestSha256
    );
  } catch {
    return false;
  }
}

export function validateFixedCodeServerCache(
  repoRoot = chatRepoRoot(),
  platform = process.platform,
  arch = process.arch,
) {
  const asset = fixedCodeServerAsset(platform, arch);
  return validateCodeServerCache({
    cacheRoot: fixedCodeServerCacheRoot(repoRoot, platform, arch),
    asset,
  });
}

/** 避免macOS zsh把全新隔离HOME识别为首次使用并阻塞在交互配置向导。 */
export function prepareIsolatedShellHome(home) {
  const shellHome = resolve(home);
  mkdirSync(shellHome, { recursive: true });
  const zshrc = join(shellHome, ".zshrc");
  if (!existsSync(zshrc)) {
    writeFileSync(zshrc, "# Chat-managed isolated shell home; do not source host profiles.\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  }
  return zshrc;
}

/**
 * 只覆盖Chat必须强制的安全键，保留用户在受管Workbench中的编辑器偏好。
 * 无效JSON失败关闭并保留原文件；同目录临时文件原子替换，避免进程中断留下半份配置。
 */
export function mergeManagedCodeServerSettings(settingsPath) {
  const path = resolve(settingsPath);
  mkdirSync(dirname(path), { recursive: true });
  let existing = {};
  if (existsSync(path)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error("code-server User/settings.json不是有效JSON；已保留原文件并拒绝覆盖");
    }
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("code-server User/settings.json必须是JSON对象；已保留原文件并拒绝覆盖");
    }
    existing = parsed;
  }
  const merged = { ...existing, ...MANAGED_CODE_SERVER_SETTINGS };
  const temporary = `${path}.tmp-${String(process.pid)}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return Object.freeze(merged);
}

/** VS Code会在TMPDIR创建Unix socket；macOS约104字节上限要求这里使用独占短路径。 */
export function createShortCodeServerTemporaryRoot(systemTemporaryRoot = tmpdir()) {
  const temporaryRoot = mkdtempSync(join(resolve(systemTemporaryRoot), "chat-cs-"));
  chmodSync(temporaryRoot, 0o700);
  if (Buffer.byteLength(join(temporaryRoot, "vscode-ipc-.sock"), "utf8") > 100) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw new Error("系统临时目录过长，无法安全承载code-server Unix socket");
  }
  return temporaryRoot;
}

/** 让需要Unix socket的user-data路径保持短，同时把实际状态持久化在Chat的受管目录。 */
export function createShortUserDataLink(shortTemporaryRoot, persistentUserDataRoot) {
  const persistentRoot = resolve(persistentUserDataRoot);
  mkdirSync(persistentRoot, { recursive: true });
  const shortRoot = join(resolve(shortTemporaryRoot), "user-data");
  symlinkSync(persistentRoot, shortRoot, "dir");
  if (realpathSync(shortRoot) !== realpathSync(persistentRoot)) {
    throw new Error("code-server短user-data链接未指向受管持久目录");
  }
  return shortRoot;
}

async function downloadRange({ url, file, start, end, size, fetchImpl }) {
  const response = await fetchImpl(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Chat-code-workbench-preparer",
      range: `bytes=${String(start)}-${String(end)}`,
    },
  });
  if (response.status !== 206 || response.body === null) {
    throw new Error(`下载 code-server 分片失败：HTTP ${String(response.status)}`);
  }
  const contentRange = response.headers.get("content-range");
  if (contentRange !== `bytes ${String(start)}-${String(end)}/${String(size)}`) {
    throw new Error("code-server Release 分片 Content-Range 与请求不一致");
  }
  const reader = response.body.getReader();
  let position = start;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined || position + value.byteLength > end + 1) {
      throw new Error("code-server Release 分片返回了越界内容");
    }
    await file.write(value, 0, value.byteLength, position);
    position += value.byteLength;
  }
  if (position !== end + 1) {
    throw new Error("code-server Release 分片提前结束");
  }
}

/** GitHub Release 支持Range；并行固定分片可避免单连接在弱网络下耗时数十分钟。 */
export async function downloadReleaseAsset(url, destination, size, fetchImpl = fetch) {
  const file = await open(destination, "w", 0o600);
  try {
    await file.truncate(size);
    const concurrency = 8;
    const chunkSize = Math.ceil(size / concurrency);
    const ranges = Array.from({ length: concurrency }, (_value, index) => {
      const start = index * chunkSize;
      const end = Math.min(size - 1, start + chunkSize - 1);
      return { start, end };
    }).filter(({ start }) => start < size);
    await Promise.all(
      ranges.map(({ start, end }) => downloadRange({ url, file, start, end, size, fetchImpl })),
    );
  } finally {
    await file.close();
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const PREPARE_LOCK_START_TOLERANCE_MS = 2_000;
const PREPARE_LOCK_INITIALIZATION_GRACE_MS = 30_000;
const ownedPrepareLockTokens = new Map();
const activePrepareLeases = new WeakSet();

function prepareLockState(lockPath) {
  try {
    const stat = lstatSync(lockPath);
    const ownerPath = stat.isDirectory() ? join(lockPath, "owner.json") : lockPath;
    let owner;
    try {
      owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    } catch {
      owner = undefined;
    }
    return { owner, modifiedAtMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}

function prepareLockOwnerIsLive(owner) {
  if (!Number.isInteger(owner?.pid) || !processIsAlive(owner.pid)) return false;
  if (!Number.isFinite(owner?.processStartedAtMs)) return true;
  const current = describeProcess(owner.pid);
  if (current === null) return true;
  return (
    Math.abs(current.startedAtMs - owner.processStartedAtMs) <= PREPARE_LOCK_START_TOLERANCE_MS
  );
}

function currentPrepareLockOwner() {
  const describedStart = describeProcess(process.pid)?.startedAtMs;
  return {
    pid: process.pid,
    processStartedAtMs: Number.isFinite(describedStart) ? describedStart : Date.now(),
    acquiredAt: new Date().toISOString(),
    token: randomUUID(),
  };
}

/** owner先写入私有文件，再用hard link的O_EXCL语义原子发布，目标存在时绝不覆盖。 */
function publishPrepareLock(lockPath, owner) {
  const candidate = `${lockPath}.candidate-${String(process.pid)}-${randomUUID()}`;
  try {
    writeFileSync(candidate, `${JSON.stringify(owner)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    linkSync(candidate, lockPath);
  } finally {
    rmSync(candidate, { force: true });
  }
}

/**
 * 取得由操作系统拥有的准备租约。
 *
 * 文件锁无法在恢复者自身崩溃时证明谁有权接管陈旧锁；loopback监听端口会在
 * 进程退出时由内核释放，因此它才是互斥权威。磁盘上的prepare-lock只保留
 * owner与中断证据，不再承担并发仲裁。端口已被占用时失败关闭，绝不终止占用者。
 */
export async function acquireCodeServerPrepareLease(port = FIXED_CODE_SERVER_PREPARE_LOCK_PORT) {
  const server = createServer((socket) => socket.destroy());
  const actualPort = await new Promise((resolvePort, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      if (error?.code === "EADDRINUSE") {
        reject(new Error(`code-server准备租约端口 ${String(port)} 已被占用；拒绝并发覆盖缓存`));
        return;
      }
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("code-server准备租约未取得TCP端口"));
        return;
      }
      resolvePort(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port, exclusive: true });
  });
  server.unref();

  let released = false;
  const lease = {
    port: actualPort,
    async release() {
      if (released) return;
      released = true;
      try {
        await new Promise((resolveClose, reject) => {
          server.close((error) => {
            if (error !== undefined) reject(error);
            else resolveClose();
          });
        });
      } finally {
        activePrepareLeases.delete(lease);
      }
    },
  };
  activePrepareLeases.add(lease);
  return Object.freeze(lease);
}

function assertActivePrepareLease(lease) {
  if (!activePrepareLeases.has(lease)) {
    throw new Error("必须先取得有效的code-server准备租约，才能修改准备锁");
  }
}

export function acquirePrepareLock(lockPath, lease) {
  assertActivePrepareLease(lease);
  const owner = currentPrepareLockOwner();
  try {
    publishPrepareLock(lockPath, owner);
    ownedPrepareLockTokens.set(lockPath, owner.token);
    return;
  } catch (error) {
    if (!existsSync(lockPath)) throw error;
  }

  const state = prepareLockState(lockPath);
  if (state === undefined) {
    publishPrepareLock(lockPath, owner);
    ownedPrepareLockTokens.set(lockPath, owner.token);
    return;
  }
  if (prepareLockOwnerIsLive(state.owner)) {
    throw new Error("另一个 code-server 准备进程正在运行；拒绝并发覆盖缓存");
  }
  if (
    state.owner === undefined &&
    Date.now() - state.modifiedAtMs < PREPARE_LOCK_INITIALIZATION_GRACE_MS
  ) {
    throw new Error("code-server 准备锁仍在初始化；拒绝把新鲜的半成品锁误判为陈旧锁");
  }
  renameSync(lockPath, `${lockPath}.stale-${Date.now()}-${randomUUID()}`);
  try {
    publishPrepareLock(lockPath, owner);
    ownedPrepareLockTokens.set(lockPath, owner.token);
  } catch (error) {
    if (existsSync(lockPath)) {
      throw new Error("另一个 code-server 准备进程已取得锁；拒绝并发覆盖缓存");
    }
    throw error;
  }
}

export function releasePrepareLock(lockPath) {
  try {
    const state = prepareLockState(lockPath);
    const token = ownedPrepareLockTokens.get(lockPath);
    if (token !== undefined && state?.owner?.token === token) {
      rmSync(lockPath, { recursive: true, force: true });
      ownedPrepareLockTokens.delete(lockPath);
    }
  } catch {
    // Lock损坏时保留现场；下一次准备会把它改名为stale证据后继续。
  }
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} 退出码 ${String(result.status)}`);
  }
  return result.stdout.trim();
}

export function parseReportedCodeServerVersion(output) {
  const versionLine = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(
      (line) =>
        line === FIXED_CODE_SERVER_VERSION || line.startsWith(`${FIXED_CODE_SERVER_VERSION} `),
    );
  if (versionLine === undefined) {
    throw new Error("code-server 自报输出中缺少固定版本行");
  }
  return versionLine;
}

function validateArchive(path, asset) {
  try {
    return lstatSync(path).size === asset.size && sha256File(path) === asset.sha256;
  } catch {
    return false;
  }
}

/**
 * 下载并原子安装固定官方工件。正常测试不会调用本函数；首次默认`pnpm dev`
 * 或显式`pnpm workbench:prepare:code-server`会产生约200MB网络下载。
 */
export async function ensureFixedCodeServer(
  repoRoot = chatRepoRoot(),
  {
    platform = process.platform,
    arch = process.arch,
    fetchImpl = fetch,
    environment = process.env,
  } = {},
) {
  const asset = fixedCodeServerAsset(platform, arch);
  const cacheRoot = fixedCodeServerCacheRoot(repoRoot, platform, arch, environment);
  if (validateCodeServerCache({ cacheRoot, asset })) {
    console.log(`[code-server] 固定运行工件就绪：v${FIXED_CODE_SERVER_VERSION} ${asset.key}`);
    return cacheRoot;
  }

  const cacheParent = dirname(cacheRoot);
  mkdirSync(cacheParent, { recursive: true });
  const lockPath = `${cacheRoot}.prepare-lock`;
  const lease = await acquireCodeServerPrepareLease(resolveCodeServerPrepareLeasePort(environment));
  let stage;
  let environmentRoot;
  let lockAcquired = false;
  try {
    // 首次校验和取得租约之间，另一个进程可能已经完成准备；租约内必须复核。
    if (validateCodeServerCache({ cacheRoot, asset })) {
      console.log(`[code-server] 固定运行工件就绪：v${FIXED_CODE_SERVER_VERSION} ${asset.key}`);
      return cacheRoot;
    }
    acquirePrepareLock(lockPath, lease);
    lockAcquired = true;
    stage = mkdtempSync(join(cacheParent, `.tmp-fixed-code-server-${asset.key}-`));
    environmentRoot = mkdtempSync(join(cacheParent, `.tmp-fixed-code-server-env-${asset.key}-`));
    const childEnvironment = createSafeChildProcessEnvironment(environmentRoot);
    const archivePath = join(stage, "release.tar.gz");
    const reusableArchivePath = join(cacheParent, `${asset.key}-${asset.sha256}.tar.gz`);
    if (validateArchive(reusableArchivePath, asset)) {
      linkSync(reusableArchivePath, archivePath);
      console.log(`[code-server] 复用已校验的 ${asset.name}`);
    } else {
      if (existsSync(reusableArchivePath)) {
        renameSync(reusableArchivePath, `${reusableArchivePath}.invalid-${Date.now()}`);
      }
      console.log(`[code-server] 下载 ${asset.name}（${String(asset.size)} bytes）…`);
      await downloadReleaseAsset(asset.url, archivePath, asset.size, fetchImpl);
      if (!validateArchive(archivePath, asset)) {
        throw new Error("code-server Release 大小或 SHA-256 与固定证据不一致");
      }
      linkSync(archivePath, reusableArchivePath);
    }

    const extractedParent = join(stage, "extracted");
    mkdirSync(extractedParent);
    run("tar", ["-xzf", archivePath, "-C", extractedParent], {
      cwd: stage,
      env: childEnvironment,
    });
    const extractedRoot = join(extractedParent, asset.directory);
    if (!existsSync(join(extractedRoot, "bin", "code-server"))) {
      throw new Error("code-server Release 缺少预期 bin/code-server");
    }
    const runtimeRoot = join(stage, "runtime");
    renameSync(extractedRoot, runtimeRoot);
    rmSync(extractedParent, { recursive: true, force: true });

    const executable = join(runtimeRoot, "bin", "code-server");
    const reportedVersion = parseReportedCodeServerVersion(
      run(executable, ["--version"], {
        cwd: runtimeRoot,
        env: childEnvironment,
      }),
    );
    const runtimeHash = runtimeManifestSha256(runtimeRoot);
    writeFileSync(
      join(stage, FIXED_CODE_SERVER_EVIDENCE_FILE),
      `${JSON.stringify(
        {
          schemaVersion: EVIDENCE_SCHEMA,
          version: FIXED_CODE_SERVER_VERSION,
          tagCommit: FIXED_CODE_SERVER_TAG_COMMIT,
          platform: asset.key,
          asset: asset.name,
          assetSize: asset.size,
          assetSha256: asset.sha256,
          runtimeManifestSha256: runtimeHash,
          reportedVersion,
          source: asset.url,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    if (existsSync(cacheRoot)) {
      renameSync(cacheRoot, `${cacheRoot}.invalid-${Date.now()}`);
    }
    renameSync(stage, cacheRoot);
    if (!validateCodeServerCache({ cacheRoot, asset })) {
      throw new Error("code-server 缓存写入后校验失败");
    }
    rmSync(reusableArchivePath, { force: true });
    console.log(`[code-server] 固定运行工件已准备：v${FIXED_CODE_SERVER_VERSION} ${asset.key}`);
    return cacheRoot;
  } finally {
    if (stage !== undefined && existsSync(stage)) {
      rmSync(stage, { recursive: true, force: true });
    }
    if (environmentRoot !== undefined && existsSync(environmentRoot)) {
      rmSync(environmentRoot, { recursive: true, force: true });
    }
    if (lockAcquired) releasePrepareLock(lockPath);
    await lease.release();
  }
}
