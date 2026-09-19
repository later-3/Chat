import { readFile, realpath, stat, lstat } from "node:fs/promises";
import { join } from "node:path";
import { isFilePathAllowed } from "../files/path-security.js";

const CONTEXT_FILE_NAMES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
] as const;

export interface ChatAgentContextFile {
  readonly path: string;
  readonly content: string;
}

async function readContextFile(directory: string, boundary: string): Promise<ChatAgentContextFile | undefined> {
  for (const name of CONTEXT_FILE_NAMES) {
    const candidate = join(directory, name);
    let path: string;
    try {
      path = await realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // A dangling link is a broken configured rule, not an absent optional file.
        try { await lstat(candidate); } catch (missing) {
          if ((missing as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw missing;
        }
      }
      throw error;
    }
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`Agent上下文路径不是文件: ${candidate}`);
    if (info.size > 1_000_000) throw new Error(`Agent上下文文件超过1MB，不能截断必需规则: ${candidate}`);
    if (!isFilePathAllowed(path, new Set([boundary]))) {
      throw new Error(`Agent上下文文件不能越过允许目录: ${candidate}`);
    }
    return { path, content: new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path)) };
  }
  return undefined;
}

/** Loads only Chat-global and current-Project context files without Pi's unbounded ancestor walk. */
export async function loadChatAgentContextFiles(options: {
  readonly agentDir: string;
  readonly projectRoot?: string;
  readonly ownRoot?: string;
}): Promise<ChatAgentContextFile[]> {
  const files: ChatAgentContextFile[] = [];
  for (const root of [options.agentDir, options.ownRoot, options.projectRoot]) {
    if (root === undefined) continue;
    const directory = await realpath(root);
    const file = await readContextFile(directory, directory);
    if (file !== undefined && !files.some((existing) => existing.path === file.path)) files.push(file);
  }
  return files;
}
