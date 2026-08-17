import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * M1 真实 memmy 源码证据。
 *
 * 本地参考仓库有用户未提交修改，因此运行门只允许从固定 Git object
 * `git archive`，绝不复制工作树。缓存位于 Chat 的 `.data`，不会进入 Git。
 */
export const FIXED_MEMMY_COMMIT = "211d521b310fc23c63dd3d9ca848941173981c5e";
export const FIXED_MEMMY_TREE = "c4b1e78046f10011dc28b0408fb1bb3b61a5c3a1";
export const FIXED_MEMMY_PORT = 18_960;
export const FIXED_MEMMY_SOURCE_URL = "https://github.com/MemTensor/memmy-agent.git";
export const FIXED_MEMMY_LOCAL_MIRROR_ENV = "CHAT_MEMMY_SOURCE_REPO";
export const FIXED_MEMMY_NODE_ABI = "137";
export const FIXED_MEMMY_GLIBC_MINIMUM = "2.29";
export const FIXED_BETTER_SQLITE3_VERSION = "12.10.0";
export const FIXED_BETTER_SQLITE3_ASSETS = Object.freeze({
  "darwin-arm64": Object.freeze({
    size: 975_634,
    sha256: "b140983c8befcef30532ea615aa106c770f2f95cd20994d31ca593c0b4e85423",
    binarySha256: "cefecba1ccc5912528e86d15bbc1f9080ce2e81f10cd8ba2dd89296ee1e7444a",
  }),
  "darwin-x64": Object.freeze({
    size: 1_020_783,
    sha256: "a02f8e9c2024f2bd4386e58671524fcf722c5187b549f46a955d8e9c3b22f733",
    binarySha256: "263558fbe53d6e270bb1b28001a6eb758eafd1a7c2a6ab037b9fa1e3372acb68",
  }),
  "linux-arm64": Object.freeze({
    size: 1_064_573,
    sha256: "7648f3a8295cf03a036eb392b66fbef75347662d654f6ab558f5f33c9e47d69a",
    binarySha256: "a791a8c393fa04ffae35271031b12b6fd6b1d91c291f155d8f23f094a8b90293",
  }),
  "linux-x64": Object.freeze({
    size: 1_088_937,
    sha256: "c2f7503e6cc3a2b1dc9fd03e7194934438f42e0724ecac6696da0582585362f2",
    binarySha256: "4a6fdb191fdd1f9c0522e6932accc940f4e2a2f15a3b8c9008e57ad88d24872a",
  }),
});

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
export const FIXED_MEMMY_EVIDENCE_FILE = ".chat-fixed-source.json";
const EVIDENCE_SCHEMA = "chat-fixed-memmy-source.v2";
const SECRET_ENV_NAME =
  /(?:TOKEN|API_?KEY|SECRET|PASSWORD|CREDENTIAL|PROVIDER|(?:^|_)KEY(?:_|$)|AUTH)/u;
const SAFE_HOST_ENV_NAMES = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
];

export function chatRepoRoot() {
  return resolve(process.env.CHAT_REPO_ROOT ?? resolve(SCRIPTS_DIR, "../.."));
}

export function fixedMemmyCacheRoot(repoRoot = chatRepoRoot(), environment = process.env) {
  const cacheRoot = resolve(
    environment.CHAT_FIXED_SOURCE_CACHE_ROOT ?? resolve(repoRoot, ".data/cache"),
  );
  return resolve(cacheRoot, "memmy-agent", FIXED_MEMMY_COMMIT);
}

export function fixedMemmyServerEntry(repoRoot = chatRepoRoot(), environment = process.env) {
  return join(fixedMemmyCacheRoot(repoRoot, environment), "Memory/dist/src/server/index.js");
}

function assertInside(parent, candidate, label) {
  const parentPath = resolve(parent);
  const candidatePath = resolve(candidate);
  const pathFromParent = relative(parentPath, candidatePath);
  if (
    pathFromParent === "" ||
    pathFromParent === ".." ||
    pathFromParent.startsWith(`..${sep}`) ||
    isAbsolute(pathFromParent)
  ) {
    throw new Error(`${label}必须是 ${parentPath} 下的专用子目录`);
  }
  return candidatePath;
}

/** 运行数据只允许写入当前 Chat 仓库的 `.data` 子目录。 */
export function assertChatDataPath(candidate, repoRoot = chatRepoRoot(), label = "路径") {
  return assertInside(resolve(repoRoot, ".data"), candidate, label);
}

