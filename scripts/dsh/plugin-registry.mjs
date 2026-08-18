import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DSH_PLUGIN_REGISTRY_SCHEMA_VERSION = "chat-dsh-plugin-registry.v1";
export const DSH_PLUGIN_REGISTRY_RELATIVE_PATH = "config/dsh-plugins.json";
const LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];
const DSH_APPROVED_BUILD_DEPENDENCIES = ["@deepseek-ai/dsh-subprocess-local", "node-pty"];

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `无法读取${label} ${path}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label}必须是非空字符串`);
  return value;
}

function normalizedRepository(value) {
  return String(value ?? "")
    .replace(/^git\+/u, "")
    .replace(/\.git$/u, "");
}

export function loadDshPluginRegistry(root) {
  const repoRoot = resolve(root);
  const path = join(repoRoot, DSH_PLUGIN_REGISTRY_RELATIVE_PATH);
  const registry = readJson(path, "DSH插件登记表");
  if (registry.schemaVersion !== DSH_PLUGIN_REGISTRY_SCHEMA_VERSION) {
    throw new Error(`DSH插件登记表schemaVersion必须是${DSH_PLUGIN_REGISTRY_SCHEMA_VERSION}`);
  }
  requiredString(registry.dshVersion, "DSH插件登记表dshVersion");
  if (!Array.isArray(registry.plugins) || registry.plugins.length === 0) {
    throw new Error("DSH插件登记表必须包含非空plugins");
  }
  const ids = new Set();
  const packageNames = new Set();
  for (const plugin of registry.plugins) {
    const id = requiredString(plugin?.id, "插件id");
    const packageName = requiredString(plugin?.packageName, `${id}.packageName`);
    if (ids.has(id)) throw new Error(`DSH插件登记表存在重复id：${id}`);
    if (packageNames.has(packageName)) throw new Error(`DSH插件登记表存在重复包名：${packageName}`);
    ids.add(id);
    packageNames.add(packageName);
    if (!plugin.compatibility?.dsh?.includes(registry.dshVersion)) {
      throw new Error(`${id}未声明兼容当前DSH ${registry.dshVersion}`);
    }
    if (plugin.update?.trigger !== "manual" || plugin.update?.autoMerge !== false) {
      throw new Error(`${id}必须使用人工触发且禁止自动合并的更新策略`);
    }
    if (plugin.source?.kind === "npm") {
      for (const key of [
        "version",
        "integrity",
        "shasum",
        "gitHead",
        "tag",
        "repository",
        "license",
        "installPath",
      ]) {
        requiredString(plugin.source[key], `${id}.source.${key}`);
      }
    }
  }
  return Object.freeze({ repoRoot, path, registry });
}

function assertWorkspacePlugin(repoRoot, plugin) {
  const packageRoot = resolve(
    repoRoot,
    requiredString(plugin.source?.path, `${plugin.id}.source.path`),
  );
  const manifest = readJson(join(packageRoot, "package.json"), `${plugin.id} workspace清单`);
  if (manifest.name !== plugin.packageName || manifest.version !== plugin.source.version) {
    throw new Error(
      `${plugin.id} workspace身份漂移：${String(manifest.name)}@${String(manifest.version)}`,
    );
  }
  return Object.freeze({ packageRoot, version: manifest.version, source: "workspace" });
}

function assertNpmPlugin(repoRoot, plugin, lock) {
  const source = plugin.source;
  const packageRoot = resolve(
    repoRoot,
    requiredString(source?.installPath, `${plugin.id}.source.installPath`),
  );
  const manifest = readJson(join(packageRoot, "package.json"), `${plugin.id} npm工件清单`);
  if (manifest.name !== plugin.packageName || manifest.version !== source.version) {
    throw new Error(
      `${plugin.id} npm工件身份漂移：${String(manifest.name)}@${String(manifest.version)}`,
    );
  }
  if (manifest.license !== source.license) throw new Error(`${plugin.id}许可证漂移`);
  const license = readFileSync(join(packageRoot, "LICENSE"), "utf8");
  if (!/MIT License/u.test(license)) throw new Error(`${plugin.id}实际LICENSE内容漂移`);
  if (normalizedRepository(manifest.repository?.url) !== normalizedRepository(source.repository)) {
    throw new Error(`${plugin.id}上游仓库漂移`);
  }
  if (Object.keys(manifest.dependencies ?? {}).length > 0) {
    throw new Error(`${plugin.id}出现未审核运行依赖`);
  }
  const lifecycle = LIFECYCLE_SCRIPTS.filter((name) => manifest.scripts?.[name] !== undefined);
  if (lifecycle.length > 0)
    throw new Error(`${plugin.id}出现生命周期脚本：${lifecycle.join("、")}`);

  const webManifest = readJson(join(repoRoot, "apps/dsh-web/package.json"), "DSH Web依赖清单");
  if (webManifest.dependencies?.[plugin.packageName] !== source.version) {
    throw new Error(`${plugin.id}必须以精确版本进入apps/dsh-web依赖`);
  }
  if (
    !lock.includes(`${plugin.packageName}@${source.version}:`) ||
    !lock.includes(source.integrity)
  ) {
    throw new Error(`${plugin.id}缺少与登记表一致的pnpm lock integrity`);
  }
  return Object.freeze({ packageRoot, version: manifest.version, source: "npm" });
}

