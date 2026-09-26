import { readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  SessionManager,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
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

/** Pi's list sentinel is first-user-only; Chat needs the first human or Agent utterance. */
export function firstSessionUtterance(info: SessionInfo): string {
  const entries = SessionManager.open(info.path, dirname(info.path)).getEntries();
  for (const entry of entries) {
    if (entry.type === "message") {
      const text = messageUtteranceText(entry.message);
      if (text !== "") return text;
    }
  }
  return info.firstMessage === "(no messages)" ? "" : info.firstMessage;
}

/** Pi remains the source of truth for active Session discovery and metadata. */
export function listActiveSessionFiles(
  project: Pick<ChatProjectContext, "sessionDir">,
): Promise<SessionInfo[]> {
  return SessionManager.listAll(project.sessionDir);
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
      const manager = SessionManager.open(path, project.sessionDir);
      // Identity check first: the file name is a hint, the Session's own id is the fact.
      if (manager.getSessionId() !== sessionId) continue;
      const header = manager.getHeader();
      const modified = (await stat(path)).mtime;
      const entries = manager.getEntries();
      const messageCount = entries.filter((entry) => entry.type === "message").length;
      const name = manager.getSessionName();
      const parentSession = header?.parentSession;
      const info: SessionInfo = {
        path,
        id: sessionId,
        cwd: manager.getCwd(),
        ...(name === undefined || name === null ? {} : { name }),
        ...(parentSession === undefined ? {} : { parentSessionPath: parentSession }),
        created: header === null ? modified : new Date(header.timestamp),
        modified,
        messageCount,
        firstMessage: firstSessionUtterance({ path, id: sessionId, cwd: manager.getCwd(), created: modified,
          modified, messageCount, firstMessage: "", allMessagesText: "" }),
        allMessagesText: "",
      };
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