/**
 * 第三方安装、构建与服务只能收到明确允许的运行环境。
 *
 * HOME、临时目录与两级 npm 配置均物理隔离；既不读取用户 `.npmrc`，也不把
 * Provider/Runtime/Memory 凭据交给第三方代码。调用方只能追加非秘密配置。
 */
export function createSafeChildProcessEnvironment(
  isolationRoot,
  additions = {},
  hostEnvironment = process.env,
) {
  const root = resolve(isolationRoot);
  const home = resolve(root, "home");
  const temporary = resolve(root, "tmp");
  const npmCache = resolve(root, "npm-cache");
  const xdgConfig = resolve(root, "xdg-config");
  const xdgCache = resolve(root, "xdg-cache");
  for (const path of [root, home, temporary, npmCache, xdgConfig, xdgCache]) {
    mkdirSync(path, { recursive: true });
  }

  const npmUserConfig = resolve(root, "npm-userconfig");
  const npmGlobalConfig = resolve(root, "npm-globalconfig");
  writeFileSync(npmUserConfig, "", { encoding: "utf8", mode: 0o600 });
  writeFileSync(npmGlobalConfig, "", { encoding: "utf8", mode: 0o600 });

  const environment = {};
  for (const name of SAFE_HOST_ENV_NAMES) {
    const value = hostEnvironment[name];
    if (typeof value === "string" && value !== "") environment[name] = value;
  }
  Object.assign(environment, {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: xdgCache,
    NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_USERCONFIG: npmUserConfig,
    NPM_CONFIG_GLOBALCONFIG: npmGlobalConfig,
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_AUDIT: "false",
    CI: "1",
    ...additions,
  });

  for (const [name, value] of Object.entries(environment)) {
    if (SECRET_ENV_NAME.test(name.toUpperCase())) {
      throw new Error("第三方子进程环境包含禁止的秘密变量名");
    }
    if (typeof value !== "string") {
      throw new Error("第三方子进程环境值必须是字符串");
    }
  }
  return environment;
}

function updateDirectoryManifest(hash, root, current, excludedNames, readBuffer) {
  for (const name of readdirSync(current).sort()) {
    const absolute = join(current, name);
    const pathFromRoot = relative(root, absolute).split(sep).join("/");
    const segments = pathFromRoot.split("/");
    if (segments.some((segment) => excludedNames.has(segment))) {
      continue;
    }
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      updateDirectoryManifest(hash, root, absolute, excludedNames, readBuffer);
      continue;
    }
    hash.update(pathFromRoot);
    hash.update("\0");
    if (stat.isSymbolicLink()) {
      hash.update(`symlink:${readlinkSync(absolute)}`);
    } else if (stat.isFile()) {
      const descriptor = openSync(absolute, "r");
      try {
        for (;;) {
          const bytesRead = readSync(descriptor, readBuffer, 0, readBuffer.byteLength, null);
          if (bytesRead === 0) break;
          hash.update(readBuffer.subarray(0, bytesRead));
        }
      } finally {
        closeSync(descriptor);
      }
    }
    hash.update("\0");
  }
}

function directoryManifestSha256(root, excludedNames = new Set()) {
  const hash = createHash("sha256");
  updateDirectoryManifest(hash, root, root, excludedNames, Buffer.allocUnsafe(64 * 1024));
  return hash.digest("hex");
}

/** Hash 路径与文件字节，证明 npm/build 之外的 archive 源码没有漂移。 */
export function sourceManifestSha256(root) {
  return directoryManifestSha256(
    root,
    new Set(["node_modules", "dist", FIXED_MEMMY_EVIDENCE_FILE]),
  );
}

