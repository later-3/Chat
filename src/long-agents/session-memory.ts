import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { getChatHomePaths } from "../chat-home.js";
import { assertFileWithin, atomicWriteJson, withFileLock } from "../persistence/versioned-file.js";
import { resolveProjectContext } from "../projects/registry.js";
import type { ChatProjectContext } from "../projects/types.js";
import { requireActiveSessionFile } from "../session-files.js";
import { longAgentConfigRoot } from "./storage.js";
import { removedSessionDirectory } from "../session-files.js";
// The single purpose taxonomy: the domain validation and the agent tool schema both read it.
import { SESSION_MEMORY_CORE_PURPOSES, SESSION_MEMORY_CUSTOM_PURPOSES, SESSION_MEMORY_PURPOSES, isSessionMemoryPurpose } from "./session-memory-purposes.js";
import type { SessionMemoryPurpose } from "./session-memory-purposes.js";
export { SESSION_MEMORY_CORE_PURPOSES, SESSION_MEMORY_CUSTOM_PURPOSES, SESSION_MEMORY_PURPOSES } from "./session-memory-purposes.js";
export type { SessionMemoryPurpose } from "./session-memory-purposes.js";

/**
 * P1 session memory: a per-session durable companion of purpose-typed entries.
 *
 * It is NOT a second Memory tier: it never touches mem0 (user memory) or NanoClaw memory
 * (Long Agent memory). Entries are append-only; a correction/overturn adds a new entry that
 * `supersedes` the old one, so history stays auditable.
 */
export const SESSION_MEMORY_SCHEMA_VERSION = 1;
export const SESSION_MEMORY_MAX_CONTENT = 4_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

export type SessionMemoryAuthor = "agent" | "user";
export type SessionMemoryStatus = "active" | "superseded";


