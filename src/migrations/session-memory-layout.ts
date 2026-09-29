import { mkdir, readFile, readdir, rename, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { atomicWriteJson } from "../persistence/versioned-file.js";

export const SESSION_MEMORY_LAYOUT_MIGRATION_VERSION = 1;

export interface SessionMemoryLayoutMigrationResult {
  readonly schemaVersion: 1;
  readonly version: typeof SESSION_MEMORY_LAYOUT_MIGRATION_VERSION;
  readonly moved: number;
  readonly keptExisting: number;
  readonly completedAt: string;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

async function directoriesOf(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => resolve(path, entry.name));
}

/**
 * Session memory moved from `<storageRoot>/session-memory/<sessionId>.json` to
 * `<storageRoot>/sessions/session-memory/<sessionId>.json`, i.e. inside the session directory it belongs to
 * (Pi's own `<timestamp>_<id>.jsonl` files stay directly under `sessions/`).
 *
 * The move is a rename inside the same storage root, so it keeps every revision, entry and orphan flag,
 * and it never overwrites an existing target: a file that is already in the new location is the newer
 * authoritative copy (a session written after the upgrade), and the legacy file is left in place rather
 * than destroyed. The per-root marker makes the pass idempotent and retry-safe.
 *
 * Reads fall back to the legacy path until a write migrates that session, so no data is unavailable
 * between the upgrade and this pass.
 */
export async function migrateSessionMemoryLayout(root: string): Promise<SessionMemoryLayoutMigrationResult> {
  const markerPath = resolve(root, "migrations", `session-memory-layout-v${SESSION_MEMORY_LAYOUT_MIGRATION_VERSION}.json`);
  try {
    const done = JSON.parse(await readFile(markerPath, "utf8")) as SessionMemoryLayoutMigrationResult;
    if (done.schemaVersion === 1 && done.version === SESSION_MEMORY_LAYOUT_MIGRATION_VERSION) return done;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  let moved = 0;
  let keptExisting = 0;
  const storageRoots = [
    ...(await directoriesOf(resolve(root, "long-agents"))),
    ...(await directoriesOf(resolve(root, "projects"))),
  ];
  for (const storageRoot of storageRoots) {
    const legacyDir = resolve(storageRoot, "session-memory");
    const targetDir = resolve(storageRoot, "sessions", "session-memory");
    for (const file of await readdir(legacyDir).catch(() => [] as string[])) {
      if (!file.endsWith(".json")) continue;
      const target = resolve(targetDir, file);
      try {
        await stat(target);
        keptExisting += 1;
        continue;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      await mkdir(targetDir, { recursive: true });
      await rename(resolve(legacyDir, file), target);
      moved += 1;
    }
  }

  const result: SessionMemoryLayoutMigrationResult = {
    schemaVersion: 1,
    version: SESSION_MEMORY_LAYOUT_MIGRATION_VERSION,
    moved,
    keptExisting,
    completedAt: new Date().toISOString(),
  };
  await atomicWriteJson(markerPath, result);
  return result;
}
