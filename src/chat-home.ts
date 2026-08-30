import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { mkdir } from "node:fs/promises";

export const CHAT_HOME_ENV = "CHAT_HOME";

export interface ChatHomePaths {
  readonly root: string;
  readonly agentDir: string;
  readonly personalMemoryDir: string;
  readonly projectsDir: string;
  readonly projectRegistryPath: string;
  readonly runtimeDir: string;
  readonly logsDir: string;
  readonly configPath: string;
}

export function resolveChatHome(configured = process.env[CHAT_HOME_ENV]): string {
  const value = configured?.trim();
  if (value === undefined || value === "") return resolve(homedir(), ".chat");
  return isAbsolute(value) ? resolve(value) : resolve(value);
}

export function getChatHomePaths(root = resolveChatHome()): ChatHomePaths {
  const resolvedRoot = resolve(root);
  const projectsDir = resolve(resolvedRoot, "projects");
  return {
    root: resolvedRoot,
    agentDir: resolve(resolvedRoot, "agent"),
    personalMemoryDir: resolve(resolvedRoot, "memory", "personal"),
    projectsDir,
    projectRegistryPath: resolve(projectsDir, "registry.json"),
    runtimeDir: resolve(resolvedRoot, "runtime"),
    logsDir: resolve(resolvedRoot, "logs"),
    configPath: resolve(resolvedRoot, "config.json"),
  };
}

const preparations = new Map<string, Promise<ChatHomePaths>>();

export function ensureChatHome(root = resolveChatHome()): Promise<ChatHomePaths> {
  const paths = getChatHomePaths(root);
  const existing = preparations.get(paths.root);
  if (existing !== undefined) return existing;
  const preparation = (async () => {
    await Promise.all([
      mkdir(paths.root, { recursive: true, mode: 0o700 }),
      mkdir(paths.agentDir, { recursive: true, mode: 0o700 }),
      mkdir(paths.personalMemoryDir, { recursive: true, mode: 0o700 }),
      mkdir(paths.projectsDir, { recursive: true, mode: 0o700 }),
      mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 }),
      mkdir(paths.logsDir, { recursive: true, mode: 0o700 }),
    ]);
    return paths;
  })().catch((error: unknown) => {
    preparations.delete(paths.root);
    throw error;
  });
  preparations.set(paths.root, preparation);
  return preparation;
}