export interface SessionMemoryEntry {
  readonly entryId: string;
  readonly purpose: SessionMemoryPurpose;
  /** Semantic origin: distilled from the agent's own content => agent; from a user turn => user. */
  readonly author: SessionMemoryAuthor;
  readonly content: string;
  /** Turn entry this statement came from, for provenance. */
  readonly originEntryId: string | null;
  /** Set when this entry replaces an earlier one (append-only overturn). */
  readonly supersedes: string | null;
  /**
   * The writing request that produced this entry, when the writer is a retryable orchestration (topic
   * node creation). It is the durable request -> entry link: a retry adopts this exact entry instead of
   * guessing identity from content, which would claim unrelated entries.
   */
  readonly writeRequestId: string | null;
  /**
   * The fingerprint of the WHOLE request that wrote this entry. The first entry of a multi-entry
   * request freezes it, so an interrupted request can be completed without silently mixing in content
   * from a different request that reused the same id.
   */
  readonly writeRequestFingerprint: string | null;
  readonly status: SessionMemoryStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Internal mutable shape used while a locked write is in flight. */
interface MutableSessionMemoryEntry {
  entryId: string;
  purpose: SessionMemoryPurpose;
  author: SessionMemoryAuthor;
  content: string;
  originEntryId: string | null;
  supersedes: string | null;
  writeRequestId: string | null;
  writeRequestFingerprint: string | null;
  status: SessionMemoryStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SessionMemoryState {
  readonly schemaVersion: typeof SESSION_MEMORY_SCHEMA_VERSION;
  readonly sessionId: string;
  /** The owning session was removed; entries are kept for traceability, not for new writes. */
  readonly orphan: boolean;
  readonly revision: number;
  readonly entries: readonly SessionMemoryEntry[];
}

export class SessionMemoryError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function record(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SessionMemoryError(500, "会话记忆存储格式无效");
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) throw new SessionMemoryError(400, `会话记忆${label}无效`);
  return value.trim();
}

function optionalText(value: unknown, label: string, max: number): string | null {
  return value === null || value === undefined ? null : text(value, label, max);
}

function parsePurpose(value: unknown): SessionMemoryPurpose {
  const purpose = text(value, "purpose", 40);
  if (!isSessionMemoryPurpose(purpose)) {
    throw new SessionMemoryError(400, `会话记忆purpose无效：${purpose}；默认标签：${SESSION_MEMORY_PURPOSES.join("、")}；都不合适可自定义一个短标签`);
  }
  return purpose;
}

function parseAuthor(value: unknown): SessionMemoryAuthor {
  if (value !== "agent" && value !== "user") throw new SessionMemoryError(400, "会话记忆author必须是agent或user");
  return value;
}

function parseEntry(value: unknown): SessionMemoryEntry {
  record(value);
  const keys = ["entryId", "purpose", "author", "content", "originEntryId", "supersedes", "writeRequestId", "writeRequestFingerprint", "status", "createdAt", "updatedAt"];
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new SessionMemoryError(500, "会话记忆条目包含未知字段");
  if (value.status !== "active" && value.status !== "superseded") throw new SessionMemoryError(500, "会话记忆条目状态无效");
  return {
    entryId: text(value.entryId, "entryId", 120),
    purpose: parsePurpose(value.purpose),
    author: parseAuthor(value.author),
    content: text(value.content, "content", SESSION_MEMORY_MAX_CONTENT),
    originEntryId: optionalText(value.originEntryId, "originEntryId", 200),
    supersedes: optionalText(value.supersedes, "supersedes", 120),
    writeRequestId: optionalText(value.writeRequestId, "writeRequestId", 200),
    writeRequestFingerprint: optionalText(value.writeRequestFingerprint, "writeRequestFingerprint", 200),
    status: value.status,
    createdAt: text(value.createdAt, "createdAt", 64),
    updatedAt: text(value.updatedAt, "updatedAt", 64),
  };
}

/**
 * A session's memory lives beside its own project data: a Long Agent home keeps
 * `<chatHome>/long-agents/<id>/session-memory/`, every other project `<chatHome>/projects/<id>/session-memory/`.
 * The kind of an id never changes, and a Long Agent home exists before it can own a session, so the
 * directory that exists is the authoritative one — no registry read on this hot path.
 */
function sessionMemoryDir(chatHome: string, storageProjectId: string): string {
  const paths = getChatHomePaths(chatHome);
  const agentHome = longAgentConfigRoot(paths.root, storageProjectId);
  return existsSync(agentHome) ? agentHome : resolve(paths.projectsDir, storageProjectId);
}

export function sessionMemoryFile(chatHome: string, storageProjectId: string, sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new SessionMemoryError(400, `sessionId无效：${sessionId}`);
  return resolve(sessionMemoryDir(chatHome, storageProjectId), "session-memory", `${sessionId}.json`);
}

export async function readSessionMemory(chatHome: string, longAgentId: string, sessionId: string): Promise<SessionMemoryState> {
  const file = sessionMemoryFile(chatHome, longAgentId, sessionId);
  await assertFileWithin(file, chatHome);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { schemaVersion: SESSION_MEMORY_SCHEMA_VERSION, sessionId, orphan: false, revision: 0, entries: [] };
    throw error;
  }
  record(value);
  const keys = ["schemaVersion", "sessionId", "orphan", "revision", "entries"];
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new SessionMemoryError(500, "会话记忆存储包含未知字段");
  if (value.schemaVersion !== SESSION_MEMORY_SCHEMA_VERSION || !Array.isArray(value.entries) || typeof value.orphan !== "boolean" || !Number.isSafeInteger(value.revision))
    throw new SessionMemoryError(500, "会话记忆存储格式无效");
  const entries = value.entries.map(parseEntry);
  return { schemaVersion: SESSION_MEMORY_SCHEMA_VERSION, sessionId: text(value.sessionId, "sessionId", 200), orphan: value.orphan, revision: Number(value.revision), entries };
}

async function changeSessionMemory<T>(
  chatHome: string,
  longAgentId: string,
  sessionId: string,
  change: (state: { schemaVersion: 1; sessionId: string; orphan: boolean; revision: number; entries: MutableSessionMemoryEntry[] }) => T | Promise<T>,
): Promise<T> {
  const file = sessionMemoryFile(chatHome, longAgentId, sessionId);
  return withFileLock(file, async () => {
    const current = await readSessionMemory(chatHome, longAgentId, sessionId);
    const state: { schemaVersion: 1; sessionId: string; orphan: boolean; revision: number; entries: MutableSessionMemoryEntry[] } = { schemaVersion: SESSION_MEMORY_SCHEMA_VERSION, sessionId: current.sessionId, orphan: current.orphan, revision: current.revision, entries: current.entries.map((entry): MutableSessionMemoryEntry => ({ ...entry })) };
    const result = await change(state);
    await assertFileWithin(file, chatHome);
    await atomicWriteJson(file, state);
    return result;
  });
}

