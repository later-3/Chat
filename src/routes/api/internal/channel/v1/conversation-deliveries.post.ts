import { createError, defineEventHandler, readBody, setResponseStatus } from "nitro/h3";
import { resolveChatHome } from "../../../../../chat-home.js";
import { confirmConversationDelivery, findConversationDelivery } from "../../../../../long-agents/conversations/channel.js";
import { ConversationError } from "../../../../../long-agents/conversations/contract.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Trusted NanoClaw delivery receipt. Service authentication is enforced by the existing Channel
 * middleware. Only a platform-confirmed receipt moves a delivery to `delivered`; HTTP persistence at
 * NanoClaw alone must never be treated as platform delivery.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<unknown>(event);
  if (!isRecord(body) || body.schemaVersion !== 1 || !Array.isArray(body.receipts) || body.receipts.length === 0 || body.receipts.length > 200) {
    throw createError({ statusCode: 400, statusMessage: "外部投递回执请求无效" });
  }
  const home = resolveChatHome();
  try {
    const results = [];
    for (const raw of body.receipts) {
      if (!isRecord(raw) || (raw.status !== "delivered" && raw.status !== "failed") || typeof raw.deliveryId !== "string" || raw.deliveryId.trim() === "")
        throw new Error("投递回执无效");
      const located = await findConversationDelivery(home, raw.deliveryId);
      if (located === null) throw new Error(`找不到外部投递记录：${raw.deliveryId}`);
      const confirmed = await confirmConversationDelivery({
        chatHome: home, storageProjectId: located.storageProjectId, conversationId: located.conversationId,
        deliveryId: raw.deliveryId, status: raw.status,
        ...(raw.platformMessageId === undefined || raw.platformMessageId === null ? {} : { platformMessageId: String(raw.platformMessageId) }),
        ...(raw.error === undefined || raw.error === null ? {} : { error: String(raw.error) }),
      });
      results.push({ deliveryId: confirmed.deliveryId, status: confirmed.status });
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
