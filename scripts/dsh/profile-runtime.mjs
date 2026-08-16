import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const DSH_WEB_HOST = "127.0.0.1";
export const DSH_WEB_PORT = 43110;
export const BRIDGE_PACKAGE_NAME = "@chat/dsh-lifeos-bridge";
export const BRIDGE_BUNDLE_RELATIVE_PATH = "packages/dsh-lifeos-bridge/dist/dsh-bundle.js";
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
    bridgeBundlePath: join(repoRoot, BRIDGE_BUNDLE_RELATIVE_PATH),
    apiBaseUrl: configuredUrl(environment, "CHAT_API_BASE_URL", "http://127.0.0.1:43111"),
    statePath: resolve(
      repoRoot,
      environment.CHAT_DSH_STATE_PATH?.trim() ||
        join(repoRoot, ".data", "dsh-lifeos-bridge", "state.json"),
    ),
    host: DSH_WEB_HOST,
    port: DSH_WEB_PORT,
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
  return ["web", "--host", runtime.host, "--port", String(runtime.port)];
}

export function dshBridgeInstallArgs(runtime) {
  return ["plugin", "--profile", "web", "add", "--save-exact", `link:${runtime.bridgePackageDir}`];
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
  return executable;
}

/** 普通build只核对已安装Distribution，不创建profile或任何本地运行状态。 */
export function assertDshDistribution(root, environment = process.env) {
  const runtime = resolveDshWebRuntime(root, environment);
  const dshBin = resolveDshBin(root);
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
  const bridgeBundles = (profile.dsh?.profile?.bundles ?? []).filter(
    (bundle) => bundle === BRIDGE_PACKAGE_NAME,
  );
  if (bridgeBundles.length !== 1) {
    throw new Error(
      `DSH Web Profile必须且只能启用一次${BRIDGE_PACKAGE_NAME} bundle，实际为${String(bridgeBundles.length)}`,
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
