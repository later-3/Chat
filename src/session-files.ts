import { readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  SessionManager,
  type SessionInfo,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { collectChatSubsessionRelation } from "./workflows/workflow-call-state.js";
import type { ChatProjectContext } from "./projects/types.js";

export const REMOVED_SESSION_DIRECTORY_NAME = "removed";

/** Session ids are used as a file-name suffix, so the exact-id fast path only accepts this shape. */
const SESSION_FILE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

export function removedSessionDirectory(project: Pick<ChatProjectContext, "sessionDir">): string {
  return resolve(project.sessionDir, REMOVED_SESSION_DIRECTORY_NAME);
}

function messageUtteranceText(message: unknown): string {
  if (typeof message !== "object" || message === null || !("role" in message)
    || (message.role !== "user" && message.role !== "assistant") || !("content" in message)) return "";
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content.flatMap((block) => (
    typeof block === "object" && block !== null && "type" in block && block.type === "text"
      && "text" in block && typeof block.text === "string" ? [block.text] : []
  )).join("\n").trim();
}

/** Pi's list sentinel is first-user-only; Chat uses the first human or Agent utterance. */
function firstUtterance(entries: readonly SessionEntry[]): string {
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const text = messageUtteranceText(entry.message);
    if (text !== "") return text;
  }
  return "";
}

interface SessionFileSummary {
  readonly version: string;
  readonly info: SessionInfo;
  readonly parentSessionId?: string;
}
// Derived metadata only: never keep a writable SessionManager or authorization in this cache.
// Metadata is checked on EVERY read, including external Pi CLI writes and atomic replacement.
const summaries = new Map<string, SessionFileSummary>();
const summaryParents = new WeakMap<SessionInfo, string>();
const summaryMessageTimes = new WeakMap<SessionInfo, readonly number[]>();
const MAX_SUMMARIES = 2_048;

