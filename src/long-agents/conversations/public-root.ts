import { openChatSession } from "../../chat-session.js";
import { chatSessionOperationKey, withChatSessionOperationLock } from "../../session-operation-lock.js";
import { ConversationError } from "./contract.js";
import { readConversation } from "./service.js";

export const GROUP_USER_MESSAGE = "chat.group-user-message.v1";

export interface ConversationUserMessage {
  conversationId: string;
  clientMessageId: string;
  entryId: string;
  text: string;
  postedAt: string;
}

function readUserMessages(entries: readonly { type: string; customType?: string; data?: unknown }[]): ConversationUserMessage[] {
  const messages: ConversationUserMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== GROUP_USER_MESSAGE) continue;
    const value = entry.data;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ConversationError(500, "群用户消息记录损坏");
    const body = value as Record<string, unknown>;
    messages.push({
      conversationId: String(body.conversationId),
      clientMessageId: String(body.clientMessageId),
      entryId: String(body.entryId),
      text: String(body.text),
      postedAt: String(body.postedAt),
    });
  }
  return messages;
}

/**
 * Append one user message to the group's public root.
 *
 * The write is idempotent per `clientMessageId` and happens entirely inside the public-root
 * operation lock, so a retried request (lost response, reconnect) never appends a second copy and
 * never re-triggers a discussion. The public order itself is the native user message plus published
 * references; this marker only records the idempotency key.
 */
export async function appendConversationUserMessage(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  clientMessageId: string;
  text: string;
}): Promise<{ message: ConversationUserMessage; created: boolean }> {
  if (!input.clientMessageId.trim() || input.clientMessageId.length > 256) throw new ConversationError(400, "用户消息需要有效 clientMessageId");
  if (input.text.trim() === "" || input.text.length > 100_000) throw new ConversationError(400, "用户消息正文无效");
  const conversation = await readConversation(input.chatHome, input.storageProjectId, input.conversationId);
  if (conversation.lifecycle === "archived") throw new ConversationError(409, "群已归档，不能继续发言");
  return withChatSessionOperationLock(chatSessionOperationKey(input.storageProjectId, conversation.publicSessionId), async () => {
    const reopened = await openChatSession({ chatHome: input.chatHome, projectId: input.storageProjectId, sessionId: conversation.publicSessionId });
    const existing = readUserMessages(reopened.manager.getEntries()).find((message) => message.clientMessageId === input.clientMessageId);
    if (existing !== undefined) return { message: existing, created: false };
    reopened.manager.appendMessage({ role: "user", content: input.text, timestamp: Date.now() });
    reopened.manager.flush();
    const entry = reopened.manager.getEntries().at(-1);
    if (entry === undefined || entry.type !== "message") throw new ConversationError(500, "用户消息写入失败");
    const message: ConversationUserMessage = {
      conversationId: input.conversationId,
      clientMessageId: input.clientMessageId,
      entryId: entry.id,
      text: input.text,
      postedAt: new Date(entry.timestamp ?? Date.now()).toISOString(),
    };
    reopened.manager.appendCustomEntry(GROUP_USER_MESSAGE, message);
    reopened.manager.flush();
    return { message, created: true };
  });
}

export async function readConversationUserMessages(chatHome: string, storageProjectId: string, conversationId: string): Promise<ConversationUserMessage[]> {
  const conversation = await readConversation(chatHome, storageProjectId, conversationId);
  const session = await openChatSession({ chatHome, projectId: storageProjectId, sessionId: conversation.publicSessionId });
  return readUserMessages(session.manager.getEntries());
}
