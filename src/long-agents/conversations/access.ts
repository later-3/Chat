import { openChatSession } from "../../chat-session.js";
import { ConversationError, activeMember, type Conversation } from "./contract.js";
import { readConversation } from "./service.js";

/** Durable marker written into every participation Session when it is bound. */
export const GROUP_PARTICIPATION = "chat.group-participation.v1";
/** Durable marker written into a work's own independent Task Session. */
export const GROUP_WORK_SESSION = "chat.group-work-session.v1";

export interface ParticipationBinding {
  /** Which group Session this is: a member's participation Session or a work's Task Session. */
  kind: "participation" | "work";
  conversationId: string;
  storageProjectId: string;
  longAgentId: string;
  participationEpoch: number;
  boundAt: string;
}

export function participationBindingOf(entries: readonly { type: string; customType?: string; data?: unknown }[]): ParticipationBinding | null {
  for (const entry of entries) {
    const kind = entry.type === "custom" && entry.customType === GROUP_PARTICIPATION ? "participation"
      : entry.type === "custom" && entry.customType === GROUP_WORK_SESSION ? "work" : null;
    if (kind === null) continue;
    const value = entry.data;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ConversationError(500, "群参与绑定损坏");
    const body = value as Record<string, unknown>;
    return {
      kind,
      conversationId: String(body.conversationId),
      storageProjectId: String(body.storageProjectId),
      longAgentId: String(body.longAgentId),
      participationEpoch: Number(body.participationEpoch),
      boundAt: String(body.boundAt),
    };
  }
  return null;
}

export type SessionRequester = { kind: "owner" } | { kind: "friend"; longAgentId: string };

/**
 * Read authorization for one Session, applied at the shared read entry so ordinary detail/history/
 * event-stream paths cannot bypass the group projection.
 *
 * - A Session without a participation binding is unaffected.
 * - A group participation Session is readable by the local owner, and by a Friend only while that
 *   Friend is still an active member of the same conversation, in the same participation period,
 *   with this Session as its current one. Revocation, re-joining (new epoch) or another Friend's
 *   Session ID therefore cannot be used to read private content — history stays readable only for
 *   readers that still hold permission.
 */
export async function assertParticipantSessionReadable(input: {
  chatHome: string;
  storageProjectId: string;
  sessionId: string;
  requester: SessionRequester;
}): Promise<{ participation: ParticipationBinding | null; conversation: Conversation | null }> {
  const session = await openChatSession({ chatHome: input.chatHome, projectId: input.storageProjectId, sessionId: input.sessionId });
  const binding = participationBindingOf(session.manager.getEntries());
  if (binding === null) return { participation: null, conversation: null };
  if (input.requester.kind === "owner") return { participation: binding, conversation: await readConversation(input.chatHome, binding.storageProjectId, binding.conversationId) };
  const conversation = await readConversation(input.chatHome, binding.storageProjectId, binding.conversationId);
  if (input.requester.longAgentId !== binding.longAgentId)
    throw new ConversationError(403, "该 Session 属于另一位参与者的群参与上下文，拒绝读取");
  const member = activeMember(conversation, binding.longAgentId);
  if (member === null) throw new ConversationError(403, "成员资格已撤销，历史不再对原参与者开放");
  if (member.participationEpoch !== binding.participationEpoch)
    throw new ConversationError(403, "参与期已变化，旧参与 Session 的历史不再开放");
  // A work's Task Session is not the member's participation Session: a Friend never reads it through
  // a generic entry; the owner still can, under the same re-verified authorization.
  if (binding.kind === "work" || member.sessionId !== input.sessionId)
    throw new ConversationError(403, "该 Session 已不是当前参与 Session，拒绝读取");
  return { participation: binding, conversation };
}
