import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  DSH_INTERNAL_WEB_HOST,
  DSH_INTERNAL_WEB_PORT,
  PUBLIC_WEB_HOST,
  PUBLIC_WEB_PORT,
} from "./web-gateway.mjs";

export const DSH_WEB_HOST = DSH_INTERNAL_WEB_HOST;
export const DSH_WEB_PORT = DSH_INTERNAL_WEB_PORT;
export const BRIDGE_PACKAGE_NAME = "@chat/dsh-lifeos-bridge";
export const BRIDGE_BUNDLE_RELATIVE_PATH = "packages/dsh-lifeos-bridge/dist/dsh-bundle.js";
export const DSH_CLI_RUNTIME_IMPORTS = Object.freeze([
  "@deepseek-ai/dsh-app-boot",
  "@deepseek-ai/dsh-cmdline",
  "@deepseek-ai/dsh-home-paths",
  "@deepseek-ai/dsh-launch-environment",
  "commander",
]);
const DSH_CLI_RUNTIME_VERSIONS = Object.freeze({
  "@deepseek-ai/dsh-app-boot": "0.1.0-rc.6",
  "@deepseek-ai/dsh-cmdline": "0.1.0-rc.6",
  "@deepseek-ai/dsh-home-paths": "0.1.0-rc.6",
  "@deepseek-ai/dsh-launch-environment": "0.1.0-rc.6",
  commander: "15.0.0",
});
const DSH_SAFE_HOST_ENV_NAMES = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "COREPACK_HOME",
  "PNPM_HOME",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
];

