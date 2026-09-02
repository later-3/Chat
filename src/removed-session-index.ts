import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ChatProjectContext } from "./projects/types.js";
import { SessionLifecycleError } from "./session-errors.js";
import { removedSessionDirectory } from "./session-files.js";

const REMOVED_SESSION_INDEX_SCHEMA_VERSION = 1;
const REMOVED_SESSION_INDEX_FILE_NAME = "index.json";

export interface RemovedSessionRecord {
  readonly id: string;
  readonly fileName: string;
  readonly cwd: string;
  readonly name?: string;
  readonly created: string;
  readonly modified: string;
  readonly messageCount: number;
  readonly firstMessage: string;
  readonly parentSessionId?: string;
  readonly removedAt: string;
  readonly purgeAt: string;
}

export interface PurgedSessionTombstone {
  readonly id: string;
  readonly purgedAt: string;
}

interface PendingSessionOperation {
  readonly operationId: string;
  readonly type: "remove" | "restore" | "purge";
  readonly record: RemovedSessionRecord;
  readonly startedAt: string;
}

export interface RemovedSessionIndex {
  readonly schemaVersion: typeof REMOVED_SESSION_INDEX_SCHEMA_VERSION;
  readonly revision: number;
  readonly sessions: Readonly<Record<string, RemovedSessionRecord>>;
  readonly tombstones: Readonly<Record<string, PurgedSessionTombstone>>;
  readonly pendingOperation?: PendingSessionOperation;
}

