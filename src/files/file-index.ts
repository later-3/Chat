import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const IGNORED_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".turbo", ".cache", "coverage", ".pytest_cache", ".mypy_cache",
  "target", "vendor", ".DS_Store",
]);
const IGNORED_SUFFIXES = [".pyc"];

export const FILE_INDEX_CLIENT_LIMIT = 5_000;
export const FILE_INDEX_QUERY_LIMIT = 20;
const GIT_HARD_CAP = 200_000;
const WALK_HARD_CAP = 50_000;
const MAX_WALK_DEPTH = 8;

export interface FileIndexEntry {
  readonly path: string;
  readonly isDir: boolean;
}

export interface FileListing {
  readonly files: string[];
  readonly hardTruncated: boolean;
}

function pathDepth(value: string): number {
  return [...value].filter((character) => character === "/").length;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return needle.length === 0;
}

function scoreEntry(entry: FileIndexEntry, query: string): number {
  const candidatePath = entry.path.toLowerCase();
  let score = 0;
  if (query.includes("/")) {
    if (candidatePath === query) score = 100;
    else if (candidatePath.startsWith(query)) score = 80;
    else if (candidatePath.includes(query)) score = 50;
    else if (isSubsequence(query, candidatePath)) score = 10;
  } else {
    const name = candidatePath.slice(candidatePath.lastIndexOf("/") + 1);
    if (name === query) score = 100;
    else if (name.startsWith(query)) score = 80;
    else if (name.includes(query)) score = 50;
    else if (candidatePath.includes(query)) score = 30;
    else if (isSubsequence(query, candidatePath)) score = 10;
  }
  return score > 0 && entry.isDir ? score + 10 : score;
}

export function buildFileIndexEntries(files: string[]): FileIndexEntry[] {
  const directories = new Set<string>();
  for (const file of files) {
    let separator = file.indexOf("/");
    while (separator !== -1) {
      directories.add(file.slice(0, separator));
      separator = file.indexOf("/", separator + 1);
    }
  }
  return [
    ...[...directories].map((entryPath) => ({ path: entryPath, isDir: true })),
    ...files.filter(Boolean).map((entryPath) => ({ path: entryPath, isDir: false })),
  ].sort((left, right) => pathDepth(left.path) - pathDepth(right.path) || left.path.localeCompare(right.path));
}

export function searchFileIndex(
  entries: FileIndexEntry[],
  query: string,
  limit = FILE_INDEX_QUERY_LIMIT,
): FileIndexEntry[] {
  const normalizedQuery = query.toLowerCase();
  if (normalizedQuery === "") return entries.slice(0, limit);
  return entries
    .map((entry) => ({ entry, score: scoreEntry(entry, normalizedQuery) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => (
      right.score - left.score ||
      pathDepth(left.entry.path) - pathDepth(right.entry.path) ||
      left.entry.path.localeCompare(right.entry.path)
    ))
    .slice(0, limit)
    .map(({ entry }) => entry);
}

async function listWithGit(cwd: string): Promise<FileListing | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { timeout: 10_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } },
    );
    const files = stdout.split("\0").filter(Boolean);
    return files.length > GIT_HARD_CAP
      ? { files: files.slice(0, GIT_HARD_CAP), hardTruncated: true }
      : { files, hardTruncated: false };
  } catch {
    return null;
  }
}

function listWithWalk(cwd: string): FileListing {
  const files: string[] = [];
  const queue: Array<{ absolute: string; relative: string; depth: number }> = [
    { absolute: cwd, relative: "", depth: 0 },
  ];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name) || IGNORED_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (current.depth + 1 <= MAX_WALK_DEPTH) {
          queue.push({
            absolute: path.join(current.absolute, entry.name),
            relative,
            depth: current.depth + 1,
          });
        }
      } else if (entry.isFile()) {
        if (files.length >= WALK_HARD_CAP) return { files, hardTruncated: true };
        files.push(relative);
      }
    }
  }
  return { files, hardTruncated: false };
}

export async function listFileIndex(cwd: string): Promise<FileListing> {
  return (await listWithGit(cwd)) ?? listWithWalk(cwd);
}
