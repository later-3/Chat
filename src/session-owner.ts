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
    return new Map(state.projectAgents.flatMap((projectAgent) => (
      projectAgent.projectId === projectId
        ? [[projectAgent.primarySessionId, {
            type: "long-agent" as const,
            longAgentId: projectAgent.longAgentId,
            projectLongAgentId: projectAgent.id,
          }] as const]
        : []
    )));
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