async function readFileSummary(path: string): Promise<SessionFileSummary> {
  const file = await stat(path, { bigint: true });
  const version = `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;
  const previous = summaries.get(path);
  if (previous?.version === version) return previous;
  const manager = SessionManager.open(path, dirname(path));
  const header = manager.getHeader();
  if (header === null) throw new Error("Session缺少原生文件头");
  const entries = manager.getEntries();
  const messages = entries.filter(entry => entry.type === "message");
  const name = manager.getSessionName();
  let activity = Date.parse(header.timestamp);
  for (const entry of messages) {
    const timestamp = entry.message.timestamp;
    const time = typeof timestamp === "number" ? timestamp : Date.parse(entry.timestamp);
    if (Number.isFinite(time)) activity = Math.max(activity, time);
  }
  const info: SessionInfo = {
    path, id: manager.getSessionId(), cwd: manager.getCwd(),
    ...(name == null ? {} : { name }),
    ...(header.parentSession === undefined ? {} : { parentSessionPath: header.parentSession }),
    created: new Date(header.timestamp),
    modified: new Date(Number.isFinite(activity) ? activity : Number(file.mtimeMs)),
    messageCount: messages.length,
    firstMessage: firstUtterance(entries),
    // Preserve the full first utterance for the existing sidebar search, not only its visual preview.
    allMessagesText: "",
  };
  const parentSessionId = collectChatSubsessionRelation(entries)?.parentSessionId;
  if (parentSessionId !== undefined) summaryParents.set(info, parentSessionId);
  // Calendar availability follows the branch that the common Session reader actually opens.
  // Header/configuration entries alone are not history; do not turn an empty Session green.
  summaryMessageTimes.set(info, manager.getBranch().flatMap(entry => {
    if (entry.type !== "message" || entry.message.role === "toolResult") return [];
    const timestamp = typeof entry.message.timestamp === "number" ? entry.message.timestamp : Date.parse(entry.timestamp);
    return Number.isFinite(timestamp) ? [timestamp] : [];
  }));
  const summary = { version, info, ...(parentSessionId === undefined ? {} : { parentSessionId }) };
  // If a writer changed the file while it was read, do not cache that intermediate projection.
  const after = await stat(path, { bigint: true });
  if (`${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}` === version) {
    summaries.delete(path);
    summaries.set(path, summary);
    if (summaries.size > MAX_SUMMARIES) summaries.delete(summaries.keys().next().value!);
  }
  return summary;
}

export function firstSessionUtterance(info: SessionInfo): string {
  return info.firstMessage === "(no messages)" ? "" : info.firstMessage;
}

/** Relation was projected from the SAME native read as the list metadata. */
export function sessionSummaryParent(info: SessionInfo): string | undefined {
  return summaryParents.get(info);
}

/** Derived from the same stat-validated native read as the normal Session list, with no new index. */
export function sessionMessageDates(info: SessionInfo, timeZone: string): string[] {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return [...new Set((summaryMessageTimes.get(info) ?? []).map(timestamp => {
    const parts = format.formatToParts(timestamp);
    const value = (type: string) => parts.find(part => part.type === type)!.value;
    return `${value("year")}-${value("month")}-${value("day")}`;
  }))].sort();
}

/** Names/metadata are cheap to revalidate; unchanged native bodies are never re-parsed by polling. */
export async function listActiveSessionFiles(
  project: Pick<ChatProjectContext, "sessionDir">,
): Promise<SessionInfo[]> {
  let names: string[];
  try { names = await readdir(project.sessionDir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const files = names.filter(name => name.endsWith(".jsonl"));
  const infos: SessionInfo[] = [];
  // Bound I/O; cold listings yield between files instead of synchronously parsing the whole archive.
  for (let offset = 0; offset < files.length; offset += 8) {
    const group = await Promise.all(files.slice(offset, offset + 8).map(async name => {
      try { return (await readFileSummary(resolve(project.sessionDir, name))).info; }
      catch { return undefined; } // Pi's discovery contract skips unreadable/invalid files.
    }));
    infos.push(...group.filter((info): info is SessionInfo => info !== undefined));
  }
  return infos.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/**
 * Resolve ONE active Session by exact id WITHOUT reading every sibling file's body.
 *
 * Session files are named `<timestamp>_<id>.jsonl`, so the directory LISTING (names only) already names
 * the candidate. The candidate is then opened and its id compared, so a renamed or foreign file can never
 * masquerade as this session; the metadata is built from that ONE file. Pi remains the source of truth:
 * a name that does not match the strict id shape falls back to Pi's full scan, which stays the only
 * authority for legacy names and for removed/restored lifecycle state.
 */
export async function findActiveSessionFile(
  project: Pick<ChatProjectContext, "sessionDir">,
  sessionId: string,
): Promise<SessionInfo | undefined> {
  const scanned = async () => (await listActiveSessionFiles(project)).find((candidate) => candidate.id === sessionId);
  if (!SESSION_FILE_ID_PATTERN.test(sessionId)) return await scanned();
  let names: string[];
  try {
    names = await readdir(project.sessionDir);
  } catch {
    return undefined;
  }
  const suffix = `_${sessionId}.jsonl`;
  for (const name of names.filter((candidate) => candidate.endsWith(suffix))) {
    const path = resolve(project.sessionDir, name);
    try {
      const { info } = await readFileSummary(path);
      // The file name is only a hint; Pi's own header remains the identity authority.
      if (info.id !== sessionId) continue;
      return info;
    } catch {
      // A single unreadable/foreign file must not hide the fallback scan.
      continue;
    }
  }
  return await scanned();
}

/** Resolves one Session ID only within this Project's active Session directory. */
export async function requireActiveSessionFile(
  project: Pick<ChatProjectContext, "sessionDir">,
  sessionId: string,
): Promise<SessionInfo> {
  if (sessionId.trim() === "") throw new Error("sessionId不能为空");
  const session = await findActiveSessionFile(project, sessionId);
  if (session === undefined) throw new Error(`找不到Session: ${sessionId}`);
  return session;
}
