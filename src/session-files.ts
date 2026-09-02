import { dirname, resolve } from "node:path";
import {
  SessionManager,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type { ChatProjectContext } from "./projects/types.js";

export const REMOVED_SESSION_DIRECTORY_NAME = "removed";

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

/** Resolves one Session ID only within this Project's active Session directory. */
export async function requireActiveSessionFile(
  project: Pick<ChatProjectContext, "sessionDir">,
  sessionId: string,
): Promise<SessionInfo> {
  if (sessionId.trim() === "") throw new Error("sessionId不能为空");
  const session = (await listActiveSessionFiles(project)).find((candidate) => candidate.id === sessionId);
  if (session === undefined) throw new Error(`找不到Session: ${sessionId}`);
  return session;
}
