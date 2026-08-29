import { cp, mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

export interface ChatDataPaths {
  readonly root: string;
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly workflowDataDir: string;
}

const preparations = new Map<string, Promise<ChatDataPaths>>();

export function getChatDataPaths(projectRoot = process.cwd()): ChatDataPaths {
  const root = resolve(projectRoot, ".chat");
  return {
    root,
    agentDir: resolve(root, "agent"),
    sessionDir: resolve(root, "sessions"),
    workflowDataDir: resolve(root, "workflow-data"),
  };
}

async function pathType(path: string): Promise<"directory" | "other" | "missing"> {
  try {
    return (await stat(path)).isDirectory() ? "directory" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function prepareDirectory(target: string, legacy?: string): Promise<void> {
  const targetType = await pathType(target);
  if (targetType === "other") throw new Error(`Chat数据路径不是目录: ${target}`);

  const legacyExists = legacy !== undefined && await pathType(legacy) === "directory";
  if (targetType === "directory") {
    if (legacyExists) {
      await cp(legacy, target, {
        recursive: true,
        force: false,
        errorOnExist: false,
        preserveTimestamps: true,
      });
    }
    return;
  }

  if (legacyExists) {
    await cp(legacy, target, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    });
    return;
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
}

/**
 * Prepares Chat's managed data directories. Missing files are copied from the
 * legacy `.pi` location without overwriting `.chat`; the legacy copy remains
 * untouched so migration is recoverable.
 */
export function ensureChatDataLayout(projectRoot = process.cwd()): Promise<ChatDataPaths> {
  const resolvedRoot = resolve(projectRoot);
  const existing = preparations.get(resolvedRoot);
  if (existing !== undefined) return existing;

  const preparation = (async () => {
    const paths = getChatDataPaths(resolvedRoot);
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    await prepareDirectory(paths.agentDir, resolve(resolvedRoot, ".pi/agent"));
    await prepareDirectory(paths.sessionDir, resolve(resolvedRoot, ".pi/sessions"));
    await prepareDirectory(paths.workflowDataDir);
    return paths;
  })().catch((error: unknown) => {
    preparations.delete(resolvedRoot);
    throw error;
  });
  preparations.set(resolvedRoot, preparation);
  return preparation;
}
