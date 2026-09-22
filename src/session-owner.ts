import { agentDate } from "./long-agents/calendar.js";
import { projectLongAgentId } from "./long-agents/project-agent.js";
import { readLegacyFriendSessions } from "./migrations/agent-home-normalization.js";
import { resolveChatHome } from "./chat-home.js";
import { readLongAgentState } from "./long-agents/storage.js";

export type ChatSessionOwner =
  | { readonly type: "ordinary" }
  | {
      readonly type: "long-agent";
      readonly longAgentId: string;
      readonly projectLongAgentId: string;
    };

const ORDINARY_SESSION_OWNER: ChatSessionOwner = Object.freeze({ type: "ordinary" });

export class SessionOwnerResolutionError extends Error {
  constructor(cause: unknown) {
    super("无法读取Session归属状态", { cause });
    this.name = "SessionOwnerResolutionError";
  }
}

/** Reads the current Project-scoped Session ownership projection from Chat runtime state. */
export async function readChatSessionOwnerIndex(
  projectId: string,
  chatHome?: string,
): Promise<ReadonlyMap<string, ChatSessionOwner>> {
  try {
    const state = await readLongAgentState(chatHome);
    const owners = new Map<string, ChatSessionOwner>();
    const add = (sessionId: string, longAgentId: string, bindingId: string) => {
      const previous = owners.get(sessionId);
      if (previous?.type === "long-agent" && previous.longAgentId !== longAgentId) throw new Error("Session存在多个Friend归属");
      owners.set(sessionId, { type: "long-agent", longAgentId, projectLongAgentId: bindingId });
    };
    for (const legacy of await readLegacyFriendSessions(resolveChatHome(chatHome))) {
      if (legacy.longAgentId !== null && (legacy.sourceProjectId === projectId || legacy.targetProjectId === projectId)) add(legacy.sessionId, legacy.longAgentId, projectLongAgentId(projectId, legacy.longAgentId));
    }
    for (const entry of state.projectAgents) {
      if (entry.projectId === projectId) add(entry.primarySessionId, entry.longAgentId, entry.id);
    }
    for (const day of state.dailySessions) {
      if (day.longAgentId === projectId) add(day.sessionId, day.longAgentId, projectLongAgentId(projectId, day.longAgentId));
    }
    for (const work of state.works) {
      if (work.longAgentId === projectId) add(work.sessionId, work.longAgentId, work.id);
    }
    return owners;
  } catch (cause) {
    throw new SessionOwnerResolutionError(cause);
  }
}

export function chatSessionOwner(
  owners: ReadonlyMap<string, ChatSessionOwner>,
  sessionId: string,
): ChatSessionOwner {
  return owners.get(sessionId) ?? ORDINARY_SESSION_OWNER;
}

/** Only today's native Friend Session accepts direct conversation; legacy history never does. */
export async function readWritableFriendSessionIds(chatHome?: string): Promise<ReadonlySet<string>> {
  const state = await readLongAgentState(chatHome);
  return new Set([...state.dailySessions.filter((day) => day.date === agentDate(day.timeZone)).map((day) => day.sessionId), ...state.works.map(work => work.sessionId)]);
}
