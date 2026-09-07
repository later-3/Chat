import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

const writes = new Map<string, Promise<unknown>>();

/** Shared by HTTP and Tool writers; callbacks must not reacquire the same lock. */
export async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const previous = writes.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  writes.set(key, current);
  try { return await current; }
  finally { if (writes.get(key) === current) writes.delete(key); }
}

export function contentRevision(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export async function fileRevision(path: string): Promise<string> {
  try { return contentRevision(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

export class RevisionConflict extends Error {
  readonly code = "REVISION_CONFLICT";
  readonly currentRevision: string;
  constructor(currentRevision: string) { super("配置已被修改，请重新读取后再更新"); this.currentRevision = currentRevision; }
}

export async function expectRevision(path: string, expected: string): Promise<void> {
  const current = await fileRevision(path);
  if (current !== expected) throw new RevisionConflict(current);
}

/** Reject symlink escapes even when a registered Project has a hostile .chat directory. */
export async function assertFileWithin(path: string, root: string): Promise<void> {
  const canonicalRoot = await realpath(root);
  let ancestor = resolve(path);
  while (true) {
    try {
      const info = await lstat(ancestor);
      if (info.isSymbolicLink()) throw new Error("管理路径不能包含符号链接");
      const canonical = await realpath(ancestor);
      const rel = relative(canonicalRoot, canonical);
      if (rel === ".." || rel.startsWith("../") || rel.startsWith("/")) throw new Error("文件路径越过Project授权边界");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function atomicWriteText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

/** A write committed but a following cache/audit/receipt step failed. */
export class PersistedWriteError extends Error {
  readonly code = "PERSISTENCE_INCOMPLETE";
  readonly applied = true;
}
