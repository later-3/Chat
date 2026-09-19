import { chatSessionOwner, readChatSessionOwnerIndex, readWritableFriendSessionIds } from "./session-owner.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveProjectContext } from "./projects/registry.js";
import { assertChatSessionIsIdle } from "./session-activity.js";
import { requireActiveChatSessionFile } from "./session-state.js";
import {
  chatSessionOperationKey,
  withChatSessionOperationLock,
} from "./session-operation-lock.js";

export async function renameChatSession(
  projectId: string,
  sessionId: string,
  name: string,
  chatHome?: string,
): Promise<{ readonly sessionId: string; readonly name: string | null }> {
  if (name.length > 200) throw new Error("Session名称不能超过200个字符");
  const project = await resolveProjectContext(projectId, chatHome);
  return withChatSessionOperationLock(chatSessionOperationKey(projectId, sessionId), async () => {
    const owner = chatSessionOwner(await readChatSessionOwnerIndex(projectId, chatHome), sessionId);
    if (owner.type === "long-agent" && !(await readWritableFriendSessionIds(chatHome)).has(sessionId)) throw new Error("Friend历史会话只读，不能重命名");
    await assertChatSessionIsIdle(project, sessionId);
    const info = await requireActiveChatSessionFile(project, sessionId);
    const manager = SessionManager.open(info.path, project.sessionDir);
    manager.appendSessionInfo(name);
    manager.flush();
    return { sessionId, name: manager.getSessionName() ?? null };
  });
}
