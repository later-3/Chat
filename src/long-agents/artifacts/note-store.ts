import { createHash } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ArtifactNoteConflict, ArtifactWorkspaceState } from "./contract.js";

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface NoteStorePaths {
  storeDir: string;
  versionsDir: string;
  userDir: string;
  pointerFile: string;
}
/** Machine-managed store colocated with the note; the note itself stays a plain user file. */
export function noteStorePaths(canonicalPath: string): NoteStorePaths {
  const name = basename(canonicalPath);
  const slug = `${name.replace(/[^A-Za-z0-9._-]+/g, "-")}-${contentHash(name).slice(0, 8)}`;
  const storeDir = join(dirname(canonicalPath), ".chat-notes", slug);
  return { storeDir, versionsDir: join(storeDir, "versions"), userDir: join(storeDir, "user"), pointerFile: join(storeDir, "current.json") };
}
export function versionFileName(revision: number, hash: string, suffix = ""): string {
  return `r${revision}-${hash.slice(0, 8)}${suffix}.md`;
}

export async function readTextIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Immutable create: the file is written with `link`, so an existing path is never replaced.
 * If the intended name is taken by different content, another name is used instead.
 */
export async function writeImmutableFile(directory: string, fileName: string, content: string, label: string): Promise<{ path: string; created: boolean }> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stem = fileName.replace(/\.md$/, "");
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const target = join(directory, attempt === 0 ? fileName : `${stem}-${attempt}.md`);
    const temp = join(directory, `.tmp-${label}-${attempt}`);
    await rm(temp, { force: true });
    await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
    try {
      await link(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await readTextIfExists(target)) === content) return { path: target, created: false };
      continue;
    }
    await rm(temp, { force: true });
    return { path: target, created: true };
  }
  throw new Error("无法为该笔记版本分配不可变文件路径");
}

/**
 * Create the user-visible note file if (and only if) it does not exist yet. The service never
 * replaces an existing workspace file, so this is the only write it ever performs there.
 */
export async function materializeWorkspaceFile(canonicalPath: string, content: string, label: string): Promise<"created" | "exists"> {
  await mkdir(dirname(canonicalPath), { recursive: true, mode: 0o700 });
  const temp = `${canonicalPath}.chat-note-${label}.tmp`;
  await rm(temp, { force: true });
  await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
  try {
    await link(temp, canonicalPath);
  } catch (error) {
    await rm(temp, { force: true });
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return "exists";
  }
  await rm(temp, { force: true });
  return "created";
}

/**
 * The pointer is machine-managed and rebuildable from the artifact record, which stays the
 * authoritative copy; a lost or tampered pointer can never lose note content.
 */
export async function writeNotePointer(pointerFile: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(pointerFile), { recursive: true, mode: 0o700 });
  const temp = `${pointerFile}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, pointerFile);
}

export interface WorkspaceInspection {
  state: ArtifactWorkspaceState;
  hash: string | null;
  conflict: ArtifactNoteConflict | null;
}
/**
 * Classify the user file without ever modifying it: unchanged current version (`clean`), an older
 * managed version the user has not touched (`older`), or content that matches nothing we produced
 * (`edited`, preserved by the caller). A missing file is reported as `missing`.
 */
export async function inspectWorkspaceFile(
  canonicalPath: string,
  knownHashes: Set<string>,
  currentHash: string,
  preserve: (content: string) => Promise<ArtifactNoteConflict>,
): Promise<WorkspaceInspection> {
  const content = await readTextIfExists(canonicalPath);
  if (content === null) return { state: "missing", hash: null, conflict: null };
  const hash = contentHash(content);
  if (hash === currentHash) return { state: "clean", hash, conflict: null };
  if (knownHashes.has(hash)) return { state: "older", hash, conflict: null };
  return { state: "edited", hash, conflict: await preserve(content) };
}