function configuredUrl(environment, name, fallback) {
  const value = environment[name]?.trim() || fallback;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name}必须是绝对HTTP URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${name}只支持http或https`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(`${name}不能在URL中携带凭据`);
  }
  return parsed.href.replace(/\/$/u, "");
}

/**
 * DSH_HOME 是可重建的本地运行投影，固定在当前worktree而不是用户全局 ~/.dsh。
 * Bridge状态文件只通过Node进程环境传递，不进入浏览器URL、命令参数或就绪日志。
 */
export function resolveDshWebRuntime(root, environment = process.env) {
  const repoRoot = resolve(root);
  return Object.freeze({
    root: repoRoot,
    dshHome: join(repoRoot, ".data", "dsh-home"),
    profileDir: join(repoRoot, ".data", "dsh-home", "profiles", "web"),
    bridgePackageDir: join(repoRoot, "packages", "dsh-lifeos-bridge"),
    mobileShellPackageDir: join(repoRoot, "apps", "dsh-web", "node_modules", "dsh-mobile-hanui"),
    bridgeBundlePath: join(repoRoot, BRIDGE_BUNDLE_RELATIVE_PATH),
    apiBaseUrl: configuredUrl(environment, "CHAT_API_BASE_URL", "http://127.0.0.1:43111"),
    statePath: resolve(
      repoRoot,
      environment.CHAT_DSH_STATE_PATH?.trim() ||
        join(repoRoot, ".data", "dsh-lifeos-bridge", "state.json"),
    ),
    host: DSH_WEB_HOST,
    port: DSH_WEB_PORT,
    publicHost: PUBLIC_WEB_HOST,
    publicPort: PUBLIC_WEB_PORT,
    publicHostname: environment.CHAT_PUBLIC_WEB_HOSTNAME?.trim() || undefined,
  });
}

export function dshWebEnvironment(root, environment = process.env) {
  const runtime = resolveDshWebRuntime(root, environment);
  const isolated = {};
  for (const name of DSH_SAFE_HOST_ENV_NAMES) {
    const value = environment[name];
    if (typeof value === "string" && value !== "") isolated[name] = value;
  }
  // HOME/TMP仅是工具链路径，不是凭据；保留它们可让Corepack/pnpm复用已验证的本机
  // store，避免每次准备profile下载另一份包。Provider/云/SSH等变量仍不在白名单中。
  const hostHome = isolated.HOME ?? join(runtime.dshHome, "host-home");
  const temporary =
    isolated.TMPDIR ?? isolated.TMP ?? isolated.TEMP ?? join(runtime.dshHome, "tmp");
  return {
    ...isolated,
    HOME: hostHome,
    USERPROFILE: isolated.USERPROFILE ?? hostHome,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    XDG_CONFIG_HOME: isolated.XDG_CONFIG_HOME ?? join(runtime.dshHome, "xdg-config"),
    XDG_CACHE_HOME: isolated.XDG_CACHE_HOME ?? join(runtime.dshHome, "xdg-cache"),
    CHAT_REPO_ROOT: runtime.root,
    CHAT_API_BASE_URL: runtime.apiBaseUrl,
    CHAT_DSH_STATE_PATH: runtime.statePath,
    CHAT_PUBLIC_WEB_PORT: String(runtime.publicPort),
    // 服务器部署模式：公开主机名与认证文件路径（路径不是凭据；口令散列与
    // 会话密钥只存在于文件内容中，绝不进入环境变量值）。未设置时这些键不存在，
    // 网关与 bridge 保持纯 loopback 姿态。
    ...(environment.CHAT_PUBLIC_WEB_HOSTNAME === undefined
      ? {}
      : { CHAT_PUBLIC_WEB_HOSTNAME: environment.CHAT_PUBLIC_WEB_HOSTNAME }),
    ...(environment.CHAT_WEB_AUTH_REQUIRED === undefined
      ? {}
      : { CHAT_WEB_AUTH_REQUIRED: environment.CHAT_WEB_AUTH_REQUIRED }),
    ...(environment.CHAT_WEB_AUTH_CREDENTIALS_FILE === undefined
      ? {}
      : { CHAT_WEB_AUTH_CREDENTIALS_FILE: environment.CHAT_WEB_AUTH_CREDENTIALS_FILE }),
    ...(environment.CHAT_WEB_AUTH_SESSION_SECRET_FILE === undefined
      ? {}
      : { CHAT_WEB_AUTH_SESSION_SECRET_FILE: environment.CHAT_WEB_AUTH_SESSION_SECRET_FILE }),
    ...(environment.CHAT_WEB_AUTH_SESSION_DAYS === undefined
      ? {}
      : { CHAT_WEB_AUTH_SESSION_DAYS: environment.CHAT_WEB_AUTH_SESSION_DAYS }),
    CHAT_CODE_WORKBENCH_ENABLED: environment.CHAT_CODE_WORKBENCH_ENABLED === "0" ? "0" : "1",
    ...(environment.CHAT_CODE_WORKBENCH_RUN_ROOT === undefined
      ? {}
      : { CHAT_CODE_WORKBENCH_RUN_ROOT: environment.CHAT_CODE_WORKBENCH_RUN_ROOT }),
    CHAT_CODE_WORKBENCH_TEMP_PARENT: environment.CHAT_CODE_WORKBENCH_TEMP_PARENT ?? temporary,
    ...(environment.CHAT_FIXED_SOURCE_CACHE_ROOT === undefined
      ? {}
      : { CHAT_FIXED_SOURCE_CACHE_ROOT: environment.CHAT_FIXED_SOURCE_CACHE_ROOT }),
    DSH_HOME: runtime.dshHome,
    DSH_WEB_PORT: String(runtime.port),
    DSH_TELEMETRY_DISABLED: "1",
    DSH_TELEMETRY_MODE: "DISABLED",
  };
}

/**
 * start-web与DSH发布包同进程运行，不能只Object.assign：那会让父shell中的Provider、
 * 云账号和SSH变量继续存在。先删除非白名单，再安装受管环境，确保插件也看不到密钥。
 */
export function installDshWebEnvironment(target, environment) {
  for (const name of Object.keys(target)) {
    if (!(name in environment)) delete target[name];
  }
  Object.assign(target, environment);
}

export function dshWebArgs(runtime) {
  const args = ["web", "--host", runtime.host, "--port", String(runtime.port)];
  // 服务器部署模式：DSH 的 /api Host 信任栅只放行 loopback 与显式声明的
  // 部署主机名（DNS rebinding 防线）。公开主机名来自组合期环境变量，
  // 由 web-app 的 --trusted-host 公开参数声明，不修改上游。
  if (typeof runtime.publicHostname === "string" && runtime.publicHostname !== "") {
    args.push("--trusted-host", runtime.publicHostname);
  }
  return args;
}

export function dshBridgeInstallArgs(runtime) {
  return ["plugin", "--profile", "web", "add", "--save-exact", `link:${runtime.bridgePackageDir}`];
}

/**
 * 移动端外壳：固定 dsh-mobile-hanui@0.2.4（MIT，零运行时依赖，仅客户端DOM/CSS
 * 适配，无网络外发）。根workspace的精确依赖与pnpm-lock拥有下载/integrity事实，
 * DSH profile只link已验证工件，不在可重建.data中二次解析npm。运行时可用
 * ?mobileShell=0关闭。
 */
export const DSH_MOBILE_SHELL_PACKAGE = "dsh-mobile-hanui";
export const DSH_MOBILE_SHELL_VERSION = "0.2.4";

export function dshMobileShellInstallArgs(runtime) {
  return [
    "plugin",
    "--profile",
    "web",
    "add",
    "--save-exact",
    `link:${runtime.mobileShellPackageDir}`,
  ];
}

export function dshPackageManifestPath(root) {
  return join(
    resolve(root),
    "apps",
    "dsh-web",
    "node_modules",
    "@deepseek-ai",
    "dsh",
    "package.json",
  );
}

/** 从声明的bin字段解析rc.6入口，避免launcher绑定发布包内部文件名。 */
export function resolveDshBin(root) {
  const manifestPath = dshPackageManifestPath(root);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`无法读取DSH依赖清单 ${manifestPath}：${String(error)}`);
  }
  if (manifest.version !== "0.1.0-rc.6") {
    throw new Error(`DSH版本必须是0.1.0-rc.6，实际为${String(manifest.version)}`);
  }
  const declared = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.dsh;
  if (typeof declared !== "string" || declared.trim() === "") {
    throw new Error("@deepseek-ai/dsh未声明dsh命令入口");
  }
  const executable = resolve(dirname(manifestPath), declared);
  if (!existsSync(executable)) throw new Error(`DSH命令入口不存在：${executable}`);
  // CLI通过动态import进入同一Node Host。显式冻结virtual-store中的真实工件路径，避免
  // pnpm逻辑链接路径成为ESM parent URL后从apps/dsh-web错误解析上游内部依赖。
  return realpathSync(executable);
}

function bareRuntimeImports(source) {
  const imports = new Set();
  for (const pattern of [
    /\bfrom\s+["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /^\s*import\s+["']([^"']+)["']/gmu,
  ]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier && !specifier.startsWith(".") && !specifier.startsWith("node:")) {
        imports.add(specifier);
      }
    }
  }
  return imports;
}

function resolvedPackageManifest(entry, packageName) {
  let directory = dirname(entry);
  for (;;) {
    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = readJson(manifestPath, `DSH CLI依赖${packageName}清单`);
      if (manifest.name === packageName) return Object.freeze({ manifest, manifestPath });
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`无法定位DSH CLI运行依赖清单：${packageName}`);
}

/**
 * 校验Chat直接嵌入的rc.6 CLI完整运行闭包。依赖必须由DSH自己的virtual-store快照
 * 解析；不能从用户目录、private hoist或apps/dsh-web的偶然依赖补洞。
 */
export function assertDshCliRuntimeClosure(root) {
  const repoRoot = resolve(root);
  const dshRoot = realpathSync(dirname(dshPackageManifestPath(repoRoot)));
  const libDir = join(dshRoot, "lib");
  const importers = [];
  const imports = new Set();
  for (const filename of readdirSync(libDir)
    .filter((name) => name.endsWith(".js"))
    .sort()) {
    const importer = join(libDir, filename);
    const fileImports = [...bareRuntimeImports(readFileSync(importer, "utf8"))].sort();
    if (fileImports.length === 0) continue;
    importers.push(Object.freeze({ importer, imports: Object.freeze(fileImports) }));
    for (const specifier of fileImports) imports.add(specifier);
  }
  const runtimeImports = [...imports].sort();
  if (JSON.stringify(runtimeImports) !== JSON.stringify([...DSH_CLI_RUNTIME_IMPORTS])) {
    throw new Error(
      `DSH CLI裸运行依赖与rc.6固定合同不一致：${runtimeImports.join("、") || "none"}`,
    );
  }

  const virtualStoreRoot = join(repoRoot, "node_modules", ".pnpm") + sep;
  const resolutions = new Map();
  for (const { importer, imports: fileImports } of importers) {
    const importerRequire = createRequire(importer);
    for (const specifier of fileImports) {
      let entry;
      try {
        entry = realpathSync(importerRequire.resolve(specifier));
      } catch {
        throw new Error(`DSH CLI工件依赖不可解析：${specifier}（importer=${importer}）`);
      }
      if (!entry.startsWith(virtualStoreRoot)) {
        throw new Error(`DSH CLI运行依赖越出仓库virtual-store：${specifier}`);
      }
      const { manifest } = resolvedPackageManifest(entry, specifier);
      if (manifest.version !== DSH_CLI_RUNTIME_VERSIONS[specifier]) {
        throw new Error(
          `DSH CLI运行依赖版本漂移：${specifier}@${String(manifest.version)}，期望${DSH_CLI_RUNTIME_VERSIONS[specifier]}`,
        );
      }
      resolutions.set(specifier, entry);
    }
  }
  return Object.freeze({
    dshRoot,
    dshBin: resolveDshBin(repoRoot),
    imports: Object.freeze(runtimeImports),
    importers: Object.freeze(importers),
    resolutions: Object.freeze(
      Object.fromEntries([...resolutions].sort(([a], [b]) => a.localeCompare(b))),
    ),
  });
}

/** 普通build只核对已安装Distribution，不创建profile或任何本地运行状态。 */
export function assertDshDistribution(
  root,
  environment = process.env,
  { inspectCliRuntime = assertDshCliRuntimeClosure } = {},
) {
  const runtime = resolveDshWebRuntime(root, environment);
  const { dshBin } = inspectCliRuntime(root);
  assertBridgeBundleContract(runtime);
  if (!existsSync(runtime.bridgeBundlePath)) {
    throw new Error(`DSH LifeOS Bridge固定入口不存在：${runtime.bridgeBundlePath}`);
  }
  return Object.freeze({ dshBin, bridgeBundlePath: runtime.bridgeBundlePath });
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`无法读取${label} ${path}：${String(error)}`);
  }
}

/**
 * Bridge自己拥有rc.6原生bundle patch；launcher只读manifest解析公开入口，绝不把
 * API地址、状态路径或Bridge内部实现复制到profile的用户层或浏览器Boot Manifest。
 */
export function assertBridgeBundleContract(runtime) {
  const manifestPath = join(runtime.bridgePackageDir, "package.json");
  const manifest = readJson(manifestPath, "Bridge依赖清单");
  if (manifest.name !== BRIDGE_PACKAGE_NAME) {
    throw new Error(`Bridge包名必须是${BRIDGE_PACKAGE_NAME}`);
  }
  if (typeof manifest.main !== "string" || manifest.main.trim() === "") {
    throw new Error(`${BRIDGE_PACKAGE_NAME}必须声明固定main入口`);
  }
  const bundlePath = resolve(runtime.bridgePackageDir, manifest.main);
  if (bundlePath !== runtime.bridgeBundlePath) {
    throw new Error(`Bridge main必须解析到固定入口：${runtime.bridgeBundlePath}`);
  }
  const declaredPatch = manifest.dsh?.bundle?.patch;
  if (typeof declaredPatch !== "string" || declaredPatch.trim() === "") {
    throw new Error(`${BRIDGE_PACKAGE_NAME}必须声明dsh.bundle.patch`);
  }
  const patchPath = resolve(runtime.bridgePackageDir, declaredPatch);
  let patch;
  try {
    patch = readFileSync(patchPath, "utf8");
  } catch (error) {
    throw new Error(`无法读取Bridge Profile Patch ${patchPath}：${String(error)}`);
  }
  if (/CHAT_API_BASE_URL|CHAT_DSH_STATE_PATH|43111|state\.json/u.test(patch)) {
    throw new Error("Bridge Profile Patch不得包含Chat API地址或私有状态路径");
  }
  return Object.freeze({ bundlePath, patchPath });
}

export function assertManagedWebProfileReady(runtime) {
  const profileManifestPath = join(runtime.profileDir, "package.json");
  const required = [
    runtime.bridgeBundlePath,
    profileManifestPath,
    join(runtime.profileDir, "cordis.patch.yml"),
    join(runtime.profileDir, "node_modules", "@chat", "dsh-lifeos-bridge", "package.json"),
    join(runtime.profileDir, "node_modules", DSH_MOBILE_SHELL_PACKAGE, "package.json"),
  ];
  const missing = required.filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(
      `DSH Web Profile尚未准备：${missing.join("、")}；请运行 pnpm --filter @chat/dsh-web prepare:profile`,
    );
  }
  const profile = readJson(profileManifestPath, "DSH Web Profile清单");
  if (profile.dependencies?.[BRIDGE_PACKAGE_NAME] === undefined) {
    throw new Error(`DSH Web Profile未安装${BRIDGE_PACKAGE_NAME}`);
  }
  if (profile.dependencies?.[DSH_MOBILE_SHELL_PACKAGE] === undefined) {
    throw new Error(`DSH Web Profile未安装${DSH_MOBILE_SHELL_PACKAGE}`);
  }
  const bridgeBundles = (profile.dsh?.profile?.bundles ?? []).filter(
    (bundle) => bundle === BRIDGE_PACKAGE_NAME,
  );
  if (bridgeBundles.length !== 1) {
    throw new Error(
      `DSH Web Profile必须且只能启用一次${BRIDGE_PACKAGE_NAME} bundle，实际为${String(bridgeBundles.length)}`,
    );
  }
  const mobileBundles = (profile.dsh?.profile?.bundles ?? []).filter(
    (bundle) => bundle === DSH_MOBILE_SHELL_PACKAGE,
  );
  if (mobileBundles.length !== 1) {
    throw new Error(
      `DSH Web Profile必须且只能启用一次${DSH_MOBILE_SHELL_PACKAGE} bundle，实际为${String(mobileBundles.length)}`,
    );
  }
  assertBridgeBundleContract(runtime);
}

function yamlRows(dump, id) {
  const lines = dump.split(/\r?\n/u);
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)-\s+id:\s+["']?([^"'\s]+)["']?\s*$/u.exec(lines[index] ?? "");
    if (match?.[2] === id) starts.push({ index, indent: match[1]?.length ?? 0 });
  }
  return starts.map((start) => {
    let end = lines.length;
    for (let index = start.index + 1; index < lines.length; index += 1) {
      const match = /^(\s*)-\s+id:/u.exec(lines[index] ?? "");
      if (match && (match[1]?.length ?? 0) === start.indent) {
        end = index;
        break;
      }
    }
    return lines.slice(start.index, end).join("\n");
  });
}

function assertOneYamlRow(dump, id) {
  const rows = yamlRows(dump, id);
  if (rows.length !== 1) {
    throw new Error(`DSH组合配置必须且只能包含一个${id} row，实际为${String(rows.length)}`);
  }
  return rows[0];
}

function hasYamlScalar(row, key, value) {
  return row.split(/\r?\n/u).some((line) => {
    const trimmed = line.trim();
    const separator = trimmed.indexOf(":");
    if (separator < 0 || trimmed.slice(0, separator) !== key) return false;
    const raw = trimmed.slice(separator + 1).trim();
    const unquoted = /^(["'])(.*)\1$/u.exec(raw)?.[2] ?? raw;
    return unquoted === value;
  });
}

/** 最终组合配置的P0门：所有模型请求只能经Chat LifeOS Adapter进入产品Workflow。 */
export function assertDshWebCutoverConfig(dump) {
  const defaultModel = assertOneYamlRow(dump, "agent-default-model");
  if (!hasYamlScalar(defaultModel, "provider", "lifeos")) {
    throw new Error("DSH默认Provider必须是lifeos");
  }
  if (!hasYamlScalar(defaultModel, "model", "workflow")) {
    throw new Error("DSH默认Model必须是workflow");
  }

  for (const id of ["llm-deepseek", "llm-pi-ai"]) {
    const row = assertOneYamlRow(dump, id);
    if (!hasYamlScalar(row, "disabled", "true")) {
      throw new Error(`${id}必须disabled，禁止绕过Chat产品事实`);
    }
  }

  const bridge = assertOneYamlRow(dump, "lifeos-bridge");
  if (!hasYamlScalar(bridge, "name", BRIDGE_PACKAGE_NAME)) {
    throw new Error(`lifeos-bridge必须加载${BRIDGE_PACKAGE_NAME}`);
  }

  const mobileShell = assertOneYamlRow(dump, "dsh-mobile-hanui-shell");
  if (!hasYamlScalar(mobileShell, "name", DSH_MOBILE_SHELL_PACKAGE)) {
    throw new Error(`dsh-mobile-hanui-shell必须加载${DSH_MOBILE_SHELL_PACKAGE}`);
  }
}

export function runCommand(command, args, options = {}) {
  const spawnImpl = options.spawnImpl ?? spawn;
  return new Promise((resolveRun, rejectRun) => {
    const child = spawnImpl(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? "inherit",
      signal: options.signal,
    });
    child.once("error", rejectRun);
    child.once("close", (code, childSignal) => {
      if (code === 0) resolveRun();
      else {
        rejectRun(
          new Error(
            `${options.label ?? command}失败（code=${String(code)} signal=${childSignal ?? "none"}）`,
          ),
        );
      }
    });
  });
}

export function runCommandOutput(command, args, options = {}) {
  const spawnImpl = options.spawnImpl ?? spawn;
  return new Promise((resolveRun, rejectRun) => {
    const child = spawnImpl(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "inherit"],
      signal: options.signal,
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", rejectRun);
    child.once("close", (code, childSignal) => {
      if (code === 0) resolveRun(output);
      else {
        rejectRun(
          new Error(
            `${options.label ?? command}失败（code=${String(code)} signal=${childSignal ?? "none"}）`,
          ),
        );
      }
    });
  });
}
