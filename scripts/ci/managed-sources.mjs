import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createCiSafeEnvironment } from "./safe-environment.mjs";

const CHAT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_MANIFEST_PATH = join(CHAT_ROOT, "config/managed-sources.json");
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function fail(message) {
  throw new Error(`Managed Sources Manifest无效：${message}`);
}

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(`${label}必须是对象`);
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label}必须是非空字符串`);
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) fail(`${label}必须是非空数组`);
  value.forEach((entry, index) => assertString(entry, `${label}[${String(index)}]`));
}

function assertCommand(value, label) {
  assertStringArray(value, label);
}

function assertMarker(value, label) {
  assertObject(value, label);
  assertString(value.path, `${label}.path`);
  assertStringArray(value.contains, `${label}.contains`);
}

function assertRelativePath(value, label) {
  assertString(value, label);
  if (isAbsolute(value) || value.split(/[\\/]/u).includes("..")) {
    fail(`${label}必须是无上级跳转的相对路径`);
  }
}

function validateSource(source, index) {
  const label = `sources[${String(index)}]`;
  assertObject(source, label);
  for (const field of [
    "id",
    "repository",
    "branch",
    "commit",
    "checkoutPath",
    "packageManager",
    "lockfile",
  ]) {
    assertString(source[field], `${label}.${field}`);
  }
  if (!SHA_PATTERN.test(source.commit)) fail(`${label}.commit必须是完整小写Git SHA`);
  assertRelativePath(source.checkoutPath, `${label}.checkoutPath`);
  assertRelativePath(source.lockfile, `${label}.lockfile`);
  if (!Array.isArray(source.buildCommands) || source.buildCommands.length === 0) {
    fail(`${label}.buildCommands必须是非空数组`);
  }
  assertCommand(source.installCommand, `${label}.installCommand`);
  source.buildCommands.forEach((command, commandIndex) =>
    assertCommand(command, `${label}.buildCommands[${String(commandIndex)}]`),
  );
  if (!Array.isArray(source.buildInputs)) fail(`${label}.buildInputs必须是数组`);
  source.buildInputs.forEach((input, inputIndex) => {
    const inputLabel = `${label}.buildInputs[${String(inputIndex)}]`;
    assertObject(input, inputLabel);
    for (const field of [
      "id",
      "url",
      "sha256",
      "archivePath",
      "targetPath",
      "markerPath",
      "markerSha256",
    ]) {
      assertString(input[field], `${inputLabel}.${field}`);
    }
    if (!Number.isSafeInteger(input.size) || input.size <= 0) {
      fail(`${inputLabel}.size必须是正整数`);
    }
    if (!SHA256_PATTERN.test(input.sha256) || !SHA256_PATTERN.test(input.markerSha256)) {
      fail(`${inputLabel}的SHA-256必须是完整小写摘要`);
    }
    let url;
    try {
      url = new URL(input.url);
    } catch {
      fail(`${inputLabel}.url不是合法URL`);
    }
    if (url.protocol !== "https:" || url.hostname !== "github.com") {
      fail(`${inputLabel}.url必须是GitHub HTTPS发布工件`);
    }
    for (const field of ["archivePath", "targetPath", "markerPath"]) {
      assertRelativePath(input[field], `${inputLabel}.${field}`);
    }
  });
  assertStringArray(source.licenseFiles, `${label}.licenseFiles`);
  for (const collection of ["sourceMarkers", "runtimeMarkers"]) {
    if (!Array.isArray(source[collection]) || source[collection].length === 0) {
      fail(`${label}.${collection}必须是非空数组`);
    }
    source[collection].forEach((marker, markerIndex) =>
      assertMarker(marker, `${label}.${collection}[${String(markerIndex)}]`),
    );
  }
  if (!Array.isArray(source.linkedPackages) || source.linkedPackages.length === 0) {
    fail(`${label}.linkedPackages必须是非空数组`);
  }
  source.linkedPackages.forEach((link, linkIndex) => {
    const linkLabel = `${label}.linkedPackages[${String(linkIndex)}]`;
    assertObject(link, linkLabel);
    assertRelativePath(link.consumer, `${linkLabel}.consumer`);
    assertString(link.dependency, `${linkLabel}.dependency`);
    assertRelativePath(link.sourcePath, `${linkLabel}.sourcePath`);
  });
}

export function loadManagedSourcesManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assertObject(manifest, "root");
  if (manifest.schemaVersion !== 1) fail("schemaVersion必须为1");
  assertObject(manifest.toolchain, "toolchain");
  assertString(manifest.toolchain.node, "toolchain.node");
  assertString(manifest.toolchain.chatPackageManager, "toolchain.chatPackageManager");
  if (!Array.isArray(manifest.sources) || manifest.sources.length !== 2) {
    fail("sources必须且只能包含Pi和DSH两个受管源码");
  }
  manifest.sources.forEach(validateSource);
  const ids = manifest.sources.map((source) => source.id).sort();
  if (ids.join(",") !== "dsh,pi") fail("sources.id必须是dsh和pi");
  return Object.freeze(manifest);
}

export function canonicalGitHubOrigin(value) {
  assertString(value, "repository");
  const ssh = /^git@github\.com:([^/]+\/.+?)(?:\.git)?$/iu.exec(value);
  const candidate = ssh === null ? value : `https://github.com/${ssh[1]}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    fail(`repository不是GitHub URL：${value}`);
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    fail(`repository必须使用GitHub HTTPS或SSH：${value}`);
  }
  const repositoryPath = url.pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/iu, "");
  if (repositoryPath.split("/").length !== 2) fail(`repository路径必须是owner/repo：${value}`);
  return `https://github.com/${repositoryPath}.git`;
}