/** 真实运行的是编译产物，因此完整 Memory/dist 也必须进入固定证据。 */
export function runtimeArtifactSha256(root) {
  return directoryManifestSha256(join(root, "Memory/dist"));
}

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function fixedBetterSqlite3Asset(
  platform = process.platform,
  arch = process.arch,
  nodeAbi = process.versions.modules,
  libc = detectRuntimeLibc(platform),
) {
  if (nodeAbi !== FIXED_MEMMY_NODE_ABI) {
    throw new Error(
      `固定memmy原生工件只支持Node ABI ${FIXED_MEMMY_NODE_ABI}（Node 24），实际为${String(nodeAbi)}`,
    );
  }
  assertSupportedRuntimeLibc(platform, libc);
  const key = `${platform}-${arch}`;
  const evidence = FIXED_BETTER_SQLITE3_ASSETS[key];
  if (evidence === undefined) {
    throw new Error(`固定memmy原生工件不支持${key}`);
  }
  const name = `better-sqlite3-v${FIXED_BETTER_SQLITE3_VERSION}-node-v${FIXED_MEMMY_NODE_ABI}-${key}.tar.gz`;
  return Object.freeze({
    ...evidence,
    key,
    libc,
    name,
    url: `https://github.com/WiseLibs/better-sqlite3/releases/download/v${FIXED_BETTER_SQLITE3_VERSION}/${name}`,
  });
}

export function detectRuntimeLibc(platform = process.platform) {
  if (platform !== "linux") return "n/a";
  const report = process.report?.getReport?.();
  const version = report?.header?.glibcVersionRuntime;
  return typeof version === "string" && version !== "" ? `glibc-${version}` : "musl-or-unknown";
}

export function assertSupportedRuntimeLibc(platform, libc) {
  if (platform !== "linux") return;
  const match = /^glibc-(\d+)\.(\d+)(?:\.|$)/u.exec(String(libc));
  const [minimumMajor, minimumMinor] = FIXED_MEMMY_GLIBC_MINIMUM.split(".").map(Number);
  const major = Number(match?.[1] ?? -1);
  const minor = Number(match?.[2] ?? -1);
  if (major < minimumMajor || (major === minimumMajor && minor < minimumMinor)) {
    throw new Error(
      `固定memmy原生工件要求glibc>=${FIXED_MEMMY_GLIBC_MINIMUM}，实际为${String(libc)}`,
    );
  }
}

function assertLockedNpmPackage(lock, packagePath, version) {
  const entry = lock?.packages?.[packagePath];
  let resolved;
  try {
    resolved = new URL(entry?.resolved);
  } catch {
    throw new Error(`memmy固定lock缺少${packagePath}`);
  }
  if (
    entry?.version !== version ||
    resolved.protocol !== "https:" ||
    resolved.origin !== "https://registry.npmjs.org" ||
    typeof entry?.integrity !== "string" ||
    !entry.integrity.startsWith("sha512-")
  ) {
    throw new Error(`memmy固定lock中的${packagePath}来源或版本漂移`);
  }
}

export function assertFixedMemmyRuntimeLock(
  root,
  platform = process.platform,
  arch = process.arch,
) {
  let lock;
  try {
    lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  } catch {
    throw new Error("memmy固定lock无效");
  }
  assertLockedNpmPackage(lock, "node_modules/better-sqlite3", FIXED_BETTER_SQLITE3_VERSION);
  assertLockedNpmPackage(lock, "node_modules/onnxruntime-node", "1.21.0");
  assertLockedNpmPackage(lock, "node_modules/sqlite-vec", "0.1.9");
  assertLockedNpmPackage(lock, `node_modules/sqlite-vec-${platform}-${arch}`, "0.1.9");
  return lock;
}

/**
 * npm lock/integrity拥有下载时的包内容；缓存落盘后则对完整node_modules做清单Hash，
 * 任何生产/传递依赖漂移都不能被遗漏。better-sqlite3二进制还必须命中仓库固定SHA。
 */
export function runtimeDependencyArtifactSha256(
  root,
  platform = process.platform,
  arch = process.arch,
  nodeAbi = process.versions.modules,
) {
  const asset = fixedBetterSqlite3Asset(platform, arch, nodeAbi);
  const betterSqliteRoot = join(root, "node_modules/better-sqlite3");
  const binaryPath = join(betterSqliteRoot, "build/Release/better_sqlite3.node");
  if (fileSha256(binaryPath) !== asset.binarySha256) {
    throw new Error("better-sqlite3固定原生二进制SHA-256不一致");
  }
  return directoryManifestSha256(join(root, "node_modules"));
}

