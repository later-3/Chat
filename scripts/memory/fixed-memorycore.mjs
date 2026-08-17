import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertChatDataPath,
  archiveFixedGitSource,
  chatRepoRoot,
  createSafeChildProcessEnvironment,
} from "./fixed-memmy.mjs";

export const FIXED_MEMORYCORE_COMMIT = "3a9748d3c61c2a2feb38237c9b28992250c1804e";
export const FIXED_MEMORYCORE_TREE = "3b41130cd6f716112c1e357d86d4dc6f494cb52f";
export const FIXED_MEMORYCORE_PORT = 18_970;
export const FIXED_MEMORYCORE_SOURCE_URL = "https://github.com/later-3/TencentDB-Agent-Memory.git";
export const FIXED_MEMORYCORE_LOCAL_MIRROR_ENV = "CHAT_TENCENT_MEMORYCORE_SOURCE_REPO";
export const FIXED_MEMORYCORE_LOCK_SHA256 =
  "906c9bc6fec5fd08599cc9cfc8a1ddf9a1eb336d993bf9212bcd0ee4281a6aaf";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_FILE = ".chat-fixed-memorycore-source.json";
const EVIDENCE_SCHEMA = "chat-fixed-memorycore-source.v2";
export const FIXED_MEMORYCORE_LOCK_PATH = resolve(
  SCRIPT_DIR,
  "locks/tencent-memorycore-3a9748d.package-lock.json",
);

export function fixedMemoryCoreCacheRoot(repoRoot = chatRepoRoot(), environment = process.env) {
  const cacheRoot = resolve(
    environment.CHAT_FIXED_SOURCE_CACHE_ROOT ?? resolve(repoRoot, ".data/cache"),
  );
  return resolve(cacheRoot, "tencent-memorycore", FIXED_MEMORYCORE_COMMIT);
}

export function fixedMemoryCoreRoot(repoRoot = chatRepoRoot(), environment = process.env) {
  return resolve(fixedMemoryCoreCacheRoot(repoRoot, environment), "MemoryCore");
}

function manifestEntries(root, current = root) {
  const entries = [];
  for (const name of readdirSync(current).sort()) {
    if (name === "node_modules" || name === EVIDENCE_FILE) continue;
    const absolute = join(current, name);
    const pathFromRoot = relative(root, absolute).split(sep).join("/");
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) entries.push(...manifestEntries(root, absolute));
    else if (stat.isSymbolicLink())
      entries.push([pathFromRoot, `symlink:${readlinkSync(absolute)}`]);
    else if (stat.isFile()) entries.push([pathFromRoot, readFileSync(absolute)]);
  }
  return entries;
}

