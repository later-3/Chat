import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import type { ChatProjectContext } from "./projects/types.js";
import { SessionLifecycleError } from "./session-errors.js";
import { listActiveSessionFiles } from "./session-files.js";
import { findInactiveChatSessionState } from "./removed-session-index.js";

/** Resolves active content access and reports removed/purged states consistently. */
export async function requireActiveChatSessionFile(
  project: Pick<ChatProjectContext, "sessionDir">,
  sessionId: string,
): Promise<SessionInfo> {
  if (sessionId.trim() === "") throw new Error("sessionId不能为空");
  const active = (await listActiveSessionFiles(project)).find((candidate) => candidate.id === sessionId);
  if (active !== undefined) return active;
  const inactive = await findInactiveChatSessionState(project, sessionId);
  if (inactive === "removed") {
    throw new SessionLifecycleError("SESSION_REMOVED", `Session已移入Session移除区: ${sessionId}`);
  }
  if (inactive === "purged") {
    throw new SessionLifecycleError("SESSION_PURGED", `Session已被永久删除: ${sessionId}`);
  }
  // Reading the index may have completed an interrupted restore after the
  // first active-directory scan. Re-scan once before reporting absence.
  const recovered = (await listActiveSessionFiles(project)).find((candidate) => candidate.id === sessionId);
  if (recovered !== undefined) return recovered;
  throw new SessionLifecycleError("SESSION_NOT_FOUND", `找不到Session: ${sessionId}`);
}