function emptyIndex(): RemovedSessionIndex {
  return {
    schemaVersion: REMOVED_SESSION_INDEX_SCHEMA_VERSION,
    revision: 0,
    sessions: {},
    tombstones: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactFields(value: Record<string, unknown>, fields: readonly string[], subject: string): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length > 0) throw new Error(`${subject}包含未知字段: ${unknown.join(", ")}`);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field}必须是非空字符串`);
  return value;
}

function timestamp(value: unknown, field: string): string {
  const result = requiredString(value, field);
  if (Number.isNaN(Date.parse(result))) throw new Error(`${field}必须是有效时间`);
  return result;
}

function sessionFileName(value: unknown): string {
  const fileName = requiredString(value, "removed session fileName");
  if (basename(fileName) !== fileName || !fileName.endsWith(".jsonl")) {
    throw new Error("removed session fileName必须是JSONL文件名");
  }
  return fileName;
}

function parseRemovedSessionRecord(value: unknown): RemovedSessionRecord {
  if (!isRecord(value)) throw new Error("removed session record必须是对象");
  assertExactFields(value, [
    "id", "fileName", "cwd", "name", "created", "modified", "messageCount", "firstMessage",
    "parentSessionId", "removedAt", "purgeAt",
  ], "removed session record");
  if (!Number.isInteger(value.messageCount) || (value.messageCount as number) < 0) {
    throw new Error("removed session messageCount无效");
  }
  if (value.name !== undefined && typeof value.name !== "string") throw new Error("removed session name无效");
  if (value.parentSessionId !== undefined && typeof value.parentSessionId !== "string") {
    throw new Error("removed session parentSessionId无效");
  }
  if (typeof value.firstMessage !== "string") throw new Error("removed session firstMessage无效");
  return {
    id: requiredString(value.id, "removed session id"),
    fileName: sessionFileName(value.fileName),
    cwd: requiredString(value.cwd, "removed session cwd"),
    ...(value.name === undefined ? {} : { name: value.name }),
    created: timestamp(value.created, "removed session created"),
    modified: timestamp(value.modified, "removed session modified"),
    messageCount: value.messageCount as number,
    firstMessage: value.firstMessage,
    ...(value.parentSessionId === undefined ? {} : { parentSessionId: value.parentSessionId }),
    removedAt: timestamp(value.removedAt, "removed session removedAt"),
    purgeAt: timestamp(value.purgeAt, "removed session purgeAt"),
  };
}

function parseTombstone(value: unknown): PurgedSessionTombstone {
  if (!isRecord(value)) throw new Error("Session tombstone必须是对象");
  assertExactFields(value, ["id", "purgedAt"], "Session tombstone");
  return {
    id: requiredString(value.id, "Session tombstone id"),
    purgedAt: timestamp(value.purgedAt, "Session tombstone purgedAt"),
  };
}

function parsePendingOperation(value: unknown): PendingSessionOperation | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Session pendingOperation必须是对象");
  assertExactFields(value, ["operationId", "type", "record", "startedAt"], "Session pendingOperation");
  if (value.type !== "remove" && value.type !== "restore" && value.type !== "purge") {
    throw new Error("Session pendingOperation type无效");
  }
  return {
    operationId: requiredString(value.operationId, "Session pendingOperation operationId"),
    type: value.type,
    record: parseRemovedSessionRecord(value.record),
    startedAt: timestamp(value.startedAt, "Session pendingOperation startedAt"),
  };
}

function parseRecordMap<T>(
  value: unknown,
  field: string,
  parse: (entry: unknown) => T & { readonly id: string },
): Record<string, T> {
  if (!isRecord(value)) throw new Error(`${field}必须是对象`);
  const result: Record<string, T> = {};
  for (const [id, raw] of Object.entries(value)) {
    const parsed = parse(raw);
    if (parsed.id !== id) throw new Error(`${field}键与Session ID不一致: ${id}`);
    result[id] = parsed;
  }
  return result;
}

function parseIndex(value: unknown): RemovedSessionIndex {
  if (!isRecord(value) || value.schemaVersion !== REMOVED_SESSION_INDEX_SCHEMA_VERSION) {
    throw new Error(`Session移除区索引必须使用schemaVersion ${REMOVED_SESSION_INDEX_SCHEMA_VERSION}`);
  }
  assertExactFields(value, ["schemaVersion", "revision", "sessions", "tombstones", "pendingOperation"], "Session移除区索引");
  if (!Number.isInteger(value.revision) || (value.revision as number) < 0) {
    throw new Error("Session移除区索引revision无效");
  }
  const pendingOperation = parsePendingOperation(value.pendingOperation);
  return {
    schemaVersion: REMOVED_SESSION_INDEX_SCHEMA_VERSION,
    revision: value.revision as number,
    sessions: parseRecordMap(value.sessions, "Session移除区sessions", parseRemovedSessionRecord),
    tombstones: parseRecordMap(value.tombstones, "Session移除区tombstones", parseTombstone),
    ...(pendingOperation === undefined ? {} : { pendingOperation }),
  };
}

function indexPath(project: Pick<ChatProjectContext, "sessionDir">): string {
  return resolve(removedSessionDirectory(project), REMOVED_SESSION_INDEX_FILE_NAME);
}

export async function removedSessionPathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readRemovedSessionIndex(project: Pick<ChatProjectContext, "sessionDir">): Promise<RemovedSessionIndex> {
  const path = indexPath(project);
  try {
    return parseIndex(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyIndex();
    throw new Error(`Session移除区索引无效: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeRemovedSessionIndex(
  project: Pick<ChatProjectContext, "sessionDir">,
  index: RemovedSessionIndex,
): Promise<void> {
  const directory = removedSessionDirectory(project);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = indexPath(project);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

const indexMutationTails = new Map<string, Promise<void>>();

export async function withRemovedSessionIndexMutation<T>(
  project: Pick<ChatProjectContext, "sessionDir">,
  mutation: () => Promise<T>,
): Promise<T> {
  const key = indexPath(project);
  const previous = indexMutationTails.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => current);
  indexMutationTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await mutation();
  } finally {
    release();
    if (indexMutationTails.get(key) === tail) indexMutationTails.delete(key);
  }
}

