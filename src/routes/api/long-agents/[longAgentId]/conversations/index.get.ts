import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../../chat-home.js";
import { conversationHttpError, conversationSummary } from "../../../../../long-agents/conversations/http.js";
import { listConversations } from "../../../../../long-agents/conversations/service.js";

/** Owner-facing list of the groups visible in one Friend's namespace and storage Project. */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const namespace = getRouterParam(event, "longAgentId");
  const query = getQuery(event);
  const storageProjectId = query.storageProjectId;
  if (!namespace) throw createError({ statusCode: 400, statusMessage: "缺少 Friend 标识" });
  if (typeof storageProjectId !== "string" || storageProjectId.trim() === "")
    throw createError({ statusCode: 400, statusMessage: "需要 storageProjectId" });
  try {
    const conversations = await listConversations(resolveChatHome(), storageProjectId);
    return {
      schemaVersion: 1,
      conversations: conversations
        .filter((conversation) => conversation.members.some((member) => member.longAgentId === namespace))
        .map(conversationSummary),
    };
  } catch (error) {
    conversationHttpError(error);
  }
});
