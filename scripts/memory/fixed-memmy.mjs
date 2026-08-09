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
export const FIXED_MEMMY_SOURCE_REPO = "/Users/xulater/Code/opc-os/memmy-agent";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
export const FIXED_MEMMY_EVIDENCE_FILE = ".chat-fixed-source.json";
const EVIDENCE_SCHEMA = "chat-fixed-memmy-source.v1";
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

export function fixedMemmyCacheRoot(repoRoot = chatRepoRoot()) {
  const cacheRoot = resolve(
    process.env.CHAT_FIXED_SOURCE_CACHE_ROOT ?? resolve(repoRoot, ".data/cache"),
  );
  return resolve(cacheRoot, "memmy-agent", FIXED_MEMMY_COMMIT);
}

export function fixedMemmyServerEntry(repoRoot = chatRepoRoot()) {
  return join(fixedMemmyCacheRoot(repoRoot), "Memory/dist/src/server/index.js");
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

function manifestEntries(root, current = root, excludedNames = new Set()) {
  const entries = [];
  for (const name of readdirSync(current).sort()) {
    const absolute = join(current, name);
    const pathFromRoot = relative(root, absolute).split(sep).join("/");
    const segments = pathFromRoot.split("/");
    if (segments.some((segment) => excludedNames.has(segment))) {
      continue;
    }
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      entries.push(...manifestEntries(root, absolute, excludedNames));
    } else if (stat.isSymbolicLink()) {
      entries.push([pathFromRoot, `symlink:${readlinkSync(absolute)}`]);
    } else if (stat.isFile()) {
      entries.push([pathFromRoot, readFileSync(absolute)]);
    }
  }
  return entries;
}

function directoryManifestSha256(root, excludedNames = new Set()) {
  const hash = createHash("sha256");
  for (const [path, value] of manifestEntries(root, root, excludedNames)) {
    hash.update(path);
    hash.update("\0");
    hash.update(value);
    hash.update("\0");
  }
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

function readEvidence(cacheRoot) {
  try {
    const evidence = JSON.parse(readFileSync(join(cacheRoot, FIXED_MEMMY_EVIDENCE_FILE), "utf8"));
    if (
      evidence?.schemaVersion !== EVIDENCE_SCHEMA ||
      evidence?.commit !== FIXED_MEMMY_COMMIT ||
      evidence?.tree !== FIXED_MEMMY_TREE ||
      !/^[0-9a-f]{64}$/u.test(evidence?.sourceManifestSha256 ?? "") ||
      !/^[0-9a-f]{64}$/u.test(evidence?.runtimeArtifactSha256 ?? "")
    ) {
      return undefined;
    }
    return evidence;
  } catch {
    return undefined;
  }
}

export function validateFixedMemmyCache(repoRoot = chatRepoRoot()) {
  const cacheRoot = fixedMemmyCacheRoot(repoRoot);
  const evidence = readEvidence(cacheRoot);
  if (evidence === undefined || !existsSync(fixedMemmyServerEntry(repoRoot))) return false;
  try {
    return (
      sourceManifestSha256(cacheRoot) === evidence.sourceManifestSha256 &&
      runtimeArtifactSha256(cacheRoot) === evidence.runtimeArtifactSha256
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

function archiveFixedSource(target, environment) {
  if (!existsSync(FIXED_MEMMY_SOURCE_REPO)) {
    throw new Error(`固定 memmy 源仓库不存在：${FIXED_MEMMY_SOURCE_REPO}`);
  }
  const commit = execFileSync(
    "git",
    ["-C", FIXED_MEMMY_SOURCE_REPO, "rev-parse", `${FIXED_MEMMY_COMMIT}^{commit}`],
    { encoding: "utf8", env: environment },
  ).trim();
  const tree = execFileSync(
    "git",
    ["-C", FIXED_MEMMY_SOURCE_REPO, "rev-parse", `${FIXED_MEMMY_COMMIT}^{tree}`],
    { encoding: "utf8", env: environment },
  ).trim();
  if (commit !== FIXED_MEMMY_COMMIT || tree !== FIXED_MEMMY_TREE) {
    throw new Error("固定 memmy Git object 与任务书证据不一致");
  }
  const archive = execFileSync(
    "git",
    ["-C", FIXED_MEMMY_SOURCE_REPO, "archive", "--format=tar", FIXED_MEMMY_COMMIT],
    { maxBuffer: 1024 * 1024 * 1024, env: environment },
  );
  run("tar", ["-xf", "-", "-C", target], { input: archive, env: environment });
}

/**
 * 只安装、编译固定提交中的 Memory workspace。首次准备后复用精确缓存；
 * 源清单或证据异常时保留旧缓存并重建，不在参考仓库工作树中运行命令。
 */
export function ensureFixedMemmy(repoRoot = chatRepoRoot()) {
  const cacheRoot = fixedMemmyCacheRoot(repoRoot);
  if (validateFixedMemmyCache(repoRoot)) {
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
  const childEnvironment = createSafeChildProcessEnvironment(environmentRoot);
  try {
    archiveFixedSource(stage, childEnvironment);
    const beforeBuild = sourceManifestSha256(stage);
    console.log("[memmy-source] npm ci（仅 @memmy/memory workspace）…");
    run("npm", ["ci", "--workspace", "@memmy/memory", "--include-workspace-root=false"], {
      cwd: stage,
      env: childEnvironment,
    });
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
          sourceManifestSha256: afterBuild,
          runtimeArtifactSha256: runtimeArtifactSha256(stage),
          install: "npm ci --workspace @memmy/memory --include-workspace-root=false",
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
    if (!validateFixedMemmyCache(repoRoot)) {
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
