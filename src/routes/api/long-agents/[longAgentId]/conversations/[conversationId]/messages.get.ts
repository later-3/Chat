import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../../../chat-home.js";
import { conversationHttpError, locateConversationForHttp } from "../../../../../../long-agents/conversations/http.js";
import { readConversationPublicMessages } from "../../../../../../long-agents/conversations/publication.js";
import { readConversationUserMessages } from "../../../../../../long-agents/conversations/public-root.js";

/** Owner-facing authorized public projection of one group: user messages plus published references. */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const namespace = getRouterParam(event, "longAgentId");
  const conversationId = getRouterParam(event, "conversationId", { decode: true });
  if (!namespace || !conversationId) throw createError({ statusCode: 400, statusMessage: "缺少群或 Friend 标识" });
  const home = resolveChatHome();
  try {
    const { storageProjectId } = await locateConversationForHttp(home, conversationId, namespace);
    const messages = await readConversationPublicMessages({
      chatHome: home, storageProjectId, conversationId, viewerLongAgentId: null,
    });
    return {
      schemaVersion: 1,
      messages,
      userMessages: await readConversationUserMessages(home, storageProjectId, conversationId),
    };
  } catch (error) {
    conversationHttpError(error);
  }
});
