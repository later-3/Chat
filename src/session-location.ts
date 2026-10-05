import { resolveProjectContext } from "./projects/registry.js";
import { findActiveSessionFile } from "./session-files.js";
import { readRecoveredRemovedSessionIndex } from "./removed-session-index.js";
import { SessionLifecycleError } from "./session-errors.js";
import { resolveChatHome } from "./chat-home.js";
import type { ChatProjectContext } from "./projects/types.js";

/**
 * 目录位置即归属：普通会话在共享项目目录 `projects/<projectId>/sessions/`，
 * Long Agent 在绑定项目里创建的会话在其 Agent 项目树 `long-agents/<agentId>/projects/<projectId>/sessions/`。
 *
 * 所有会话生命周期操作（重命名、移除、恢复、永久删除）都必须先经过本模块定位会话文件，
 * 不允许按业务另写一套定位。绑定登记（`state.projectSessions`）是判定 owner 的唯一依据。
 */
export interface OwnedSessionLocation {
  readonly project: ChatProjectContext;
  /** 会话属主的 Long Agent；普通项目会话为 undefined。 */
  readonly ownerLongAgentId?: string;
  /** 会话在该存储根里的生命周期状态；恢复与永久删除针对的是 removed / purged。 */
  readonly state: "active" | "removed" | "purged";
}

async function projectForBinding(
  binding: { readonly projectId: string; readonly longAgentId: string },
  chatHome: string,
): Promise<ChatProjectContext> {
  return await resolveProjectContext(binding.projectId, chatHome, { ownerLongAgentId: binding.longAgentId });
}

/** 判定会话在某个存储根里的状态：活跃目录 → 移除区索引 → tombstone；两层都没有即不属于该根。 */
async function locateInProject(
  project: ChatProjectContext,
  sessionId: string,
): Promise<OwnedSessionLocation["state"] | undefined> {
  if (await findActiveSessionFile(project, sessionId) !== undefined) return "active";
  let index: Awaited<ReturnType<typeof readRecoveredRemovedSessionIndex>>;
  try {
    index = await readRecoveredRemovedSessionIndex(project);
  } catch {
    return undefined; // 索引不可读（含首次使用）时该根不持有此会话
  }
  if (index.sessions[sessionId] !== undefined) return "removed";
  if (index.tombstones[sessionId] !== undefined) return "purged";
  return undefined;
}

/**
 * 解析会话所在的存储根与生命周期状态：先查共享项目目录，未命中时按绑定登记回落到 Agent 项目树。
 * 活跃、已移除、已永久删除三种状态都能定位——恢复与永久删除本来就发生在移除区。
 */
export async function resolveOwnedSessionLocation(
  projectId: string,
  sessionId: string,
  chatHome?: string,
): Promise<OwnedSessionLocation> {
  const home = resolveChatHome(chatHome);
  const shared = await resolveProjectContext(projectId, home);
  const sharedState = await locateInProject(shared, sessionId);
  if (sharedState !== undefined) return { project: shared, state: sharedState };
  const { readLongAgentState } = await import("./long-agents/storage.js");
  const binding = (await readLongAgentState(home)).projectSessions
    .find((item) => item.sessionId === sessionId);
  if (binding === undefined) {
    throw new SessionLifecycleError("SESSION_NOT_FOUND", `找不到Session: ${sessionId}`);
  }
  const owned = await projectForBinding(binding, home);
  const ownedState = await locateInProject(owned, sessionId);
  if (ownedState === undefined) {
    throw new SessionLifecycleError("SESSION_NOT_FOUND", `找不到Session: ${sessionId}`);
  }
  return { project: owned, ownerLongAgentId: binding.longAgentId, state: ownedState };
}

/** 会话只需要存储根时（不需要 owner）的便捷形式。 */
export async function resolveOwnedSessionProject(
  projectId: string,
  sessionId: string,
  chatHome?: string,
): Promise<ChatProjectContext> {
  return (await resolveOwnedSessionLocation(projectId, sessionId, chatHome)).project;
}

/**
 * 列出该项目下可能持有会话的存储根：共享项目目录，加上所有在该项目登记过会话的 Long Agent 项目树。
 * 用于「按项目」的会话列举与移除区列举——移除区按项目天然存放，因此只需合并这些根。
 */
export async function listOwnedSessionRoots(
  projectId: string,
  chatHome?: string,
): Promise<readonly { readonly project: ChatProjectContext; readonly ownerLongAgentId?: string }[]> {
  const home = resolveChatHome(chatHome);
  const roots: { project: ChatProjectContext; ownerLongAgentId?: string }[] = [{ project: await resolveProjectContext(projectId, home) }];
  const { readLongAgentState } = await import("./long-agents/storage.js");
  const owners = new Set((await readLongAgentState(home)).projectSessions
    .filter((item) => item.projectId === projectId)
    .map((item) => item.longAgentId));
  for (const ownerLongAgentId of owners) {
    roots.push({ project: await projectForBinding({ projectId, longAgentId: ownerLongAgentId }, home), ownerLongAgentId });
  }
  return roots;
}