/**
 * 登记表是插件来源、所有权和采用政策的权威入口；实际package与pnpm lock仍是运行
 * 工件真相。二者不一致时准备/构建失败，避免文档登记与Mac/Linux真实安装各走一套。
 */
export function assertDshPluginRegistry(root) {
  const { repoRoot, registry } = loadDshPluginRegistry(root);
  const workspace = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
  const allowlistMatches = [
    ...workspace.matchAll(/(?:^|\n)onlyBuiltDependencies:\n((?:  - [^\n]+\n?)*)/gu),
  ];
  const actualBuildDependencies = (allowlistMatches[0]?.[1] ?? "")
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .map((line) => line.replace(/^\s*-\s*/u, "").replace(/^["']|["']$/gu, ""));
  if (
    allowlistMatches.length !== 1 ||
    JSON.stringify(actualBuildDependencies) !== JSON.stringify(DSH_APPROVED_BUILD_DEPENDENCIES)
  ) {
    throw new Error(`DSH原生构建脚本白名单必须精确为${DSH_APPROVED_BUILD_DEPENDENCIES.join("、")}`);
  }
  const dshManifest = readJson(
    join(repoRoot, "apps/dsh-web/node_modules/@deepseek-ai/dsh/package.json"),
    "DSH依赖清单",
  );
  if (dshManifest.version !== registry.dshVersion) {
    throw new Error(`登记表DSH版本漂移：${registry.dshVersion} != ${String(dshManifest.version)}`);
  }
  const lock = readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8");
  const plugins = registry.plugins.map((plugin) =>
    plugin.source?.kind === "workspace"
      ? assertWorkspacePlugin(repoRoot, plugin)
      : plugin.source?.kind === "npm"
        ? assertNpmPlugin(repoRoot, plugin, lock)
        : (() => {
            throw new Error(`${plugin.id}使用未知source.kind`);
          })(),
  );
  return Object.freeze({ dshVersion: registry.dshVersion, plugins: Object.freeze(plugins) });
}

export async function checkDshPluginUpdates(root, fetchImpl = globalThis.fetch) {
  const { registry } = loadDshPluginRegistry(root);
  const results = [];
  for (const plugin of registry.plugins.filter((entry) => entry.source?.kind === "npm")) {
    const registryName = encodeURIComponent(plugin.packageName);
    const fetchMetadata = async (version) => {
      const response = await fetchImpl(
        `https://registry.npmjs.org/${registryName}/${encodeURIComponent(version)}`,
        { headers: { accept: "application/json" } },
      );
      if (!response.ok) {
        throw new Error(`${plugin.id} npm ${version}查询失败：HTTP ${String(response.status)}`);
      }
      return response.json();
    };
    const current = await fetchMetadata(plugin.source.version);
    if (
      current.version !== plugin.source.version ||
      current.gitHead !== plugin.source.gitHead ||
      current.dist?.integrity !== plugin.source.integrity ||
      current.dist?.shasum !== plugin.source.shasum
    ) {
      throw new Error(`${plugin.id}登记的当前npm发布证据与registry不一致`);
    }
    const latest = await fetchMetadata("latest");
    results.push(
      Object.freeze({
        id: plugin.id,
        packageName: plugin.packageName,
        current: plugin.source.version,
        latest: String(latest.version ?? "unknown"),
        updateAvailable: latest.version !== plugin.source.version,
        gitHead: latest.gitHead ?? null,
        integrity: latest.dist?.integrity ?? null,
      }),
    );
  }
  return Object.freeze(results);
}

export function defaultRepoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}
