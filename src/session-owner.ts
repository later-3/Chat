import { projectLongAgentId } from "./long-agents/project-agent.js";
import { readLegacyFriendSessions } from "./migrations/agent-home-normalization.js";
import { resolveChatHome } from "./chat-home.js";
import { readLongAgentState } from "./long-agents/storage.js";

export async function readSessionOwnershipFacts(chatHome?: string) {
  try {
    const [state, legacy] = await Promise.all([readLongAgentState(chatHome), readLegacyFriendSessions(resolveChatHome(chatHome))]);
    return { state, legacy };
  } catch (cause) {
    throw new SessionOwnerResolutionError(cause);
  }
}
export type SessionOwnershipFacts = Awaited<ReturnType<typeof readSessionOwnershipFacts>>;

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
  snapshot?: SessionOwnershipFacts,
): Promise<ReadonlyMap<string, ChatSessionOwner>> {
  try {
    const { state, legacy: legacySessions } = snapshot ?? await readSessionOwnershipFacts(chatHome);
    const owners = new Map<string, ChatSessionOwner>();
    const add = (sessionId: string, longAgentId: string, bindingId: string) => {
      const previous = owners.get(sessionId);
      if (previous?.type === "long-agent" && previous.longAgentId !== longAgentId) throw new Error("Session存在多个Friend归属");
      owners.set(sessionId, { type: "long-agent", longAgentId, projectLongAgentId: bindingId });
    };
    for (const legacy of legacySessions) {
      if (legacy.longAgentId !== null && (legacy.sourceProjectId === projectId || legacy.targetProjectId === projectId)) add(legacy.sessionId, legacy.longAgentId, projectLongAgentId(projectId, legacy.longAgentId));
    }
    for (const entry of state.projectAgents) {
      if (entry.projectId === projectId) add(entry.primarySessionId, entry.longAgentId, entry.id);
    }
    for (const binding of state.projectSessions) {
      if (binding.projectId === projectId) add(binding.sessionId, binding.longAgentId, projectLongAgentId(projectId, binding.longAgentId));
    }
    for (const day of [...state.dailySessions, ...state.additionalSessions]) {
      if (day.longAgentId === projectId) add(day.sessionId, day.longAgentId, projectLongAgentId(projectId, day.longAgentId));
    }
    for (const node of state.nodeSessions) {
      if (node.longAgentId === projectId) add(node.sessionId, node.longAgentId, projectLongAgentId(projectId, node.longAgentId));
    }
    for (const work of state.works) {
      if (work.longAgentId === projectId) add(work.sessionId, work.longAgentId, work.id);
    }
    return owners;
  } catch (cause) {
    if (cause instanceof SessionOwnerResolutionError) throw cause;
    throw new SessionOwnerResolutionError(cause);
  }
}

export function chatSessionOwner(
  owners: ReadonlyMap<string, ChatSessionOwner>,
  sessionId: string,
): ChatSessionOwner {
  return owners.get(sessionId) ?? ORDINARY_SESSION_OWNER;
}

/** Native Home history remains conversational; business-project migration archives stay separate. */
export async function readWritableFriendSessionIds(chatHome?: string, snapshot?: SessionOwnershipFacts): Promise<ReadonlySet<string>> {
  const { state, legacy } = snapshot ?? await readSessionOwnershipFacts(chatHome);
  return new Set([...state.dailySessions.map(day => day.sessionId), ...state.additionalSessions.map(session => session.sessionId), ...state.works.map(work => work.sessionId),
    ...state.nodeSessions.map(node => node.sessionId), ...state.projectSessions.map(session => session.sessionId),
    ...legacy.filter(entry => entry.longAgentId !== null && entry.targetProjectId === entry.longAgentId).map(entry => entry.sessionId)]);
}
