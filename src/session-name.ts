import { chatSessionOwner, readChatSessionOwnerIndex, readWritableFriendSessionIds } from "./session-owner.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveProjectContext } from "./projects/registry.js";
import { resolveChatHome } from "./chat-home.js";
import { assertChatSessionIsIdle } from "./session-activity.js";
import { requireActiveChatSessionFile } from "./session-state.js";
import { SessionLifecycleError } from "./session-errors.js";
import {
  chatSessionOperationKey,
  withChatSessionOperationLock,
} from "./session-operation-lock.js";

/**
 * 目录位置即归属：Long Agent 在绑定项目里创建的会话存在其 Agent 项目树（owner 解析），
 * 普通项目会话仍在 shared 项目目录。重命名必须解析到会话真正所在的那棵树。
 */
async function resolveWritableSessionProject(projectId: string, sessionId: string, chatHome?: string) {
  const home = resolveChatHome(chatHome);
  const project = await resolveProjectContext(projectId, home);
  try {
    await requireActiveChatSessionFile(project, sessionId);
    return { project };
  } catch (error) {
    if (!(error instanceof SessionLifecycleError) || error.code !== "SESSION_NOT_FOUND") throw error;
    const { readLongAgentState } = await import("./long-agents/storage.js");
    const binding = (await readLongAgentState(home)).projectSessions.find((item) => item.sessionId === sessionId);
    if (binding === undefined) throw error;
    const owned = await resolveProjectContext(binding.projectId, home, { ownerLongAgentId: binding.longAgentId });
    await requireActiveChatSessionFile(owned, sessionId);
    return { project: owned };
  }
}

export async function renameChatSession(
  projectId: string,
  sessionId: string,
  name: string,
  chatHome?: string,
): Promise<{ readonly sessionId: string; readonly name: string | null }> {
  if (name.length > 200) throw new Error("Session名称不能超过200个字符");
  const resolved = await resolveWritableSessionProject(projectId, sessionId, chatHome);
  const project = resolved.project;
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
