import { activeMember, ConversationError, type Conversation } from "./contract.js";
import { LongAgentScopeError, type LongAgentScope } from "../scope.js";
import { readConversationPublicMessages, type ConversationPublicMessage } from "./publication.js";
import { readConversation } from "./service.js";

/**
 * Trusted identity for a group public stream.
 *
 * There is deliberately no `string | null` form, because "no parameter means owner" lets any caller
 * obtain the owner projection by omission:
 *
 * - `owner` is produced only by the owner-facing server entry (`ownerConversationStreamViewer`),
 *   which is the same trust level as the rest of the local owner API. It is never derived from
 *   request input, so a member hint in a query string can neither select nor omit another reader.
 * - `member` is produced only from a Backend-resolved conversation scope
 *   (`memberConversationStreamViewerFromScope`), which carries the participant and the group the
 *   scope was resolved for. The viewer is re-checked against stored membership on every tick and
 *   every reconnect.
 */
export type ConversationStreamViewer =
  | { readonly kind: "owner" }
  | { readonly kind: "member"; readonly longAgentId: string; readonly conversationId: string };

/** The owner entry's viewer. Only owner-facing server entries call this. */
export function ownerConversationStreamViewer(): ConversationStreamViewer {
  return { kind: "owner" };
}

/**
 * Build a member viewer from a Backend-resolved conversation scope. A scope already binds the
 * longAgentId, the conversation and the authorization revision, so callers cannot substitute another
 * Friend id, and a scope resolved for another group cannot be reused here.
 */
export function memberConversationStreamViewerFromScope(scope: LongAgentScope): ConversationStreamViewer {
  const conversationId = scope.authorization.conversationId;
  if (scope.kind !== "conversation" || conversationId === null || conversationId === "")
    throw new LongAgentScopeError("只有已解析的群参与作用域可以构造成员公共流身份");
  return { kind: "member", longAgentId: scope.authorization.longAgentId, conversationId };
}

/** Authorization for a group stream, re-evaluated on every tick and on every reconnect. */
export function streamViewerAuthorized(
  conversation: Conversation,
  viewer: ConversationStreamViewer,
): { authorized: boolean; reason: string | null } {
  if (conversation.lifecycle === "archived") return { authorized: false, reason: "群已归档" };
  if (viewer.kind === "owner") return { authorized: true, reason: null };
  if (viewer.conversationId !== conversation.id) return { authorized: false, reason: "作用域与该群不一致" };
  if (activeMember(conversation, viewer.longAgentId) === null) return { authorized: false, reason: "成员资格已撤销" };
  return { authorized: true, reason: null };
}

async function authorizedMessages(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  viewer: ConversationStreamViewer;
}): Promise<{ messages: ConversationPublicMessage[]; reason: string | null }> {
  const conversation = await readConversation(input.chatHome, input.storageProjectId, input.conversationId);
  const authorization = streamViewerAuthorized(conversation, input.viewer);
  if (!authorization.authorized) return { messages: [], reason: authorization.reason };
  return {
    messages: await readConversationPublicMessages({
      chatHome: input.chatHome, storageProjectId: input.storageProjectId, conversationId: input.conversationId,
      viewerLongAgentId: input.viewer.kind === "owner" ? null : input.viewer.longAgentId,
    }),
    reason: null,
  };
}

/**
 * One stream tick. Only published references (`seq > afterSeq`) and, on the first tick, the user's
 * own messages are returned; private reasoning and tool output are never part of this stream. When
 * the viewer loses authorization the stream is closed instead of continuing to serve restricted data.
 */
export async function readConversationStreamTick(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  viewer: ConversationStreamViewer;
  /** Number of public messages already delivered; `-1` asks for a full snapshot. */
  afterCursor: number;
}): Promise<{ events: ConversationStreamEvent[]; nextCursor: number; closed: boolean }> {
  const { messages, reason } = await authorizedMessages(input);
  if (reason !== null)
    return { events: [{ type: "revoked", cursor: input.afterCursor, reason }], nextCursor: input.afterCursor, closed: true };
  const nextCursor = messages.length;
  if (input.afterCursor < 0 || input.afterCursor > messages.length) {
    // The stored cursor predates a tombstone or a rebuilt public root: send a full snapshot instead
    // of silently skipping or duplicating messages.
    return { events: [{ type: "reset", cursor: nextCursor, messages }], nextCursor, closed: false };
  }
  // Every public message kind (user message and publication) advances the same cursor, so new user
  // messages arriving after the connection opened are delivered incrementally.
  const pending = messages.filter((message) => message.cursor > input.afterCursor);
  return { events: pending.map((message) => ({ type: "message", cursor: message.cursor, message })), nextCursor, closed: false };
}

/** Reconnect / history read: the same authorization is checked again before anything is returned. */
export async function readConversationStreamSnapshot(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  viewer: ConversationStreamViewer;
}): Promise<ConversationPublicMessage[]> {
  const { messages, reason } = await authorizedMessages(input);
  if (reason !== null) throw new ConversationError(403, reason);
  return messages;
}

export interface ConversationStreamEvent {
  type: "message" | "reset" | "revoked";
  cursor: number;
  message?: ConversationPublicMessage;
  /** Present on `reset`: the full authorized snapshot after the stored cursor became invalid. */
  messages?: ConversationPublicMessage[];
  reason?: string;
}
