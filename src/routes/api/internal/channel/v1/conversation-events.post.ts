import { createError, defineEventHandler, readBody, setResponseStatus } from "nitro/h3";
import { resolveChatHome } from "../../../../../chat-home.js";
import { acceptConversationInboundMessage, findConversationChannelBinding } from "../../../../../long-agents/conversations/channel.js";
import { ConversationError } from "../../../../../long-agents/conversations/contract.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string, max = 200): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) throw new Error(`外部群事件缺少${label}`);
  return value;
}

/**
 * Trusted NanoClaw ingress for external group messages. Service authentication is enforced by the
 * existing Channel middleware; the body only supplies identities from the platform adapter.
 *
 * An event can only route to an existing active binding (never create an owner or widen authorization),
 * is deduplicated by stable external event/message identity, and drops the Friend's own echo. 202 means
 * the inbound was durably recorded; it does not mean a Friend answered or the platform user received
 * anything.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<unknown>(event);
  if (!isRecord(body) || body.schemaVersion !== 1 || !Array.isArray(body.events) || body.events.length === 0 || body.events.length > 200) {
    throw createError({ statusCode: 400, statusMessage: "外部群事件请求无效" });
  }
  const home = resolveChatHome();
  try {
    const results = [];
    for (const raw of body.events) {
      if (!isRecord(raw)) throw new Error("外部群事件必须是对象");
      const bindingId = requiredString(raw.bindingId, "bindingId");
      const located = await findConversationChannelBinding(home, bindingId);
      if (located === null) {
        results.push({ eventId: raw.eventId ?? null, accepted: false, appended: false, entryId: null, reason: "外部目标未绑定，拒绝接收" });
        continue;
      }
      const result = await acceptConversationInboundMessage({
        chatHome: home, storageProjectId: located.storageProjectId, conversationId: located.conversationId,
        bindingId,
        senderExternalId: requiredString(raw.senderExternalId, "senderExternalId"),
        senderDisplayName: raw.senderDisplayName === null || raw.senderDisplayName === undefined ? null : String(raw.senderDisplayName),
        text: requiredString(raw.text, "text", 100_000),
        externalMessageId: requiredString(raw.externalMessageId, "externalMessageId"),
        eventId: requiredString(raw.eventId, "eventId"),
      });
      results.push({ eventId: raw.eventId, ...result });
    }
    setResponseStatus(event, 202);
    return { schemaVersion: 1, results };
  } catch (error) {
    throw createError({
      statusCode: error instanceof ConversationError ? error.statusCode : 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
