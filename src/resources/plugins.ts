import { readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import type {
  PackageSource,
  ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import {
  DefaultPackageManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { ensureChatDataLayout } from "../chat-data.js";

type PluginScope = "global" | "project";
type ResourceKind = "extension" | "skill" | "prompt" | "theme";
type Counts = { extensions: number; skills: number; prompts: number; themes: number };

function emptyCounts(): Counts {
  return { extensions: 0, skills: 0, prompts: 0, themes: 0 };
}

function scopeName(scope: string): PluginScope {
  return scope === "project" ? "project" : "global";
}

function packageSource(entry: PackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

function packageDisabled(entry: PackageSource): boolean {
  return typeof entry === "object"
    && [entry.extensions, entry.skills, entry.prompts, entry.themes]
      .every((resources) => Array.isArray(resources) && resources.length === 0);
}

function resourceName(path: string, kind: ResourceKind): string {
  const file = basename(path);
  if (kind === "skill" && file.toLowerCase() === "skill.md") return basename(dirname(path));
  if (kind === "extension" && /^index\.(ts|js)$/.test(file)) return basename(dirname(path));
  const extension = extname(file);
  return extension === "" ? file : file.slice(0, -extension.length);
}

function packageMetadata(installedPath?: string) {
  if (installedPath === undefined) return {};
  try {
    const info = statSync(installedPath);
    const path = info.isDirectory() ? join(installedPath, "package.json") : join(dirname(installedPath), "package.json");
    const value = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; version?: unknown };
    return {
      ...(typeof value.name === "string" ? { packageName: value.name } : {}),
      ...(typeof value.version === "string" ? { version: value.version } : {}),
    };
  } catch {
    return {};
  }
}

function collectPackageResources(resources: readonly ResolvedResource[], kind: ResourceKind) {
  return resources
    .filter((resource) => resource.enabled && resource.metadata.origin === "package")
    .map((resource) => ({
      source: resource.metadata.source,
      scope: scopeName(resource.metadata.scope),
      info: {
        kind,
        name: resourceName(resource.path, kind),
        path: resource.path,
        relativePath: resource.metadata.baseDir === undefined
          ? resource.path
          : relative(resource.metadata.baseDir, resource.path),
      },
    }));
}

export async function listPiPlugins(cwd: string) {
  const { agentDir } = await ensureChatDataLayout();
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const diagnostics: Array<{ type: "warning" | "error"; message: string; source?: string }> = [];
  const resourcesByPackage = new Map<string, Array<{ kind: ResourceKind; name: string; path: string; relativePath: string }>>();
  const disabled = new Map<string, boolean>();
  for (const entry of settingsManager.getGlobalSettings().packages ?? []) {
    disabled.set(`global\0${packageSource(entry)}`, packageDisabled(entry));
  }
  for (const entry of settingsManager.getProjectSettings().packages ?? []) {
    disabled.set(`project\0${packageSource(entry)}`, packageDisabled(entry));
  }

  try {
    const resolved = await packageManager.resolve(async (source) => {
      diagnostics.push({ type: "warning", source, message: "Plugin已配置但尚未安装" });
      return "skip";
    });
    const resources = [
      ...collectPackageResources(resolved.extensions, "extension"),
      ...collectPackageResources(resolved.skills, "skill"),
      ...collectPackageResources(resolved.prompts, "prompt"),
      ...collectPackageResources(resolved.themes, "theme"),
    ];
    for (const resource of resources) {
      const key = `${resource.scope}\0${resource.source}`;
      resourcesByPackage.set(key, [...(resourcesByPackage.get(key) ?? []), resource.info]);
    }
  } catch (error) {
    diagnostics.push({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }

  const totals = emptyCounts();
  const packages = packageManager.listConfiguredPackages().map((configured) => {
    const scope = scopeName(configured.scope);
    const key = `${scope}\0${configured.source}`;
    const resources = resourcesByPackage.get(key) ?? [];
    const counts = emptyCounts();
    for (const resource of resources) counts[`${resource.kind}s` as keyof Counts] += 1;
    totals.extensions += counts.extensions;
    totals.skills += counts.skills;
    totals.prompts += counts.prompts;
    totals.themes += counts.themes;
    const isDisabled = disabled.get(key) ?? false;
    return {
      source: configured.source,
      scope,
      filtered: configured.filtered,
      disabled: isDisabled,
      ...(configured.installedPath === undefined ? {} : { installedPath: configured.installedPath }),
      ...packageMetadata(configured.installedPath),
      counts,
      resources,
      status: isDisabled
        ? "disabled" as const
        : resources.length > 0
          ? "loaded" as const
          : configured.installedPath === undefined
            ? "missing" as const
            : "installed" as const,
    };
  });
  return { packages, totals, diagnostics, projectResourcesLoaded: true };
}

function setDisabled(settingsManager: SettingsManager, source: string, scope: PluginScope, disabled: boolean): void {
  const current = scope === "project"
    ? settingsManager.getProjectSettings().packages ?? []
    : settingsManager.getGlobalSettings().packages ?? [];
  const next = current.map((entry): PackageSource => {
    if (packageSource(entry) !== source) return entry;
    return disabled
      ? { ...(typeof entry === "string" ? { source: entry } : entry), extensions: [], skills: [], prompts: [], themes: [] }
      : source;
  });
  if (scope === "project") settingsManager.setProjectPackages(next);
  else settingsManager.setPackages(next);
}

export async function changePiPlugin(options: {
  cwd: string;
  action: "install" | "remove" | "update" | "disable" | "enable";
  source: string;
  scope: PluginScope;
}) {
  const { agentDir } = await ensureChatDataLayout();
  const settingsManager = SettingsManager.create(options.cwd, agentDir, { projectTrusted: true });
  const packageManager = new DefaultPackageManager({ cwd: options.cwd, agentDir, settingsManager });
  const local = options.scope === "project";
  if (options.action === "install") await packageManager.installAndPersist(options.source, { local });
  else if (options.action === "remove") await packageManager.removeAndPersist(options.source, { local });
  else if (options.action === "update") await packageManager.update(options.source);
  else setDisabled(settingsManager, options.source, options.scope, options.action === "disable");
  return listPiPlugins(options.cwd);
}
