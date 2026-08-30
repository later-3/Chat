import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { ensureChatHome, resolveChatHome } from "../chat-home.js";
import { MemoryStoreManager } from "../memory/manager.js";
import type { MemoryKind, MemoryRecord, MemoryStatus, MemoryTarget } from "../memory/types.js";
import { listProjects, openProject } from "../projects/registry.js";

export const PROJECT_LAYOUT_MIGRATION_VERSION = 1;

interface LegacyMemoryRow {
  readonly id: string;
  readonly text: string;
  readonly kind: string;
  readonly scope: string;
  readonly project_id: string | null;
  readonly group_id?: string;
  readonly metadata_json: string;
  readonly source_project_id?: string | null;
  readonly source_session_id: string | null;
  readonly source_entry_ids_json: string;
  readonly source_workflow_invocation_id: string | null;
  readonly status: string;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ProjectLayoutMigrationResult {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly sourceRoot: string;
  readonly chatHome: string;
  readonly completedAt: string;
  readonly copiedAgent: boolean;
  readonly copiedConfig: boolean;
  readonly copiedSessions: number;
  readonly copiedWorkflowData: boolean;
  readonly importedMemories: number;
  readonly skippedMemories: number;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function copyDirectoryIfPresent(source: string, target: string): Promise<boolean> {
  if (!await pathExists(source)) return false;
  await mkdir(target, { recursive: true, mode: 0o700 });
  await cp(source, target, {
    recursive: true,
    force: false,
    errorOnExist: false,
    preserveTimestamps: true,
  });
  return true;
}

async function copyFileIfAbsent(source: string, target: string): Promise<boolean> {
  if (!await pathExists(source) || await pathExists(target)) return false;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await cp(source, target, { force: false, errorOnExist: true, preserveTimestamps: true });
  return true;
}

async function countFiles(path: string): Promise<number> {
  if (!await pathExists(path)) return 0;
  const { readdir } = await import("node:fs/promises");
  return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isFile()).length;
}

function parseJsonObject(value: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(value);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as Readonly<Record<string, unknown>>
    : {};
}

function parseJsonStrings(value: string): readonly string[] {
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function legacyRecord(row: LegacyMemoryRow, sourceProjectId: string | null): MemoryRecord {
  return {
    id: row.id,
    text: row.text,
    kind: row.kind as MemoryKind,
    scope: row.scope === "global" ? "personal" : "project",
    projectId: row.scope === "global" ? null : sourceProjectId,
    groupId: row.group_id ?? row.id,
    metadata: parseJsonObject(row.metadata_json),
    sourceProjectId: row.source_project_id ?? sourceProjectId,
    sourceSessionId: row.source_session_id,
    sourceEntryIds: parseJsonStrings(row.source_entry_ids_json),
    sourceWorkflowInvocationId: row.source_workflow_invocation_id,
    status: row.status as MemoryStatus,
    version: row.version,
    mem0Id: null,
    indexStatus: "pending",
    indexError: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function importLegacyMemory(options: {
  readonly legacyDbPath: string;
  readonly currentProjectId: string;
  readonly chatHome: string;
}): Promise<{ imported: number; skipped: number }> {
  if (!await pathExists(options.legacyDbPath)) return { imported: 0, skipped: 0 };
  const database = new Database(options.legacyDbPath, { readonly: true, fileMustExist: true });
  let rows: readonly LegacyMemoryRow[];
  try {
    const columns = database.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    if (columns.length === 0) return { imported: 0, skipped: 0 };
    rows = database.prepare("SELECT * FROM memories ORDER BY created_at ASC, id ASC").all() as LegacyMemoryRow[];
  } finally {
    database.close();
  }

  const projects = await listProjects(options.chatHome);
  const manager = new MemoryStoreManager(options.chatHome);
  let imported = 0;
  let skipped = 0;
  try {
    for (const row of rows) {
      let target: MemoryTarget;
      let projectId: string | null = null;
      if (row.scope === "global" || row.scope === "personal") {
        target = { type: "personal" };
      } else if (row.scope === "project") {
        projectId = projects.find((project) => (
          project.projectId === row.project_id || project.path === row.project_id
        ))?.projectId ?? (row.project_id === null ? options.currentProjectId : null);
        if (projectId === null) {
          skipped += 1;
          continue;
        }
        target = { type: "project", projectId };
      } else {
        skipped += 1;
        continue;
      }
      await manager.importCatalogRecord(target, legacyRecord(row, projectId));
      imported += 1;
    }
  } finally {
    await manager.close();
  }
  return { imported, skipped };
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
}

/**
 * Moves one legacy project into the Chat Home model without deleting or
 * mutating the legacy data. A per-project marker makes retries idempotent.
 */
export async function migrateLegacyProjectLayout(options: {
  readonly projectRoot?: string;
  readonly chatHome?: string;
} = {}): Promise<ProjectLayoutMigrationResult | null> {
  const sourceRoot = resolve(options.projectRoot ?? process.cwd());
  const chatHome = resolveChatHome(options.chatHome);
  let project;
  try {
    project = await openProject({ path: sourceRoot, chatHome });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("目录尚未初始化为Chat Project:")) return null;
    throw error;
  }

  const home = await ensureChatHome(chatHome);
  const markerPath = resolve(home.root, "migrations", `project-layout-v${PROJECT_LAYOUT_MIGRATION_VERSION}`, `${project.projectId}.json`);
  try {
    return JSON.parse(await readFile(markerPath, "utf8")) as ProjectLayoutMigrationResult;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const legacyRoot = resolve(project.projectRoot, ".chat");
  const legacySessions = resolve(legacyRoot, "sessions");
  const sessionCountBefore = await countFiles(project.sessionDir);
  const isChatSystemProject = project.projectId === (process.env.CHAT_SYSTEM_PROJECT_ID?.trim() || "chat");
  const copiedAgent = isChatSystemProject
    ? await copyDirectoryIfPresent(resolve(legacyRoot, "agent"), home.agentDir)
    : false;
  const copiedConfig = isChatSystemProject
    ? await copyFileIfAbsent(resolve(legacyRoot, "config.json"), home.configPath)
    : false;
  await copyDirectoryIfPresent(legacySessions, project.sessionDir);
  const copiedRootWorkflowData = await copyDirectoryIfPresent(
    resolve(project.projectRoot, ".workflow-data"),
    home.workflowDataDir,
  );
  const copiedChatWorkflowData = await copyDirectoryIfPresent(
    resolve(legacyRoot, "workflow-data"),
    home.workflowDataDir,
  );
  const memory = await importLegacyMemory({
    legacyDbPath: resolve(legacyRoot, "memory", "catalog.db"),
    currentProjectId: project.projectId,
    chatHome: home.root,
  });
  const result: ProjectLayoutMigrationResult = {
    schemaVersion: 1,
    projectId: project.projectId,
    sourceRoot: project.projectRoot,
    chatHome: home.root,
    completedAt: new Date().toISOString(),
    copiedAgent,
    copiedConfig,
    copiedSessions: Math.max(0, await countFiles(project.sessionDir) - sessionCountBefore),
    copiedWorkflowData: copiedRootWorkflowData || copiedChatWorkflowData,
    importedMemories: memory.imported,
    skippedMemories: memory.skipped,
  };
  await atomicWriteJson(markerPath, result);
  return result;
}
