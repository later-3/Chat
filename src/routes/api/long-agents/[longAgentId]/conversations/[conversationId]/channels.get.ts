import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../../../chat-home.js";
import { conversationHttpError, locateConversationForHttp } from "../../../../../../long-agents/conversations/http.js";
import { listConversationChannels, readConversationDeliveries } from "../../../../../../long-agents/conversations/channel.js";

/** Owner-facing view of a group's external channel bindings and delivery state. */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const namespace = getRouterParam(event, "longAgentId");
  const conversationId = getRouterParam(event, "conversationId", { decode: true });
  if (!namespace || !conversationId) throw createError({ statusCode: 400, statusMessage: "缺少群或 Friend 标识" });
  const home = resolveChatHome();
  try {
    const { storageProjectId } = await locateConversationForHttp(home, conversationId, namespace);
    return {
      schemaVersion: 1,
      bindings: await listConversationChannels(home, storageProjectId, conversationId),
      deliveries: await readConversationDeliveries(home, storageProjectId, conversationId),
    };
  } catch (error) {
    conversationHttpError(error);
  }
});
