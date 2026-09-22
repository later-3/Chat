import { access, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  defineTool, createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
  createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { withFileLock } from "../persistence/versioned-file.js";
import { isFilePathAllowed } from "../files/path-security.js";

/** Resolve missing write paths through the nearest existing ancestor; never follow a dangling symlink. */
export async function canonicalToolPath(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new Error("文件路径包含失效符号链接");
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
    }
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await canonicalToolPath(parent), path.slice(parent.length + 1));
  }
}

/** Keep Pi's normal text/image reader; only selected immutable text resources use snapshots. */
export function frozenResourceReadTool(cwd: string, files: ReadonlyMap<string, string>, check = canonicalToolPath): ToolDefinition {
  const pinned = createReadToolDefinition(cwd, { operations: {
    access: async (path) => { const p = await check(path); if (!files.has(p)) await access(p); },
    readFile: async (path) => {
      const p = await check(path);
      const text = files.get(p);
      return text === undefined ? readFile(p) : Buffer.from(text);
    },
  } });
  const native = createReadToolDefinition(cwd);
  return defineTool({ ...native, execute: async (...args: Parameters<typeof native.execute>) => {
    const canonical = await check(resolve(cwd, args[1].path));
    return (files.has(canonical) ? pinned : native).execute(...args);
  } });
}

/** Preserve native tool schemas/renderers/edits while enforcing Chat's per-turn file scope. */
export function scopedFileTools(input: {
  readonly cwd: string;
  readonly ownWorkspace: string;
  readonly frozenFiles: ReadonlyMap<string, string>;
  readonly resourceRoots: readonly string[];
}): ToolDefinition[] {
  const roots = new Set([input.cwd, input.ownWorkspace]);
  const check = async (path: string, write = false) => {
    const canonical = await canonicalToolPath(resolve(input.cwd, path));
    if (!isFilePathAllowed(canonical, roots)
      && (write || (!input.frozenFiles.has(canonical) && !isFilePathAllowed(canonical, new Set(input.resourceRoots))))) {
      throw new Error("文件超出本轮项目与Agent工作空间；跨项目访问需要明确授权");
    }
    return canonical;
  };
  const read = frozenResourceReadTool(input.cwd, input.frozenFiles, check);
  const write = createWriteToolDefinition(input.cwd, { operations: {
    mkdir: async (path) => { await mkdir(await check(path, true), { recursive: true }); },
    writeFile: async (path, content) => { await writeFile(await check(path, true), content, "utf8"); },
  } });
  const edit = createEditToolDefinition(input.cwd, { operations: {
    access: async (path) => { await access(await check(path, true)); },
    readFile: async (path) => readFile(await check(path, true)),
    writeFile: async (path, content) => { await writeFile(await check(path, true), content, "utf8"); },
  } });
  const guardSearch = (tool: ToolDefinition): ToolDefinition => ({
    ...tool,
    execute: async (id, params, signal, onUpdate, context) => {
      const path = typeof params === "object" && params !== null && "path" in params ? params.path : undefined;
      await check(typeof path === "string" ? path : input.cwd, true);
      return tool.execute(id, params, signal, onUpdate, context);
    },
  });
  const serializeWrite = (tool: ToolDefinition): ToolDefinition => ({ ...tool,
    execute: async (id, params, signal, onUpdate, context) => {
      if (typeof params !== "object" || params === null || !("path" in params) || typeof params.path !== "string") throw new Error("缺少文件路径");
      const target = await check(params.path, true);
      return withFileLock(target, async () => {
        signal?.throwIfAborted();
        return tool.execute(id, params, signal, onUpdate, context);
      });
    },
  });
  return [read, serializeWrite(defineTool(write)), serializeWrite(defineTool(edit)),
    guardSearch(defineTool(createLsToolDefinition(input.cwd))),
    guardSearch(defineTool(createFindToolDefinition(input.cwd))),
    guardSearch(defineTool(createGrepToolDefinition(input.cwd)))];
}
