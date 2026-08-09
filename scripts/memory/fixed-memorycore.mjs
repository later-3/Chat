import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertChatDataPath,
  chatRepoRoot,
  createSafeChildProcessEnvironment,
} from "./fixed-memmy.mjs";

export const FIXED_MEMORYCORE_COMMIT = "3a9748d3c61c2a2feb38237c9b28992250c1804e";
export const FIXED_MEMORYCORE_TREE = "3b41130cd6f716112c1e357d86d4dc6f494cb52f";
export const FIXED_MEMORYCORE_PORT = 18_970;
export const FIXED_MEMORYCORE_SOURCE_REPO = "/Users/xulater/Code/opc-os/tencentdb-agent-memory";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_FILE = ".chat-fixed-memorycore-source.json";
const EVIDENCE_SCHEMA = "chat-fixed-memorycore-source.v1";

export function fixedMemoryCoreCacheRoot(repoRoot = chatRepoRoot()) {
  const cacheRoot = resolve(
    process.env.CHAT_FIXED_SOURCE_CACHE_ROOT ?? resolve(repoRoot, ".data/cache"),
  );
  return resolve(cacheRoot, "tencent-memorycore", FIXED_MEMORYCORE_COMMIT);
}

export function fixedMemoryCoreRoot(repoRoot = chatRepoRoot()) {
  return resolve(fixedMemoryCoreCacheRoot(repoRoot), "MemoryCore");
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

export function validateFixedMemoryCoreCache(repoRoot = chatRepoRoot()) {
  const cache = fixedMemoryCoreCacheRoot(repoRoot);
  try {
    const evidence = JSON.parse(readFileSync(resolve(cache, EVIDENCE_FILE), "utf8"));
    return (
      evidence.schemaVersion === EVIDENCE_SCHEMA &&
      evidence.commit === FIXED_MEMORYCORE_COMMIT &&
      evidence.tree === FIXED_MEMORYCORE_TREE &&
      /^[0-9a-f]{64}$/u.test(evidence.sourceSha256) &&
      fixedMemoryCoreSourceSha256(cache) === evidence.sourceSha256 &&
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

function archiveFixedSource(stage, environment) {
  if (!existsSync(FIXED_MEMORYCORE_SOURCE_REPO)) {
    throw new Error(`固定 MemoryCore 源仓库不存在：${FIXED_MEMORYCORE_SOURCE_REPO}`);
  }
  const commit = execFileSync(
    "git",
    ["-C", FIXED_MEMORYCORE_SOURCE_REPO, "rev-parse", `${FIXED_MEMORYCORE_COMMIT}^{commit}`],
    { encoding: "utf8", env: environment },
  ).trim();
  const tree = execFileSync(
    "git",
    ["-C", FIXED_MEMORYCORE_SOURCE_REPO, "rev-parse", `${FIXED_MEMORYCORE_COMMIT}^{tree}`],
    { encoding: "utf8", env: environment },
  ).trim();
  if (commit !== FIXED_MEMORYCORE_COMMIT || tree !== FIXED_MEMORYCORE_TREE) {
    throw new Error("固定 MemoryCore Git object 与任务书证据不一致");
  }
  const archive = execFileSync(
    "git",
    ["-C", FIXED_MEMORYCORE_SOURCE_REPO, "archive", "--format=tar", FIXED_MEMORYCORE_COMMIT],
    { maxBuffer: 1024 * 1024 * 1024, env: environment },
  );
  run("tar", ["-xf", "-", "-C", stage], { input: archive, env: environment });
}

/**
 * 固定提交没有MemoryCore lockfile，所以不伪造可重复依赖结论：源码Git对象固定；
 * 运行依赖复用同一固定、干净本地仓库的现成node_modules，并在准备时核验HEAD。
 */
export function ensureFixedMemoryCore(repoRoot = chatRepoRoot()) {
  const cache = fixedMemoryCoreCacheRoot(repoRoot);
  if (validateFixedMemoryCoreCache(repoRoot)) {
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
  const environment = createSafeChildProcessEnvironment(environmentRoot);
  try {
    archiveFixedSource(stage, environment);
    const sourceBefore = fixedMemoryCoreSourceSha256(stage);
    const referenceHead = execFileSync(
      "git",
      ["-C", FIXED_MEMORYCORE_SOURCE_REPO, "rev-parse", "HEAD"],
      { encoding: "utf8", env: environment },
    ).trim();
    const trackedChanges = execFileSync(
      "git",
      ["-C", FIXED_MEMORYCORE_SOURCE_REPO, "status", "--porcelain", "--untracked-files=no"],
      { encoding: "utf8", env: environment },
    ).trim();
    const dependencyRoot = resolve(FIXED_MEMORYCORE_SOURCE_REPO, "MemoryCore/node_modules");
    if (
      referenceHead !== FIXED_MEMORYCORE_COMMIT ||
      trackedChanges !== "" ||
      !existsSync(resolve(dependencyRoot, "tsx/dist/cli.mjs"))
    ) {
      throw new Error("固定MemoryCore本地依赖运行时缺失，或参考仓库跟踪文件不干净");
    }
    symlinkSync(dependencyRoot, resolve(stage, "MemoryCore/node_modules"), "dir");
    const sourceAfter = fixedMemoryCoreSourceSha256(stage);
    if (sourceAfter !== sourceBefore) throw new Error("依赖安装改写了固定MemoryCore源码");
    writeFileSync(
      resolve(stage, EVIDENCE_FILE),
      `${JSON.stringify(
        {
          schemaVersion: EVIDENCE_SCHEMA,
          commit: FIXED_MEMORYCORE_COMMIT,
          tree: FIXED_MEMORYCORE_TREE,
          sourceSha256: sourceBefore,
          dependencyRuntime: "verified-local-fixed-repository",
          preparedAt: new Date().toISOString(),
          nodeVersion: process.version,
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
