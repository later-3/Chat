import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createCiSafeEnvironment } from "./safe-environment.mjs";

const CHAT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_MANIFEST_PATH = join(CHAT_ROOT, "config/managed-sources.json");
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const BUILD_INPUT_STAGING_PREFIX = ".chat-build-input-";
const BUILD_INPUT_STATE_FILE = "state.json";

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
  assertRelativePath(value.path, `${label}.path`);
  assertStringArray(value.contains, `${label}.contains`);
}

export function assertRelativePath(value, label) {
  assertString(value, label);
  if (
    isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value) ||
    value.startsWith("\\\\") ||
    value.includes("\\") ||
    /[\u0000-\u001f]/u.test(value) ||
    value === "." ||
    value.startsWith("~/") ||
    normalize(value) !== value ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(`${label}必须是规范化、无上级跳转的安全相对路径`);
  }
}

function isInside(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`);
}

/**
 * Manifest路径既要在字面上留在root内，也不能通过任一现有symlink跳出root。
 * 受管源码路径不需要symlink；唯一有意的package link在assertManagedLinks中单独按精确realpath验证。
 */
export function resolveSafePath(root, relativePath, label, options = {}) {
  assertRelativePath(relativePath, label);
  const rootReal = realpathSync(root);
  const target = resolve(rootReal, relativePath);
  if (!isInside(rootReal, target)) fail(`${label}越出受管root：${relativePath}`);

  let current = rootReal;
  for (const segment of relativePath.split("/")) {
    current = join(current, segment);
    if (!existsSync(current)) continue;
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) {
      fail(`${label}经过symlink：${relativePath}`);
    }
    const currentReal = realpathSync(current);
    if (!isInside(rootReal, currentReal)) fail(`${label}真实路径越出受管root：${relativePath}`);
  }
  if (options.mustExist === true && !existsSync(target)) {
    throw new Error(`${label}路径缺失：${relativePath}`);
  }
  return target;
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
  if (source.repository !== canonicalGitHubOrigin(source.repository)) {
    fail(`${label}.repository必须是规范GitHub HTTPS origin`);
  }
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
  source.licenseFiles.forEach((path, pathIndex) =>
    assertRelativePath(path, `${label}.licenseFiles[${String(pathIndex)}]`),
  );
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
  const parent = realpathSync(dirname(resolve(chatRoot)));
  return resolveSafePath(parent, checkoutPath, "checkoutPath");
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
    const markerPath = resolveSafePath(checkoutRoot, marker.path, `${label} marker`, {
      mustExist: true,
    });
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

function buildInputMarkerPath(target, input) {
  if (!existsSync(target)) return resolve(target, input.markerPath);
  if (!lstatSync(target).isDirectory()) throw new Error(`${input.id}目标必须是普通目录`);
  return resolveSafePath(target, input.markerPath, `${input.id}.markerPath`);
}

function assertReplaceableBuildInput(checkoutRoot, input) {
  resolveSafePath(checkoutRoot, input.targetPath, `${input.id}.targetPath`);
  const tracked = git(checkoutRoot, ["ls-files", "--", input.targetPath]);
  if (tracked !== "") {
    throw new Error(`${input.id}目标包含Git跟踪文件，拒绝用构建输入覆盖：${input.targetPath}`);
  }
  git(checkoutRoot, ["check-ignore", "--no-index", `${input.targetPath}/${input.markerPath}`]);
}

function assertNoSymlinksRecursively(root, label) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`${label}包含危险symlink：${entry.name}`);
    if (entry.isDirectory()) assertNoSymlinksRecursively(entryPath, `${label}/${entry.name}`);
  }
}

function writeBuildInputState(stagingRoot, input) {
  const statePath = join(stagingRoot, BUILD_INPUT_STATE_FILE);
  const temporary = `${statePath}.tmp`;
  writeFileSync(
    temporary,
    `${JSON.stringify({ schemaVersion: 1, inputId: input.id, targetPath: input.targetPath })}\n`,
    { mode: 0o600 },
  );
  renameSync(temporary, statePath);
}

function readBuildInputState(stagingRoot, source) {
  const statePath = resolveSafePath(stagingRoot, BUILD_INPUT_STATE_FILE, "build input恢复state", {
    mustExist: true,
  });
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    throw new Error(`受管Build Input恢复state损坏：${stagingRoot}`);
  }
  if (
    state === null ||
    typeof state !== "object" ||
    state.schemaVersion !== 1 ||
    typeof state.inputId !== "string" ||
    typeof state.targetPath !== "string"
  ) {
    throw new Error(`受管Build Input恢复state合同无效：${stagingRoot}`);
  }
  const input = source.buildInputs.find(
    (candidate) => candidate.id === state.inputId && candidate.targetPath === state.targetPath,
  );
  if (input === undefined)
    throw new Error(`受管Build Input恢复state不属于Manifest：${stagingRoot}`);
  return input;
}

function restoreBuildInput(stagingRoot, checkoutRoot, input) {
  const target = resolveSafePath(checkoutRoot, input.targetPath, `${input.id}.targetPath`);
  const previous = join(stagingRoot, "previous");
  const targetMarker = buildInputMarkerPath(target, input);
  const fixedTargetInstalled =
    existsSync(targetMarker) &&
    !lstatSync(targetMarker).isSymbolicLink() &&
    sha256(targetMarker) === input.markerSha256;

  if (existsSync(previous)) {
    if (lstatSync(previous).isSymbolicLink()) {
      throw new Error(`${input.id}恢复目录是危险symlink`);
    }
    if (existsSync(target) && !fixedTargetInstalled) {
      throw new Error(`${input.id}恢复时目标既非空也非固定Build Input，拒绝覆盖`);
    }
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    renameSync(previous, target);
  } else if (existsSync(target) && fixedTargetInstalled) {
    rmSync(target, { recursive: true, force: true });
  }
  rmSync(stagingRoot, { recursive: true, force: true });
}

const activeBuildInputRestorers = new Set();
let signalCleanupInstalled = false;
let signalCleanupRunning = false;

function installSignalCleanup() {
  if (signalCleanupInstalled) return;
  signalCleanupInstalled = true;
  for (const [signal, exitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ]) {
    process.on(signal, () => {
      if (signalCleanupRunning) return;
      signalCleanupRunning = true;
      for (const restore of [...activeBuildInputRestorers].reverse()) {
        try {
          restore();
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
        }
      }
      process.exit(exitCode);
    });
  }
}

/**
 * SIGKILL或主机崩溃无法运行finally。下一次身份检查必须先根据原子state恢复原目录，
 * 否则残留固定输入或staging会把Fork变成偶然运行来源。
 */
export function recoverInterruptedBuildInputs(source, checkoutRoot) {
  for (const entry of readdirSync(checkoutRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith(BUILD_INPUT_STAGING_PREFIX)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`受管Build Input恢复入口不是普通目录：${entry.name}`);
    }
    const stagingRoot = join(checkoutRoot, entry.name);
    const statePath = join(stagingRoot, BUILD_INPUT_STATE_FILE);
    if (!existsSync(statePath)) {
      if (readdirSync(stagingRoot).length === 0) {
        rmSync(stagingRoot, { recursive: true, force: true });
        continue;
      }
      throw new Error(`受管Build Input恢复state缺失：${entry.name}`);
    }
    restoreBuildInput(stagingRoot, checkoutRoot, readBuildInputState(stagingRoot, source));
  }
}

/**
 * Pi发布源码把模型目录作为固定release输入而非Git文件。这里仅在构建期间挂载SHA-256
 * 锁定的官方source archive目录；已有忽略数据会原样恢复，Later Fork源码与运行链接不变。
 */
function stageBuildInput(input, checkoutRoot) {
  const target = resolveSafePath(checkoutRoot, input.targetPath, `${input.id}.targetPath`);
  const targetMarker = buildInputMarkerPath(target, input);
  if (existsSync(targetMarker) && sha256(targetMarker) === input.markerSha256) return () => {};

  assertReplaceableBuildInput(checkoutRoot, input);
  const stagingRoot = mkdtempSync(join(checkoutRoot, BUILD_INPUT_STAGING_PREFIX));
  writeBuildInputState(stagingRoot, input);
  const archive = join(stagingRoot, "source.tar.gz");
  const extractionRoot = join(stagingRoot, "extracted");
  const previous = join(stagingRoot, "previous");
  let restored = false;

  const restore = () => {
    if (restored) return;
    restored = true;
    activeBuildInputRestorers.delete(restore);
    if (existsSync(stagingRoot)) restoreBuildInput(stagingRoot, checkoutRoot, input);
  };
  activeBuildInputRestorers.add(restore);
  installSignalCleanup();

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
    const members = run("tar", ["-tzf", archive, input.archivePath], {
      cwd: checkoutRoot,
      capture: true,
    }).split("\n");
    for (const member of members) {
      const normalizedMember = member.endsWith("/") ? member.slice(0, -1) : member;
      assertRelativePath(normalizedMember, `${input.id}归档成员`);
      if (
        normalizedMember !== input.archivePath &&
        !normalizedMember.startsWith(`${input.archivePath}/`)
      ) {
        throw new Error(`${input.id}归档成员越出固定目录：${member}`);
      }
    }
    const verboseMembers = run("tar", ["-tvzf", archive, input.archivePath], {
      cwd: checkoutRoot,
      capture: true,
    });
    if (verboseMembers.split("\n").some((line) => /^[lh]/u.test(line))) {
      throw new Error(`${input.id}归档包含危险symlink或hardlink`);
    }
    mkdirSync(extractionRoot);
    run("tar", ["-xzf", archive, "-C", extractionRoot, "--", input.archivePath], {
      cwd: checkoutRoot,
      capture: false,
    });
    const extracted = resolveSafePath(
      extractionRoot,
      input.archivePath,
      `${input.id}.archivePath`,
      {
        mustExist: true,
      },
    );
    assertNoSymlinksRecursively(extracted, `${input.id}解包目录`);
    const extractedMarker = resolveSafePath(extracted, input.markerPath, `${input.id}.markerPath`, {
      mustExist: true,
    });
    if (!existsSync(extractedMarker) || sha256(extractedMarker) !== input.markerSha256) {
      throw new Error(`${input.id}解包marker SHA-256漂移`);
    }
    if (existsSync(target)) {
      renameSync(target, previous);
    }
    mkdirSync(dirname(target), { recursive: true });
    renameSync(extracted, target);
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
  recoverInterruptedBuildInputs(source, checkoutRoot);
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
    resolveSafePath(checkoutRoot, licenseFile, `${source.id}许可证`, { mustExist: true });
  }
  resolveSafePath(checkoutRoot, source.lockfile, `${source.id}锁文件`, { mustExist: true });
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
      const consumer = resolveSafePath(chatRoot, link.consumer, `${link.dependency} consumer`, {
        mustExist: true,
      });
      const sourcePath = resolveSafePath(
        checkoutRoot,
        link.sourcePath,
        `${link.dependency} sourcePath`,
        { mustExist: true },
      );
      const installed = join(consumer, "node_modules", link.dependency);
      if (!existsSync(installed)) throw new Error(`${link.dependency} link未安装：${installed}`);
      const actual = realpathSync(installed);
      const expected = realpathSync(sourcePath);
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
