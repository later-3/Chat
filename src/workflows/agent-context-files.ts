import { readFile, realpath, stat } from "node:fs/promises";
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const info = await stat(path);
    if (!info.isFile()) continue;
    if (!isFilePathAllowed(path, new Set([boundary]))) {
      throw new Error(`Agent上下文文件不能越过允许目录: ${candidate}`);
    }
    return { path, content: await readFile(path, "utf8") };
  }
  return undefined;
}

/** Loads only Chat-global and current-Project context files without Pi's unbounded ancestor walk. */
export async function loadChatAgentContextFiles(options: {
  readonly agentDir: string;
  readonly projectRoot: string;
}): Promise<ChatAgentContextFile[]> {
  const [agentDir, projectRoot] = await Promise.all([
    realpath(options.agentDir),
    realpath(options.projectRoot),
  ]);

  const files: ChatAgentContextFile[] = [];
  const globalContext = await readContextFile(agentDir, agentDir);
  if (globalContext !== undefined) files.push(globalContext);
  const projectContext = await readContextFile(projectRoot, projectRoot);
  if (projectContext !== undefined && projectContext.path !== globalContext?.path) files.push(projectContext);
  return files;
}