function readEvidence(cacheRoot) {
  try {
    const evidence = JSON.parse(readFileSync(join(cacheRoot, FIXED_MEMMY_EVIDENCE_FILE), "utf8"));
    const asset = fixedBetterSqlite3Asset();
    if (
      evidence?.schemaVersion !== EVIDENCE_SCHEMA ||
      evidence?.commit !== FIXED_MEMMY_COMMIT ||
      evidence?.tree !== FIXED_MEMMY_TREE ||
      evidence?.platform !== process.platform ||
      evidence?.arch !== process.arch ||
      evidence?.libc !== detectRuntimeLibc() ||
      evidence?.nodeAbi !== FIXED_MEMMY_NODE_ABI ||
      evidence?.betterSqlite3AssetSha256 !== asset.sha256 ||
      !/^[0-9a-f]{64}$/u.test(evidence?.sourceManifestSha256 ?? "") ||
      !/^[0-9a-f]{64}$/u.test(evidence?.runtimeArtifactSha256 ?? "") ||
      !/^[0-9a-f]{64}$/u.test(evidence?.runtimeDependencyArtifactSha256 ?? "")
    ) {
      return undefined;
    }
    return evidence;
  } catch {
    return undefined;
  }
}

export function validateFixedMemmyCache(repoRoot = chatRepoRoot(), environment = process.env) {
  const cacheRoot = fixedMemmyCacheRoot(repoRoot, environment);
  const evidence = readEvidence(cacheRoot);
  if (evidence === undefined || !existsSync(fixedMemmyServerEntry(repoRoot, environment))) {
    return false;
  }
  try {
    return (
      sourceManifestSha256(cacheRoot) === evidence.sourceManifestSha256 &&
      runtimeArtifactSha256(cacheRoot) === evidence.runtimeArtifactSha256 &&
      runtimeDependencyArtifactSha256(cacheRoot) === evidence.runtimeDependencyArtifactSha256
    );
  } catch {
    return false;
  }
}

function run(command, args, options = {}) {
  if (options.env === undefined) {
    throw new Error("第三方子进程必须显式传入安全环境");
  }
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    stdio: options.input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} 退出码 ${String(result.status)}`);
  }
}

export async function installFixedBetterSqlite3Prebuild(
  root,
  environment,
  {
    fetchImpl = fetch,
    platform = process.platform,
    arch = process.arch,
    nodeAbi = process.versions.modules,
  } = {},
) {
  const asset = fixedBetterSqlite3Asset(platform, arch, nodeAbi);
  const packageRoot = join(root, "node_modules/better-sqlite3");
  if (!existsSync(join(packageRoot, "package.json"))) {
    throw new Error("npm ci未安装固定better-sqlite3包");
  }
  const archivePath = join(environment.TMPDIR, asset.name);
  try {
    const response = await fetchImpl(asset.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      throw new Error(`better-sqlite3固定工件下载失败：HTTP ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength !== asset.size) {
      throw new Error(`better-sqlite3固定工件大小漂移：${bytes.byteLength}，期望${asset.size}`);
    }
    if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
      throw new Error("better-sqlite3固定工件SHA-256不一致");
    }
    writeFileSync(archivePath, bytes, { mode: 0o600 });
    const listing = execFileSync("tar", ["-tzf", archivePath], {
      encoding: "utf8",
      env: environment,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean);
    if (listing.length !== 1 || listing[0] !== "build/Release/better_sqlite3.node") {
      throw new Error("better-sqlite3固定工件归档边界漂移");
    }
    rmSync(join(packageRoot, "build"), { recursive: true, force: true });
    run("tar", ["-xzf", archivePath, "-C", packageRoot, "build/Release/better_sqlite3.node"], {
      env: environment,
    });
    const binaryPath = join(packageRoot, "build/Release/better_sqlite3.node");
    if (fileSha256(binaryPath) !== asset.binarySha256) {
      throw new Error("better-sqlite3解压后的原生二进制SHA-256不一致");
    }
    return asset;
  } finally {
    rmSync(archivePath, { force: true });
  }
}

function fixedSourceMirrorPath(repoRoot, sourceName, hostEnvironment = process.env) {
  const cacheRoot = resolve(
    hostEnvironment.CHAT_FIXED_SOURCE_CACHE_ROOT ?? resolve(repoRoot, ".data/cache"),
  );
  return resolve(cacheRoot, "fixed-source-mirrors", `${sourceName}.git`);
}

