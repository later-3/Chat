import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  CreateMemoryInput,
  ListMemoriesInput,
  MemoryHealth,
  MemoryIndexStatus,
  MemoryKind,
  MemoryListPage,
  MemoryRecord,
  MemoryScope,
  MemoryStatus,
  UpdateMemoryInput,
} from "./types.js";

interface MemoryRow {
  readonly id: string;
  readonly text: string;
  readonly kind: string;
  readonly scope: string;
  readonly project_id: string | null;
  readonly metadata_json: string;
  readonly source_session_id: string | null;
  readonly source_entry_ids_json: string;
  readonly source_workflow_invocation_id: string | null;
  readonly status: string;
  readonly version: number;
  readonly mem0_id: string | null;
  readonly index_status: string;
  readonly index_error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PendingIndexDeletion {
  readonly memoryId: string;
  readonly mem0Id: string;
  readonly lastError: string | null;
}

function parseObject(value: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Memory metadata is not a JSON object");
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function parseStringArray(value: string): readonly string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("Memory source entry IDs are not a string array");
  }
  return parsed;
}

function rowToRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    text: row.text,
    kind: row.kind as MemoryKind,
    scope: row.scope as MemoryScope,
    projectId: row.project_id,
    metadata: parseObject(row.metadata_json),
    sourceSessionId: row.source_session_id,
    sourceEntryIds: parseStringArray(row.source_entry_ids_json),
    sourceWorkflowInvocationId: row.source_workflow_invocation_id,
    status: row.status as MemoryStatus,
    version: row.version,
    mem0Id: row.mem0_id,
    indexStatus: row.index_status as MemoryIndexStatus,
    indexError: row.index_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MemoryRepository {
  private readonly db: Database.Database;
  readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > 1) {
      throw new Error(`Memory catalog schema ${version} is newer than supported schema 1`);
    }
    if (version === 1) return;

    this.db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        kind TEXT NOT NULL,
        scope TEXT NOT NULL,
        project_id TEXT,
        metadata_json TEXT NOT NULL,
        source_session_id TEXT,
        source_entry_ids_json TEXT NOT NULL,
        source_workflow_invocation_id TEXT,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        mem0_id TEXT,
        index_status TEXT NOT NULL,
        index_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (scope IN ('global', 'project')),
        CHECK (status IN ('active', 'archived')),
        CHECK (index_status IN ('pending', 'indexed', 'failed'))
      );

      CREATE UNIQUE INDEX memories_mem0_id
        ON memories(mem0_id)
        WHERE mem0_id IS NOT NULL;
      CREATE INDEX memories_list
        ON memories(status, scope, project_id, kind, updated_at DESC);
      CREATE INDEX memories_index_status
        ON memories(index_status, updated_at);

      CREATE TABLE memory_operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL,
        action TEXT NOT NULL,
        version INTEGER NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX memory_operations_memory_id
        ON memory_operations(memory_id, id DESC);

      CREATE TABLE memory_index_deletions (
        mem0_id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_error TEXT
      );

      PRAGMA user_version = 1;
    `);
  }

  create(input: CreateMemoryInput): MemoryRecord {
    const now = new Date().toISOString();
    const id = randomUUID();
    const kind = input.kind ?? "fact";
    const scope = input.scope ?? "global";
    const projectId = scope === "project" ? input.projectId ?? null : null;
    const source = input.source;

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO memories (
          id, text, kind, scope, project_id, metadata_json,
          source_session_id, source_entry_ids_json,
          source_workflow_invocation_id, status, version,
          mem0_id, index_status, index_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, NULL, 'pending', NULL, ?, ?)
      `).run(
        id,
        input.text,
        kind,
        scope,
        projectId,
        JSON.stringify(input.metadata ?? {}),
        source?.sessionId ?? null,
        JSON.stringify(source?.entryIds ?? []),
        source?.workflowInvocationId ?? null,
        now,
        now,
      );
      this.insertOperation(id, "CREATE", 1, now);
    })();

    return this.require(id);
  }

  get(id: string): MemoryRecord | null {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
      | MemoryRow
      | undefined;
    return row === undefined ? null : rowToRecord(row);
  }

  require(id: string): MemoryRecord {
    const record = this.get(id);
    if (record === null) throw new Error(`Memory ${id} does not exist`);
    return record;
  }

  getByMem0Id(mem0Id: string): MemoryRecord | null {
    const row = this.db.prepare("SELECT * FROM memories WHERE mem0_id = ?").get(mem0Id) as
      | MemoryRow
      | undefined;
    return row === undefined ? null : rowToRecord(row);
  }

  getMany(ids: readonly string[]): readonly MemoryRecord[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
      .all(...ids) as MemoryRow[];
    const byId = new Map(rows.map((row) => [row.id, rowToRecord(row)]));
    return ids.flatMap((id) => {
      const record = byId.get(id);
      return record === undefined ? [] : [record];
    });
  }

  list(input: ListMemoriesInput = {}): MemoryListPage {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const offset = Math.max(input.offset ?? 0, 0);
    const where: string[] = [];
    const params: unknown[] = [];

    if (input.scope !== undefined) {
      where.push("scope = ?");
      params.push(input.scope);
    }
    if (input.projectId !== undefined) {
      where.push("project_id = ?");
      params.push(input.projectId);
    }
    if (input.kind !== undefined) {
      where.push("kind = ?");
      params.push(input.kind);
    }
    if (input.status !== undefined) {
      where.push("status = ?");
      params.push(input.status);
    }

    const clause = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM memories ${clause}`)
      .get(...params) as { count: number }).count;
    const rows = this.db.prepare(`
      SELECT * FROM memories ${clause}
      ORDER BY updated_at DESC, id ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as MemoryRow[];

    return { items: rows.map(rowToRecord), total, limit, offset };
  }

  listAllActive(): readonly MemoryRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM memories WHERE status = 'active' ORDER BY created_at ASC, id ASC
    `).all() as MemoryRow[];
    return rows.map(rowToRecord);
  }

  listPendingIndexRecords(): readonly MemoryRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM memories
      WHERE status = 'active' AND index_status != 'indexed'
      ORDER BY updated_at ASC, id ASC
    `).all() as MemoryRow[];
    return rows.map(rowToRecord);
  }

  update(id: string, input: UpdateMemoryInput): MemoryRecord {
    const current = this.require(id);
    const text = input.text ?? current.text;
    const kind = input.kind ?? current.kind;
    const scope = input.scope ?? current.scope;
    const requestedProjectId = input.projectId === undefined
      ? current.projectId
      : input.projectId;
    const projectId = scope === "project" ? requestedProjectId : null;
    const metadata = input.metadata ?? current.metadata;
    const status = input.status ?? current.status;
    const version = current.version + 1;
    const now = new Date().toISOString();

    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE memories SET
          text = ?, kind = ?, scope = ?, project_id = ?, metadata_json = ?,
          status = ?, version = ?, index_status = 'pending', index_error = NULL,
          updated_at = ?
        WHERE id = ?
      `).run(
        text,
        kind,
        scope,
        projectId,
        JSON.stringify(metadata),
        status,
        version,
        now,
        id,
      );
      this.insertOperation(id, "UPDATE", version, now);
    })();

    return this.require(id);
  }

  markIndexed(id: string, mem0Id: string): MemoryRecord {
    this.db.prepare(`
      UPDATE memories
      SET mem0_id = ?, index_status = 'indexed', index_error = NULL
      WHERE id = ?
    `).run(mem0Id, id);
    return this.require(id);
  }

  markIndexFailed(id: string, error: string): MemoryRecord {
    this.db.prepare(`
      UPDATE memories SET index_status = 'failed', index_error = ? WHERE id = ?
    `).run(error, id);
    return this.require(id);
  }

  prepareRebuild(): void {
    this.db.prepare(`
      UPDATE memories
      SET mem0_id = NULL, index_status = 'pending', index_error = NULL
      WHERE status = 'active'
    `).run();
    this.db.prepare("DELETE FROM memory_index_deletions").run();
  }

  delete(id: string): MemoryRecord {
    const current = this.require(id);
    const now = new Date().toISOString();
    this.db.transaction(() => {
      if (current.mem0Id !== null) {
        this.db.prepare(`
          INSERT INTO memory_index_deletions (mem0_id, memory_id, created_at, last_error)
          VALUES (?, ?, ?, NULL)
          ON CONFLICT(mem0_id) DO UPDATE SET memory_id = excluded.memory_id, last_error = NULL
        `).run(current.mem0Id, current.id, now);
      }
      this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
      this.insertOperation(id, "DELETE", current.version + 1, now);
    })();
    return current;
  }

  listPendingDeletions(): readonly PendingIndexDeletion[] {
    const rows = this.db.prepare(`
      SELECT memory_id, mem0_id, last_error
      FROM memory_index_deletions ORDER BY created_at ASC, mem0_id ASC
    `).all() as Array<{
      memory_id: string;
      mem0_id: string;
      last_error: string | null;
    }>;
    return rows.map((row) => ({
      memoryId: row.memory_id,
      mem0Id: row.mem0_id,
      lastError: row.last_error,
    }));
  }

  completePendingDeletion(mem0Id: string): void {
    this.db.prepare("DELETE FROM memory_index_deletions WHERE mem0_id = ?").run(mem0Id);
  }

  failPendingDeletion(mem0Id: string, error: string): void {
    this.db.prepare(`
      UPDATE memory_index_deletions SET last_error = ? WHERE mem0_id = ?
    `).run(error, mem0Id);
  }

  health(): MemoryHealth {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS records,
        SUM(CASE WHEN index_status = 'indexed' THEN 1 ELSE 0 END) AS indexed,
        SUM(CASE WHEN index_status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN index_status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM memories
    `).get() as {
      records: number;
      indexed: number | null;
      pending: number | null;
      failed: number | null;
    };
    const pendingDeletions = (this.db.prepare(`
      SELECT COUNT(*) AS count FROM memory_index_deletions
    `).get() as { count: number }).count;
    return {
      records: row.records,
      indexed: row.indexed ?? 0,
      pending: row.pending ?? 0,
      failed: row.failed ?? 0,
      pendingDeletions,
    };
  }

  close(): void {
    this.db.close();
  }

  private insertOperation(memoryId: string, action: string, version: number, at: string): void {
    this.db.prepare(`
      INSERT INTO memory_operations (memory_id, action, version, occurred_at)
      VALUES (?, ?, ?, ?)
    `).run(memoryId, action, version, at);
  }
}
