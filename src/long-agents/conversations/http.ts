import { createError, readBody } from "nitro/h3";
import { ConversationError, type Conversation } from "./contract.js";
import { findConversation } from "./storage.js";

/** Map a service-layer conversation error to an HTTP status without leaking internals. */
export function conversationHttpError(error: unknown): never {
  if (error instanceof ConversationError) throw createError({ statusCode: error.statusCode, statusMessage: error.message });
  throw createError({ statusCode: 500, statusMessage: error instanceof Error ? error.message : "群操作失败" });
}

/** Strict body shape check: unknown fields are rejected so identity/scope cannot be smuggled in. */
export async function readConversationBody(event: Parameters<typeof readBody>[0], allowed: readonly string[]): Promise<Record<string, unknown>> {
  const body = await readBody<unknown>(event);
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw createError({ statusCode: 400, statusMessage: "请求必须是对象" });
  const value = body as Record<string, unknown>;
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw createError({ statusCode: 400, statusMessage: `未知字段：${unknown.join(", ")}` });
  return value;
}

export interface ConversationRoute {
  conversation: Conversation;
  storageProjectId: string;
  namespace: string;
}

/** Owner-facing lookup: the conversation is found server-side and the URL namespace must be a member. */
export async function locateConversationForHttp(
  chatHome: string,
  conversationId: string,
  namespace: string,
): Promise<ConversationRoute> {
  const { conversation, storageProjectId } = await findConversation(chatHome, conversationId);
  if (!conversation.members.some((member) => member.longAgentId === namespace))
    throw new ConversationError(404, "该 Friend 不属于这个群");
  return { conversation, storageProjectId, namespace };
}

export { conversationSummary } from "./contract.js";
