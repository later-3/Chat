import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../../../chat-home.js";
import { conversationHttpError, conversationSummary, locateConversationForHttp, readConversationBody } from "../../../../../../long-agents/conversations/http.js";
import { archiveConversation } from "../../../../../../long-agents/conversations/service.js";

/** Owner-facing archive: ends new participation turns and closes every live public stream. */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const namespace = getRouterParam(event, "longAgentId");
  const conversationId = getRouterParam(event, "conversationId", { decode: true });
  if (!namespace || !conversationId) throw createError({ statusCode: 400, statusMessage: "缺少群或 Friend 标识" });
  const body = await readConversationBody(event, ["expectedRevision"]);
  if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 1)
    throw createError({ statusCode: 400, statusMessage: "需要 expectedRevision（CAS）" });
  const home = resolveChatHome();
  try {
    const located = await locateConversationForHttp(home, conversationId, namespace);
    return conversationSummary(await archiveConversation({
      chatHome: home, storageProjectId: located.storageProjectId, conversationId,
      expectedRevision: body.expectedRevision as number,
    }));
  } catch (error) {
    conversationHttpError(error);
  }
});