export function fixedMemoryCoreSourceSha256(root) {
  const hash = createHash("sha256");
  for (const [path, value] of manifestEntries(root)) {
    hash.update(path);
    hash.update("\0");
    hash.update(value);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * 上游固定提交没有MemoryCore lockfile。Chat只补一份经过审核、Hash固定的npm v3 lock；
 * 不修改上游源码，也不允许lock跳到Git、HTTP、本地文件或未带integrity的依赖。
 */
export function assertFixedMemoryCoreLockArtifact(path = FIXED_MEMORYCORE_LOCK_PATH) {
  if (fileSha256(path) !== FIXED_MEMORYCORE_LOCK_SHA256) {
    throw new Error("Chat-owned MemoryCore lock artifact SHA-256不一致");
  }
  let lock;
  try {
    lock = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Chat-owned MemoryCore lock artifact不是合法JSON");
  }
  const root = lock?.packages?.[""];
  if (
    lock?.lockfileVersion !== 3 ||
    root?.name !== "@tencentdb-agent-memory/memory-tencentdb-v2" ||
    root?.version !== "2.0.0-beta.1"
  ) {
    throw new Error("Chat-owned MemoryCore lock artifact根合同不一致");
  }
  for (const [packagePath, entry] of Object.entries(lock.packages)) {
    if (packagePath === "") continue;
    if (entry?.link === true) throw new Error("MemoryCore lock artifact不得包含link依赖");
    if (typeof entry?.resolved !== "string" || typeof entry?.integrity !== "string") {
      throw new Error(`MemoryCore lock artifact依赖缺少resolved/integrity：${packagePath}`);
    }
    let resolved;
    try {
      resolved = new URL(entry.resolved);
    } catch {
      throw new Error(`MemoryCore lock artifact resolved无效：${packagePath}`);
    }
    if (
      resolved.protocol !== "https:" ||
      resolved.origin !== "https://registry.npmjs.org" ||
      resolved.username !== "" ||
      resolved.password !== "" ||
      !entry.integrity.startsWith("sha512-")
    ) {
      throw new Error(`MemoryCore lock artifact依赖来源不受信：${packagePath}`);
    }
  }
  return lock;
}

export function validateFixedMemoryCoreCache(repoRoot = chatRepoRoot(), environment = process.env) {
  const cache = fixedMemoryCoreCacheRoot(repoRoot, environment);
  try {
    const evidence = JSON.parse(readFileSync(resolve(cache, EVIDENCE_FILE), "utf8"));
    const installedLock = resolve(cache, "MemoryCore/node_modules/.package-lock.json");
    return (
      evidence.schemaVersion === EVIDENCE_SCHEMA &&
      evidence.commit === FIXED_MEMORYCORE_COMMIT &&
      evidence.tree === FIXED_MEMORYCORE_TREE &&
      evidence.source === FIXED_MEMORYCORE_SOURCE_URL &&
      evidence.lockArtifactSha256 === FIXED_MEMORYCORE_LOCK_SHA256 &&
      evidence.platform === process.platform &&
      evidence.arch === process.arch &&
      /^[0-9a-f]{64}$/u.test(evidence.sourceSha256) &&
      /^[0-9a-f]{64}$/u.test(evidence.installedLockSha256) &&
      fixedMemoryCoreSourceSha256(cache) === evidence.sourceSha256 &&
      fileSha256(resolve(cache, "MemoryCore/package-lock.json")) === FIXED_MEMORYCORE_LOCK_SHA256 &&
      fileSha256(installedLock) === evidence.installedLockSha256 &&
      existsSync(resolve(cache, "MemoryCore/src/gateway/server.ts")) &&
      existsSync(resolve(cache, "MemoryCore/node_modules/tsx/dist/cli.mjs"))
    );
  } catch {
    return false;
  }
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    stdio: options.input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 退出码 ${String(result.status)}`);
}

function archiveFixedSource(stage, repoRoot, environment, hostEnvironment = process.env) {
  return archiveFixedGitSource({
    target: stage,
    repoRoot,
    sourceName: "tencent-memorycore",
    sourceUrl: FIXED_MEMORYCORE_SOURCE_URL,
    localMirrorEnv: FIXED_MEMORYCORE_LOCAL_MIRROR_ENV,
    commit: FIXED_MEMORYCORE_COMMIT,
    tree: FIXED_MEMORYCORE_TREE,
    environment,
    hostEnvironment,
  });
}

/**
 * 固定提交没有MemoryCore lockfile；准备时安装Chat-owned、SHA固定且逐依赖带integrity
 * 的审核lock。安装在隔离archive内完成，绝不复用或链接个人仓库的node_modules。
 */
export function ensureFixedMemoryCore(repoRoot = chatRepoRoot(), hostEnvironment = process.env) {
  const cache = fixedMemoryCoreCacheRoot(repoRoot, hostEnvironment);
  if (validateFixedMemoryCoreCache(repoRoot, hostEnvironment)) {
    console.log(`[memorycore-source] 固定提交缓存就绪：${FIXED_MEMORYCORE_COMMIT.slice(0, 12)}`);
    return cache;
  }
  const parent = dirname(cache);
  mkdirSync(parent, { recursive: true });
  const lock = `${cache}.prepare-lock`;
  try {
    mkdirSync(lock);
  } catch {
    throw new Error("另一个固定 MemoryCore 准备进程正在运行");
  }
  const stage = mkdtempSync(resolve(parent, ".tmp-fixed-memorycore-"));
  const environmentRoot = mkdtempSync(resolve(parent, ".tmp-fixed-memorycore-env-"));
  const environment = createSafeChildProcessEnvironment(
    environmentRoot,
    { GIT_TERMINAL_PROMPT: "0" },
    hostEnvironment,
  );
  try {
    const source = archiveFixedSource(stage, repoRoot, environment, hostEnvironment);
    assertFixedMemoryCoreLockArtifact();
    const memoryCoreRoot = resolve(stage, "MemoryCore");
    copyFileSync(FIXED_MEMORYCORE_LOCK_PATH, resolve(memoryCoreRoot, "package-lock.json"));
    const sourceBefore = fixedMemoryCoreSourceSha256(stage);
    console.log("[memorycore-source] npm ci（Chat-owned固定lock，仅生产依赖）…");
    // 上游同时声明MongoDB optional peer(^5 gcp-metadata)与Google链(8.1.2)。审核lock
    // 使用legacy-peer-deps生成，ci必须使用同一flag；这只跳过可选peer注入，不改变
    // lock中每个已选包的HTTPS resolved与sha512 integrity。
    run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--legacy-peer-deps"], {
      cwd: memoryCoreRoot,
      env: environment,
    });
    const sourceAfter = fixedMemoryCoreSourceSha256(stage);
    if (sourceAfter !== sourceBefore) throw new Error("npm ci改写了固定MemoryCore源码或审核lock");
    const installedLock = resolve(memoryCoreRoot, "node_modules/.package-lock.json");
    if (!existsSync(resolve(memoryCoreRoot, "node_modules/tsx/dist/cli.mjs"))) {
      throw new Error("固定MemoryCore生产依赖缺少tsx运行入口");
    }
    writeFileSync(
      resolve(stage, EVIDENCE_FILE),
      `${JSON.stringify(
        {
          schemaVersion: EVIDENCE_SCHEMA,
          commit: FIXED_MEMORYCORE_COMMIT,
          tree: FIXED_MEMORYCORE_TREE,
          sourceSha256: sourceBefore,
          source: FIXED_MEMORYCORE_SOURCE_URL,
          sourceMode: source.mode,
          lockArtifactSha256: FIXED_MEMORYCORE_LOCK_SHA256,
          installedLockSha256: fileSha256(installedLock),
          dependencyRuntime: "chat-owned-lock-npm-ci-production",
          install: "npm ci --omit=dev --ignore-scripts --legacy-peer-deps",
          preparedAt: new Date().toISOString(),
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    if (existsSync(cache)) {
      renameSync(cache, `${cache}.stale-${Date.now()}`);
    }
    renameSync(stage, cache);
    console.log(`[memorycore-source] 固定提交准备完成：${FIXED_MEMORYCORE_COMMIT}`);
    return cache;
  } finally {
    rmSync(lock, { recursive: true, force: true });
    rmSync(environmentRoot, { recursive: true, force: true });
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  }
}

export function fixedMemoryCoreRunRoot(repoRoot = chatRepoRoot()) {
  return assertChatDataPath(
    resolve(repoRoot, ".data/tests/fixed-memorycore-http"),
    repoRoot,
    "fixed MemoryCore run root",
  );
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  try {
    ensureFixedMemoryCore(resolve(process.env.CHAT_REPO_ROOT ?? resolve(SCRIPT_DIR, "../..")));
  } catch (error) {
    console.error(`[memorycore-source] ${error instanceof Error ? error.message : "准备失败"}`);
    process.exitCode = 1;
  }
}