/**
 * Entry identity is unique per accepted write (revision-based), never derived from content: the same
 * content can legitimately appear again after an overturn (A → B → A), and a content-addressed id
 * would collide with history and break append-only supersede.
 */
function entryIdOf(revision: number, input: { purpose: string; author: string; content: string; originEntryId: string | null; supersedes: string | null }): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([input.purpose, input.author, input.content, input.originEntryId, input.supersedes]))
    .digest("hex")
    .slice(0, 16);
  return `smem-${String(revision).padStart(4, "0")}-${digest}`;
}

export interface WriteSessionMemoryEntryInput {
  readonly chatHome: string;
  readonly longAgentId: string;
  readonly sessionId: string;
  readonly operation: "write" | "supersede";
  readonly purpose: unknown;
  readonly author: unknown;
  readonly content: unknown;
  readonly originEntryId?: unknown;
  readonly supersedes?: unknown;
  /** Durable retry identity for orchestration writers; a retry re-reads and adopts its own entry. */
  readonly writeRequestId?: unknown;
  /** Freezes the WHOLE request on its first entry (see SessionMemoryEntry.writeRequestFingerprint). */
  readonly writeRequestFingerprint?: unknown;
  readonly expectedRevision: unknown;
  readonly now?: string;
}

/**
 * Append one entry (or overturn an existing one). There is NO content-based idempotency: identity is
 * per accepted write, and a caller that sees an uncertain result must re-read (list) and decide — a
 * stale retry is reported as a revision conflict (review 26).
 */
export async function writeSessionMemoryEntry(input: WriteSessionMemoryEntryInput): Promise<SessionMemoryState> {
  const purpose = parsePurpose(input.purpose);
  const author = parseAuthor(input.author);
  const content = text(input.content, "content", SESSION_MEMORY_MAX_CONTENT);
  const originEntryId = optionalText(input.originEntryId, "originEntryId", 200);
  if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0)
    throw new SessionMemoryError(400, "会话记忆写入需要 expectedRevision（先用 list 读取当前 revision）");
  const expectedRevision = Number(input.expectedRevision);
  const now = input.now ?? new Date().toISOString();
  if (input.operation === "supersede" && (input.supersedes === undefined || input.supersedes === null))
    throw new SessionMemoryError(400, "supersede 必须指定被推翻的 supersedes 条目");
  if (input.operation === "write" && input.supersedes !== undefined && input.supersedes !== null)
    throw new SessionMemoryError(400, "write 不接受 supersedes：推翻请使用 supersede 操作");
  const supersedes = input.operation === "supersede" ? text(input.supersedes, "supersedes", 120) : null;
  const writeRequestId = optionalText(input.writeRequestId, "writeRequestId", 200);
  const writeRequestFingerprint = optionalText(input.writeRequestFingerprint, "writeRequestFingerprint", 200);
  if (writeRequestFingerprint !== null && writeRequestId === null)
    throw new SessionMemoryError(400, "写入请求指纹必须与 writeRequestId 一起使用");
  // No idempotency by content: callers that see an uncertain result must re-read (list) and decide —
  // a CAS conflict is the documented outcome for a stale retry (review 26).
  return changeSessionMemory(input.chatHome, input.longAgentId, input.sessionId, async (state) => {
    // Lifecycle first (a removed/purged session is reported as such, not as a revision conflict), then
    // CAS, then self-heal: an interrupted restore can leave a stale orphan flag on an active session,
    // and a legitimate write must heal it rather than be refused (review 31).
    // Every session owns its project's memory, so the only gate is that the session still exists.
    const project = await resolveProjectContext(input.longAgentId, input.chatHome);
    let active = true;
    try {
      await requireActiveSessionFile(project, input.sessionId);
    } catch {
      active = false;
    }
    if (!active) {
      throw new SessionMemoryError(409, state.orphan ? "会话已移除，不能再写入会话记忆" : "会话已移除或不存在，不能再写入会话记忆");
    }
    if (state.revision !== expectedRevision) throw new SessionMemoryError(409, `会话记忆已被修改（当前 revision ${String(state.revision)}），请重新读取后重试`);
    if (state.orphan) {
      state.orphan = false;
      state.revision += 1;
    }
    // Every accepted write gets a fresh identity (revision-based): A → B → A must produce three
    // distinct entries, and a duplicate-looking write must never shortcut a pending supersede.
    const entryId = entryIdOf(state.revision + 1, { purpose, author, content, originEntryId, supersedes });
    if (supersedes !== null) {
      const target = state.entries.find((entry) => entry.entryId === supersedes);
      if (target === undefined) throw new SessionMemoryError(404, `找不到要推翻的会话记忆条目：${supersedes}`);
      if (target.status !== "active") throw new SessionMemoryError(409, "该条目已被推翻，无需重复操作");
      target.status = "superseded";
      target.updatedAt = now;
    }
    if (writeRequestId !== null) {
      // The request is frozen by its FIRST entry: a later entry of the same request id with a different
      // fingerprint means the caller changed the request instead of retrying it.
      const frozen = state.entries.find((entry) => entry.writeRequestId === writeRequestId && entry.writeRequestFingerprint !== null);
      if (frozen !== undefined && frozen.writeRequestFingerprint !== writeRequestFingerprint)
        throw new SessionMemoryError(409, `该 requestId 已写入不同的请求内容：${writeRequestId}`);
    }
    state.entries.push({ entryId, purpose, author, content, originEntryId, supersedes, writeRequestId, writeRequestFingerprint, status: "active", createdAt: now, updatedAt: now });
    state.revision += 1;
    return snapshot(state);
  });
}