function fixedGitObject(repository, commit, tree, environment) {
  const actualCommit = execFileSync("git", ["-C", repository, "rev-parse", `${commit}^{commit}`], {
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const actualTree = execFileSync(
    "git",
    ["-C", repository, "rev-parse", `${actualCommit}^{tree}`],
    { encoding: "utf8", env: environment, stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
  if (actualCommit !== commit || actualTree !== tree) {
    throw new Error("固定Git object与仓库证据不一致");
  }
  return Object.freeze({ commit: actualCommit, tree: actualTree });
}

function validFixedGitObject(repository, commit, tree, environment) {
  try {
    fixedGitObject(repository, commit, tree, environment);
    return true;
  } catch {
    return false;
  }
}

/**
 * 默认从受审HTTPS地址取得精确Git object；本地mirror只能通过显式环境变量提供。
 * 无论来源为何，后续只对固定commit做archive，并再次核对commit/tree。
 */
export function resolveFixedGitSource({
  repoRoot,
  sourceName,
  sourceUrl,
  localMirrorEnv,
  commit,
  tree,
  environment,
  hostEnvironment = process.env,
}) {
  const localMirror = hostEnvironment[localMirrorEnv]?.trim();
  if (localMirror) {
    const repository = resolve(localMirror);
    if (!existsSync(repository)) {
      throw new Error(`${localMirrorEnv}指定的固定源码mirror不存在`);
    }
    fixedGitObject(repository, commit, tree, environment);
    return Object.freeze({ repository, mode: "explicit-local-mirror", sourceUrl });
  }

  const repository = fixedSourceMirrorPath(repoRoot, sourceName, hostEnvironment);
  if (validFixedGitObject(repository, commit, tree, environment)) {
    return Object.freeze({ repository, mode: "managed-https-cache", sourceUrl });
  }

  const parent = dirname(repository);
  mkdirSync(parent, { recursive: true });
  const stage = mkdtempSync(join(parent, `.tmp-${sourceName}-git-`));
  const stagedRepository = join(stage, "repository.git");
  try {
    run("git", ["init", "--bare", "--quiet", stagedRepository], { env: environment });
    run(
      "git",
      [
        "-c",
        "credential.helper=",
        "-C",
        stagedRepository,
        "fetch",
        "--no-tags",
        "--depth=1",
        sourceUrl,
        commit,
      ],
      { env: environment },
    );
    fixedGitObject(stagedRepository, commit, tree, environment);
    if (existsSync(repository)) {
      renameSync(repository, `${repository}.invalid-${Date.now()}`);
    }
    renameSync(stagedRepository, repository);
    return Object.freeze({ repository, mode: "managed-https-fetch", sourceUrl });
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  }
}

export function archiveFixedGitSource({
  target,
  repoRoot,
  sourceName,
  sourceUrl,
  localMirrorEnv,
  commit,
  tree,
  environment,
  hostEnvironment = process.env,
}) {
  const source = resolveFixedGitSource({
    repoRoot,
    sourceName,
    sourceUrl,
    localMirrorEnv,
    commit,
    tree,
    environment,
    hostEnvironment,
  });
  fixedGitObject(source.repository, commit, tree, environment);
  const archive = execFileSync(
    "git",
    ["-C", source.repository, "archive", "--format=tar", commit],
    { maxBuffer: 1024 * 1024 * 1024, env: environment },
  );
  run("tar", ["-xf", "-", "-C", target], { input: archive, env: environment });
  return source;
}

function archiveFixedSource(target, repoRoot, environment, hostEnvironment = process.env) {
  return archiveFixedGitSource({
    target,
    repoRoot,
    sourceName: "memmy-agent",
    sourceUrl: FIXED_MEMMY_SOURCE_URL,
    localMirrorEnv: FIXED_MEMMY_LOCAL_MIRROR_ENV,
    commit: FIXED_MEMMY_COMMIT,
    tree: FIXED_MEMMY_TREE,
    environment,
    hostEnvironment,
  });
}

/**
 * 只安装、编译固定提交中的 Memory workspace。首次准备后复用精确缓存；
 * 源清单或证据异常时保留旧缓存并重建，不在参考仓库工作树中运行命令。
 */
export async function ensureFixedMemmy(repoRoot = chatRepoRoot(), hostEnvironment = process.env) {
  // 即使绕过统一setup单独准备Memory，也必须在创建缓存或运行npm前锁住原生ABI/Libc边界。
  fixedBetterSqlite3Asset();
  const cacheRoot = fixedMemmyCacheRoot(repoRoot, hostEnvironment);
  if (validateFixedMemmyCache(repoRoot, hostEnvironment)) {
    console.log(`[memmy-source] 固定提交缓存就绪：${FIXED_MEMMY_COMMIT.slice(0, 12)}`);
    return cacheRoot;
  }

  const cacheParent = dirname(cacheRoot);
  mkdirSync(cacheParent, { recursive: true });
  const lockPath = `${cacheRoot}.prepare-lock`;
  try {
    mkdirSync(lockPath);
  } catch {
    throw new Error("另一个固定 memmy 准备进程正在运行；拒绝并发覆盖缓存");
  }

  const stage = mkdtempSync(join(cacheParent, ".tmp-fixed-memmy-"));
  const environmentRoot = mkdtempSync(join(cacheParent, ".tmp-fixed-memmy-env-"));
  const childEnvironment = createSafeChildProcessEnvironment(
    environmentRoot,
    {
      GIT_TERMINAL_PROMPT: "0",
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
      ONNXRUNTIME_NODE_INSTALL_CUDA: "skip",
    },
    hostEnvironment,
  );
  try {
    const source = archiveFixedSource(stage, repoRoot, childEnvironment, hostEnvironment);
    assertFixedMemmyRuntimeLock(stage);
    const beforeBuild = sourceManifestSha256(stage);
    console.log("[memmy-source] npm ci（禁用第三方生命周期，仅 @memmy/memory workspace）…");
    run(
      "npm",
      ["ci", "--ignore-scripts", "--workspace", "@memmy/memory", "--include-workspace-root=false"],
      {
        cwd: stage,
        env: childEnvironment,
      },
    );
    console.log("[memmy-source] 安装固定better-sqlite3原生工件…");
    const betterSqlite3Asset = await installFixedBetterSqlite3Prebuild(stage, childEnvironment);
    const onnxBinding = join(
      stage,
      `node_modules/onnxruntime-node/bin/napi-v3/${process.platform}/${process.arch}/onnxruntime_binding.node`,
    );
    if (!existsSync(onnxBinding)) {
      throw new Error("固定onnxruntime-node包缺少当前平台CPU binding");
    }
    run(
      process.execPath,
      [
        "-e",
        "const ort=require('onnxruntime-node');if(!ort.InferenceSession)throw new Error('onnxruntime unavailable');const Database=require('better-sqlite3');const db=new Database(':memory:');db.exec('select 1');db.close();",
      ],
      { cwd: stage, env: childEnvironment },
    );
    console.log("[memmy-source] 编译固定提交的 Memory workspace…");
    run("npm", ["run", "build", "--workspace", "@memmy/memory"], {
      cwd: stage,
      env: childEnvironment,
    });
    const afterBuild = sourceManifestSha256(stage);
    if (beforeBuild !== afterBuild) {
      throw new Error("npm/build 改写了固定 archive 源码，拒绝把漂移结果作为证据");
    }
    if (!existsSync(join(stage, "Memory/dist/src/server/index.js"))) {
      throw new Error("固定 memmy Memory 构建缺少服务入口");
    }
    writeFileSync(
      join(stage, FIXED_MEMMY_EVIDENCE_FILE),
      `${JSON.stringify(
        {
          schemaVersion: EVIDENCE_SCHEMA,
          commit: FIXED_MEMMY_COMMIT,
          tree: FIXED_MEMMY_TREE,
          platform: process.platform,
          arch: process.arch,
          libc: detectRuntimeLibc(),
          nodeAbi: FIXED_MEMMY_NODE_ABI,
          betterSqlite3AssetSha256: betterSqlite3Asset.sha256,
          sourceManifestSha256: afterBuild,
          runtimeArtifactSha256: runtimeArtifactSha256(stage),
          runtimeDependencyArtifactSha256: runtimeDependencyArtifactSha256(stage),
          source: FIXED_MEMMY_SOURCE_URL,
          sourceMode: source.mode,
          install:
            "npm ci --ignore-scripts --workspace @memmy/memory --include-workspace-root=false",
          build: "npm run build --workspace @memmy/memory",
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
    if (!validateFixedMemmyCache(repoRoot, hostEnvironment)) {
      throw new Error("固定 memmy 缓存写入后校验失败");
    }
    console.log(`[memmy-source] 固定提交已准备：${FIXED_MEMMY_COMMIT.slice(0, 12)}`);
    return cacheRoot;
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
    if (existsSync(environmentRoot)) rmSync(environmentRoot, { recursive: true, force: true });
    if (existsSync(lockPath)) rmSync(lockPath, { recursive: true, force: true });
  }
}
