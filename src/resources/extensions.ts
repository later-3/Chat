import { existsSync, readdirSync, realpathSync, renameSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
  CONFIG_DIR_NAME,
  DefaultPackageManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { ensureChatHome } from "../chat-home.js";
import { appendChatAuditEvent } from "../audit-log.js";
import { describeResourceVersion, qualifiedResourceAddress } from "./version.js";

function scanDirs(cwd: string, agentDir: string) {
  return [
    { dir: join(agentDir, "extensions"), scope: "global" as const },
    { dir: join(cwd, CONFIG_DIR_NAME, "extensions"), scope: "project" as const },
  ];
}

function nameFromPath(filePath: string): string {
  const file = basename(filePath);
  if (file === "index.ts" || file === "index.js") return basename(dirname(filePath)) || file;
  const extension = extname(file);
  return extension === "" ? file : file.slice(0, -extension.length);
}

export async function listPiExtensions(cwd: string, projectId?: string) {
  const { agentDir } = await ensureChatHome();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const extensions: Array<{
    path: string;
    name: string;
    scope: "global" | "project";
    origin: "file" | "package";
    source: string;
    enabled: boolean;
    disabledPath?: string;
    canToggle: boolean;
    sessionDisabled: boolean;
  }> = [];
  const errors: Array<{ path: string; error: string }> = [];
  try {
    const resolved = await packageManager.resolve(async () => "skip");
    for (const resource of resolved.extensions) {
      const origin = resource.metadata.origin === "package" ? "package" : "file";
      const resourcePath = realpathSync(resource.path);
      extensions.push({
        path: resourcePath,
        name: nameFromPath(resourcePath),
        scope: resource.metadata.scope === "project" ? "project" : "global",
        origin,
        source: resource.metadata.source,
        enabled: resource.enabled,
        canToggle: origin === "file" && /\.(ts|js)$/.test(resource.path),
        sessionDisabled: false,
      });
    }
  } catch (error) {
    errors.push({ path: "<package-manager>", error: error instanceof Error ? error.message : String(error) });
  }

  const seen = new Set(extensions.map((extension) => resolve(extension.path)));
  for (const { dir, scope } of scanDirs(cwd, agentDir)) {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      if (!/\.(ts|js)\.disabled$/.test(entry)) continue;
      const disabledPath = join(dir, entry);
      const enabledPath = disabledPath.replace(/\.disabled$/, "");
      if (seen.has(resolve(enabledPath))) continue;
      const canonicalEnabledPath = join(realpathSync(dir), basename(enabledPath));
      extensions.push({
        path: canonicalEnabledPath,
        name: nameFromPath(canonicalEnabledPath),
        scope,
        origin: "file",
        source: "local",
        enabled: false,
        disabledPath,
        canToggle: true,
        sessionDisabled: false,
      });
    }
  }
  extensions.sort((left, right) => Number(right.enabled) - Number(left.enabled)
    || left.scope.localeCompare(right.scope) || left.name.localeCompare(right.name));
  return {
    extensions: await Promise.all(extensions.map(async (extension) => ({
      ...extension,
      address: qualifiedResourceAddress({
        kind: "extension",
        id: extension.name,
        scope: extension.scope,
        ...(projectId === undefined ? {} : { projectId }),
      }),
      version: await describeResourceVersion(extension.enabled ? extension.path : extension.disabledPath ?? extension.path),
    }))),
    errors,
  };
}

export async function togglePiExtension(cwd: string, targetPath: string, enable: boolean, projectId?: string): Promise<void> {
  const available = await listPiExtensions(cwd, projectId);
  const canonicalTarget = join(realpathSync(dirname(targetPath)), basename(targetPath));
  const extension = available.extensions.find((candidate) => (
    join(realpathSync(dirname(candidate.path)), basename(candidate.path)) === canonicalTarget
  ));
  if (extension === undefined || !extension.canToggle) throw new Error("Extension不能由Chat切换");
  const enabledPath = extension.path;
  const disabledPath = `${enabledPath}.disabled`;
  if (enable) {
    if (!existsSync(disabledPath) || existsSync(enabledPath)) throw new Error("Extension启用状态已改变");
    renameSync(disabledPath, enabledPath);
  } else {
    if (!existsSync(enabledPath) || existsSync(disabledPath)) throw new Error("Extension启用状态已改变");
    renameSync(enabledPath, disabledPath);
  }
  await appendChatAuditEvent({
    action: "extension.toggle",
    target: projectId === undefined
      ? { type: "personal", kind: "extension", path: enabledPath }
      : { type: "project", projectId, kind: "extension", path: enabledPath },
    details: { enabled: enable },
  });
}