function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string" ? [(block as { text: string }).text] : []))
    .join("\n");
}

function snapshot(state: { schemaVersion: 1; sessionId: string; orphan: boolean; revision: number; entries: readonly SessionMemoryEntry[] }): SessionMemoryState {
  return { schemaVersion: SESSION_MEMORY_SCHEMA_VERSION, sessionId: state.sessionId, orphan: state.orphan, revision: state.revision, entries: state.entries.map((entry) => ({ ...entry })) };
}

/** A removed session keeps its memory for traceability; only purge deletes it. Storage errors propagate. */
export async function markSessionMemoryOrphan(chatHome: string, longAgentId: string, sessionId: string): Promise<void> {
  const file = sessionMemoryFile(chatHome, longAgentId, sessionId);
  await withFileLock(file, async () => {
    const current = await readSessionMemory(chatHome, longAgentId, sessionId);
    if (current.orphan || (current.revision === 0 && current.entries.length === 0)) return;
    await atomicWriteJson(file, { ...current, orphan: true });
  });
}

/** A restored session becomes writable again: clear the orphan marker and advance the revision. */
export async function clearSessionMemoryOrphan(chatHome: string, longAgentId: string, sessionId: string): Promise<void> {
  const file = sessionMemoryFile(chatHome, longAgentId, sessionId);
  await withFileLock(file, async () => {
    const current = await readSessionMemory(chatHome, longAgentId, sessionId);
    if (current.revision === 0 && current.entries.length === 0) return;
    if (!current.orphan) return;
    await atomicWriteJson(file, { ...current, orphan: false, revision: current.revision + 1 });
  });
}