export function resolveManagedCheckout(chatRoot, checkoutPath) {
  assertRelativePath(checkoutPath, "checkoutPath");
  const parent = dirname(resolve(chatRoot));
  const target = resolve(parent, checkoutPath);
  const fromParent = relative(parent, target);
  if (fromParent === "" || fromParent === ".." || fromParent.startsWith(`..${sep}`)) {
    fail(`checkoutPath越出Chat父目录：${checkoutPath}`);
  }
  return target;
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: createCiSafeEnvironment(options.env),
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `：${result.stderr.trim() || result.stdout.trim()}` : "";
    throw new Error(`${command} ${args.join(" ")}失败${detail}`);
  }
  return options.capture ? result.stdout.trim() : "";
}

function git(checkoutRoot, args) {
  return run("git", ["-C", checkoutRoot, ...args], { cwd: checkoutRoot, capture: true });
}

function assertMarkers(checkoutRoot, markers, label) {
  for (const marker of markers) {
    const markerPath = join(checkoutRoot, marker.path);
    if (!existsSync(markerPath)) throw new Error(`${label} marker文件缺失：${marker.path}`);
    const source = readFileSync(markerPath, "utf8");
    for (const expected of marker.contains) {
      if (!source.includes(expected))
        throw new Error(`${label} marker缺失：${marker.path} -> ${expected}`);
    }
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertReplaceableBuildInput(checkoutRoot, input) {
  const tracked = git(checkoutRoot, ["ls-files", "--", input.targetPath]);
  if (tracked !== "") {
    throw new Error(`${input.id}目标包含Git跟踪文件，拒绝用构建输入覆盖：${input.targetPath}`);
  }
  git(checkoutRoot, ["check-ignore", "--no-index", join(input.targetPath, input.markerPath)]);
}

/**
 * Pi发布源码把模型目录作为固定release输入而非Git文件。这里仅在构建期间挂载SHA-256
 * 锁定的官方source archive目录；已有忽略数据会原样恢复，Later Fork源码与运行链接不变。
 */
function stageBuildInput(input, checkoutRoot) {
  const target = join(checkoutRoot, input.targetPath);
  const targetMarker = join(target, input.markerPath);
  if (existsSync(targetMarker) && sha256(targetMarker) === input.markerSha256) return () => {};

  assertReplaceableBuildInput(checkoutRoot, input);
  const stagingRoot = mkdtempSync(join(checkoutRoot, ".chat-build-input-"));
  const archive = join(stagingRoot, "source.tar.gz");
  const extractionRoot = join(stagingRoot, "extracted");
  const previous = join(stagingRoot, "previous");
  let previousMoved = false;
  let targetInstalled = false;

  const restore = () => {
    if (targetInstalled && existsSync(target)) rmSync(target, { recursive: true, force: true });
    if (previousMoved && existsSync(previous)) renameSync(previous, target);
    rmSync(stagingRoot, { recursive: true, force: true });
  };

  try {
    run(
      "curl",
      [
        "--fail",
        "--location",
        "--retry",
        "3",
        "--silent",
        "--show-error",
        "--proto",
        "=https",
        "--tlsv1.2",
        "--output",
        archive,
        input.url,
      ],
      { cwd: checkoutRoot, capture: false },
    );
    const bytes = readFileSync(archive);
    if (bytes.byteLength !== input.size) {
      throw new Error(
        `${input.id}大小漂移：期望${String(input.size)}，实际${String(bytes.byteLength)}`,
      );
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== input.sha256) throw new Error(`${input.id}归档SHA-256漂移：${digest}`);
    chmodSync(archive, 0o600);
    mkdirSync(extractionRoot);
    run("tar", ["-xzf", archive, "-C", extractionRoot, "--", input.archivePath], {
      cwd: checkoutRoot,
      capture: false,
    });
    const extracted = join(extractionRoot, input.archivePath);
    const extractedMarker = join(extracted, input.markerPath);
    if (!existsSync(extractedMarker) || sha256(extractedMarker) !== input.markerSha256) {
      throw new Error(`${input.id}解包marker SHA-256漂移`);
    }
    if (existsSync(target)) {
      renameSync(target, previous);
      previousMoved = true;
    }
    mkdirSync(dirname(target), { recursive: true });
    renameSync(extracted, target);
    targetInstalled = true;
    return restore;
  } catch (error) {
    restore();
    throw error;
  }
}

/**
 * origin、branch、HEAD、许可证和能力marker共同定义受管源码身份。任一漂移都失败，
 * 已存在目录绝不被脚本自动切分支或覆盖，避免把开发者改动变成CI运行来源。
 */
export function assertManagedSourceIdentity(source, chatRoot = CHAT_ROOT, options = {}) {
  const checkoutRoot = realpathSync(resolveManagedCheckout(chatRoot, source.checkoutPath));
  const dirty = git(checkoutRoot, ["status", "--porcelain"]);
  if (dirty !== "") throw new Error(`${source.id}受管源码存在未提交改动`);
  const origin = git(checkoutRoot, ["remote", "get-url", "origin"]);
  if (canonicalGitHubOrigin(origin) !== canonicalGitHubOrigin(source.repository)) {
    throw new Error(`${source.id} origin漂移：${origin}`);
  }
  const branch = git(checkoutRoot, ["branch", "--show-current"]);
  if (branch !== source.branch) throw new Error(`${source.id} branch漂移：${branch || "detached"}`);
  const revision = git(checkoutRoot, ["rev-parse", "HEAD"]);
  if (revision !== source.commit) throw new Error(`${source.id} HEAD漂移：${revision}`);
  for (const licenseFile of source.licenseFiles) {
    if (!existsSync(join(checkoutRoot, licenseFile))) {
      throw new Error(`${source.id}许可证文件缺失：${licenseFile}`);
    }
  }
  if (!existsSync(join(checkoutRoot, source.lockfile))) {
    throw new Error(`${source.id}锁文件缺失：${source.lockfile}`);
  }
  assertMarkers(checkoutRoot, source.sourceMarkers, `${source.id}源码能力`);
  if (options.runtime === true) {
    assertMarkers(checkoutRoot, source.runtimeMarkers, `${source.id}运行能力`);
  }
  return checkoutRoot;
}

export function checkoutManagedSource(source, chatRoot = CHAT_ROOT) {
  const target = resolveManagedCheckout(chatRoot, source.checkoutPath);
  if (existsSync(target)) return assertManagedSourceIdentity(source, chatRoot);

  mkdirSync(dirname(target), { recursive: true });
  const temporary = mkdtempSync(join(dirname(target), `.${basename(target)}.checkout-`));
  try {
    run("git", ["init", temporary], { cwd: dirname(target), capture: false });
    run("git", ["-C", temporary, "remote", "add", "origin", source.repository], {
      cwd: temporary,
      capture: false,
    });
    run("git", ["-C", temporary, "fetch", "--depth=1", "origin", source.commit], {
      cwd: temporary,
      capture: false,
    });
    run("git", ["-C", temporary, "checkout", "-B", source.branch, source.commit], {
      cwd: temporary,
      capture: false,
    });
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return assertManagedSourceIdentity(source, chatRoot);
}

function runSourceBuild(source, chatRoot) {
  const checkoutRoot = assertManagedSourceIdentity(source, chatRoot);
  const separator = source.packageManager.lastIndexOf("@");
  const manager = source.packageManager.slice(0, separator);
  const expectedVersion = source.packageManager.slice(separator + 1);
  const versionCommand =
    manager === "npm"
      ? ["npm", "--version"]
      : manager === "pnpm"
        ? ["corepack", `pnpm@${expectedVersion}`, "--version"]
        : undefined;
  if (versionCommand === undefined) {
    throw new Error(`${source.id} packageManager不受支持：${source.packageManager}`);
  }
  const [versionExecutable, ...versionArgs] = versionCommand;
  const actualVersion = run(versionExecutable, versionArgs, { cwd: checkoutRoot, capture: true });
  if (actualVersion !== expectedVersion) {
    throw new Error(
      `${source.id} ${manager}版本漂移：期望${expectedVersion}，实际${actualVersion}`,
    );
  }
  const restorers = [];
  try {
    for (const input of source.buildInputs) {
      restorers.push(stageBuildInput(input, checkoutRoot));
    }
    const [install, ...installArgs] = source.installCommand;
    run(install, installArgs, { cwd: checkoutRoot, capture: false });
    for (const [command, ...args] of source.buildCommands) {
      run(command, args, { cwd: checkoutRoot, capture: false });
    }
  } finally {
    for (const restore of restorers.reverse()) restore();
  }
  assertManagedSourceIdentity(source, chatRoot, { runtime: true });
}

export function assertManagedLinks(manifest, chatRoot = CHAT_ROOT) {
  for (const source of manifest.sources) {
    const checkoutRoot = assertManagedSourceIdentity(source, chatRoot, { runtime: true });
    for (const link of source.linkedPackages) {
      const installed = join(chatRoot, link.consumer, "node_modules", link.dependency);
      if (!existsSync(installed)) throw new Error(`${link.dependency} link未安装：${installed}`);
      const actual = realpathSync(installed);
      const expected = realpathSync(join(checkoutRoot, link.sourcePath));
      if (actual !== expected) {
        throw new Error(`${link.dependency}解析漂移：期望${expected}，实际${actual}`);
      }
      const packageManifest = JSON.parse(readFileSync(join(actual, "package.json"), "utf8"));
      if (packageManifest.name !== link.dependency) {
        throw new Error(`${link.dependency}包身份漂移：${String(packageManifest.name)}`);
      }
    }
  }
}

function assertToolchain(manifest, chatRoot) {
  const nodeVersion = process.versions.node;
  if (nodeVersion !== manifest.toolchain.node) {
    throw new Error(`Node版本漂移：期望${manifest.toolchain.node}，实际${nodeVersion}`);
  }
  const [manager, expectedVersion] = manifest.toolchain.chatPackageManager.split("@");
  const actualVersion = run(manager, ["--version"], { cwd: chatRoot, capture: true });
  if (actualVersion !== expectedVersion) {
    throw new Error(`${manager}版本漂移：期望${expectedVersion}，实际${actualVersion}`);
  }
}

export function runManagedSources(command, chatRoot = CHAT_ROOT) {
  const manifest = loadManagedSourcesManifest(join(chatRoot, "config/managed-sources.json"));
  assertToolchain(manifest, chatRoot);
  if (["checkout", "prepare"].includes(command)) {
    for (const source of manifest.sources) checkoutManagedSource(source, chatRoot);
  }
  if (["build", "prepare"].includes(command)) {
    for (const source of manifest.sources) runSourceBuild(source, chatRoot);
  }
  if (command === "prepare") {
    run("pnpm", ["install", "--frozen-lockfile"], { cwd: chatRoot, capture: false });
  }
  if (["assert-links", "prepare", "verify"].includes(command)) {
    assertManagedLinks(manifest, chatRoot);
  }
  if (!["checkout", "build", "assert-links", "prepare", "verify"].includes(command)) {
    throw new Error(`未知managed-sources命令：${command}`);
  }
}

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    runManagedSources(process.argv[2] ?? "verify");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