export function activeSessionRecordPath(
  project: Pick<ChatProjectContext, "sessionDir">,
  record: RemovedSessionRecord,
): string {
  return resolve(project.sessionDir, record.fileName);
}

export function removedSessionRecordPath(
  project: Pick<ChatProjectContext, "sessionDir">,
  record: RemovedSessionRecord,
): string {
  return resolve(removedSessionDirectory(project), record.fileName);
}

async function recoverPendingOperation(
  project: Pick<ChatProjectContext, "sessionDir">,
  index: RemovedSessionIndex,
): Promise<RemovedSessionIndex> {
  const pending = index.pendingOperation;
  if (pending === undefined) return index;
  const active = activeSessionRecordPath(project, pending.record);
  const removed = removedSessionRecordPath(project, pending.record);
  const [activeExists, removedExists] = await Promise.all([removedSessionPathExists(active), removedSessionPathExists(removed)]);
  if (activeExists && removedExists) {
    throw new SessionLifecycleError(
      "SESSION_STORAGE_CONFLICT",
      `Session ${pending.record.id}同时存在于正常目录和移除区`,
    );
  }

  let sessions = { ...index.sessions };
  let tombstones = { ...index.tombstones };
  if (pending.type === "remove") {
    if (!removedExists) {
      if (!activeExists) throw new Error(`恢复移除操作时找不到Session文件: ${pending.record.id}`);
      await rename(active, removed);
    }
    sessions[pending.record.id] = pending.record;
    delete tombstones[pending.record.id];
  } else if (pending.type === "restore") {
    if (!activeExists) {
      if (!removedExists) throw new Error(`恢复还原操作时找不到Session文件: ${pending.record.id}`);
      await rename(removed, active);
    }
    delete sessions[pending.record.id];
  } else {
    if (removedExists) await unlink(removed);
    delete sessions[pending.record.id];
    tombstones[pending.record.id] = { id: pending.record.id, purgedAt: new Date().toISOString() };
  }
  const recovered: RemovedSessionIndex = {
    schemaVersion: REMOVED_SESSION_INDEX_SCHEMA_VERSION,
    revision: index.revision + 1,
    sessions,
    tombstones,
  };
  await writeRemovedSessionIndex(project, recovered);
  return recovered;
}

/** Must be called from within withRemovedSessionIndexMutation(). */
export async function readRecoveredRemovedSessionIndex(
  project: Pick<ChatProjectContext, "sessionDir">,
): Promise<RemovedSessionIndex> {
  return recoverPendingOperation(project, await readRemovedSessionIndex(project));
}

export function prepareRemovedSessionIndexOperation(
  index: RemovedSessionIndex,
  type: "remove" | "restore" | "purge",
  record: RemovedSessionRecord,
  now: Date,
): RemovedSessionIndex {
  return {
    ...index,
    revision: index.revision + 1,
    pendingOperation: {
      operationId: randomUUID(),
      type,
      record,
      startedAt: now.toISOString(),
    },
  };
}

export function completeRemovedSessionIndex(
  index: RemovedSessionIndex,
  sessions: Readonly<Record<string, RemovedSessionRecord>>,
  tombstones: Readonly<Record<string, PurgedSessionTombstone>> = index.tombstones,
): RemovedSessionIndex {
  return {
    schemaVersion: REMOVED_SESSION_INDEX_SCHEMA_VERSION,
    revision: index.revision + 1,
    sessions,
    tombstones,
  };
}

export async function findInactiveChatSessionState(
  project: Pick<ChatProjectContext, "sessionDir">,
  sessionId: string,
): Promise<"removed" | "purged" | "missing"> {
  return withRemovedSessionIndexMutation(project, async () => {
    const index = await readRecoveredRemovedSessionIndex(project);
    if (index.sessions[sessionId] !== undefined) return "removed";
    if (index.tombstones[sessionId] !== undefined) return "purged";
    return "missing";
  });
}