export async function purgeSessionMemory(chatHome: string, longAgentId: string, sessionId: string): Promise<void> {
  const file = sessionMemoryFile(chatHome, longAgentId, sessionId);
  await assertFileWithin(file, chatHome);
  await unlink(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

/**
 * Paged read of the bound session's own conversation entries. It exists so a projected (current-round
 * only) writer/reader agent can pull earlier context on demand; it never exposes another session.
 */
export async function readSessionMemoryHistory(input: {
  readonly chatHome: string;
  readonly longAgentId: string;
  readonly sessionId: string;
  readonly afterEntryId?: string;
  readonly limit?: number;
}): Promise<{ schemaVersion: 1; sessionId: string; entries: readonly { entryId: string; role: string | null; text: string }[]; nextAfterEntryId: string | null }> {
  const limit = Number.isSafeInteger(input.limit) ? Math.min(Math.max(Number(input.limit), 1), 100) : 40;
  const { openChatSession } = await import("../chat-session.js");
  const session = await openChatSession({ chatHome: input.chatHome, projectId: input.longAgentId, sessionId: input.sessionId });
  const all = session.manager.getEntries().flatMap((entry) => {
    // Real user/assistant turns.
    if (entry.type === "message") {
      const message = entry.message as { role?: unknown; content?: unknown };
      const role = typeof message.role === "string" ? message.role : null;
      const text = messageContentText(message.content);
      return text.trim() === "" ? [] : [{ entryId: entry.id, parentId: entry.parentId ?? null, role, text }];
    }
    // Chat-written custom messages (e.g. the integration summary) are part of the model context too.
    if (entry.type === "custom_message" && typeof entry.customType === "string" && entry.customType.startsWith("chat.")) {
      const text = messageContentText(entry.content);
      return text.trim() === "" ? [] : [{ entryId: entry.id, parentId: entry.parentId ?? null, role: `custom:${entry.customType}`, text }];
    }
    return [];
  });
  let page: { entryId: string; parentId: string | null; role: string | null; text: string }[];
  if (input.afterEntryId === undefined) {
    page = all.slice(0, limit);
  } else {
    // An unknown cursor must fail instead of silently restarting from the beginning.
    const index = all.findIndex((entry) => entry.entryId === input.afterEntryId);
    if (index < 0) throw new SessionMemoryError(400, `会话记忆历史游标无效：${input.afterEntryId}`);
    page = all.slice(index + 1, index + 1 + limit);
  }
  const last = page[page.length - 1];
  return { schemaVersion: 1, sessionId: input.sessionId, entries: page, nextAfterEntryId: page.length === limit && last !== undefined ? last.entryId : null };
}

/**
 * Converges the session memory to the lifecycle state the caller has established for this session.
 * This is the compensation for a lifecycle operation whose index write failed after the memory
 * change, and it also covers a process exit before that compensation ran. The caller (remove /
 * restore / purge) knows the lifecycle state it just established; this function does not probe the
 * filesystem for it (session files are `<timestamp>_<id>.jsonl`, so an id-based existence probe would
 * be wrong and could accidentally purge the memory).
 */
export async function convergeSessionMemoryWithLifecycle(
  project: ChatProjectContext,
  sessionId: string,
  lifecycleState: "active" | "removed" | "purged",
): Promise<void> {
  if (project.kind !== "agent") return;
  const memory = await readSessionMemory(project.chatHome, project.projectId, sessionId);
  if (memory.revision === 0 && memory.entries.length === 0) {
    // Nothing was ever recorded; only a purged lifecycle must guarantee no leftover file.
    if (lifecycleState === "purged") await purgeSessionMemory(project.chatHome, project.projectId, sessionId);
    return;
  }
  const file = sessionMemoryFile(project.chatHome, project.projectId, sessionId);
  if (lifecycleState === "purged") {
    await purgeSessionMemory(project.chatHome, project.projectId, sessionId);
    return;
  }
  const shouldBeOrphan = lifecycleState === "removed";
  if (memory.orphan === shouldBeOrphan) return;
  await withFileLock(file, async () => {
    const latest = await readSessionMemory(project.chatHome, project.projectId, sessionId);
    if (latest.orphan === shouldBeOrphan) return;
    await atomicWriteJson(file, { ...latest, orphan: shouldBeOrphan, revision: latest.revision + 1 });
  });
}

export interface SessionMemoryTarget {
  readonly longAgentId: string;
  readonly sessionId: string;
}

/**
 * Resolve the trusted session-memory target. Every session has its own memory, so the storage owner is
 * whichever project the session actually belongs to — NEVER a model- or client-supplied value:
 *   1. a binding frozen server-side by the assembly (topic nodes / workflow calls) wins;
 *   2. else the Long Agent home that ran the turn (its session owns the memory even when the turn
 *      collaborates on another project);
 *   3. else the session's own project (an ordinary project session).
 * The target must still be an ACTIVE session of that project, so a stale/forged binding is refused.
 */
export async function resolveSessionMemoryTarget(input: {
  chatHome: string;
  projectId: string;
  sessionId: string;
  longAgentId?: string;
  binding?: { readonly storageProjectId: string; readonly sessionId: string } | null;
}): Promise<SessionMemoryTarget> {
  const storageProjectId = input.binding?.storageProjectId ?? input.longAgentId ?? input.projectId;
  const sessionId = input.binding?.sessionId ?? input.sessionId;
  if (sessionId.trim() === "") throw new SessionMemoryError(400, "会话记忆需要sessionId");
  const project = await resolveProjectContext(storageProjectId, input.chatHome).catch(() => null);
  if (project === null) throw new SessionMemoryError(403, `找不到会话记忆归属的项目：${storageProjectId}`);
  try {
    await requireActiveSessionFile(project, sessionId);
  } catch {
    throw new SessionMemoryError(404, `找不到会话记忆归属的会话：${sessionId}`);
  }
  return { longAgentId: storageProjectId, sessionId };
}
