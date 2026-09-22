import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../../../chat-home.js";
import { conversationHttpError, locateConversationForHttp } from "../../../../../../long-agents/conversations/http.js";
import { listConversationWorks } from "../../../../../../long-agents/conversations/work-store.js";

/** Owner-facing group background work list (independent of discussion rounds). */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const namespace = getRouterParam(event, "longAgentId");
  const conversationId = getRouterParam(event, "conversationId", { decode: true });
  if (!namespace || !conversationId) throw createError({ statusCode: 400, statusMessage: "缺少群或 Friend 标识" });
  try {
    const { storageProjectId } = await locateConversationForHttp(resolveChatHome(), conversationId, namespace);
    return { schemaVersion: 1, works: await listConversationWorks(resolveChatHome(), storageProjectId, conversationId) };
  } catch (error) {
    conversationHttpError(error);
  }
});
