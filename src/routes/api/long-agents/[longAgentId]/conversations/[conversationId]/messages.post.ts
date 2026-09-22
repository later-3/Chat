import { createError, defineEventHandler, getRouterParam, setResponseHeader, setResponseStatus } from "nitro/h3";
import { resolveChatHome } from "../../../../../../chat-home.js";
import { conversationHttpError, locateConversationForHttp, readConversationBody } from "../../../../../../long-agents/conversations/http.js";
import { appendConversationUserMessage } from "../../../../../../long-agents/conversations/public-root.js";

/** Owner-facing user message append into the public root; idempotent per clientMessageId. */
export default defineEventHandler(async (event) => {
  const namespace = getRouterParam(event, "longAgentId");
  const conversationId = getRouterParam(event, "conversationId", { decode: true });
  if (!namespace || !conversationId) throw createError({ statusCode: 400, statusMessage: "缺少群或 Friend 标识" });
  const body = await readConversationBody(event, ["clientMessageId", "text"]);
  if (typeof body.clientMessageId !== "string" || body.clientMessageId.trim() === "")
    throw createError({ statusCode: 400, statusMessage: "需要 clientMessageId" });
  if (typeof body.text !== "string") throw createError({ statusCode: 400, statusMessage: "需要 text" });
  const home = resolveChatHome();
  try {
    const located = await locateConversationForHttp(home, conversationId, namespace);
    const result = await appendConversationUserMessage({
      chatHome: home, storageProjectId: located.storageProjectId, conversationId,
      clientMessageId: body.clientMessageId, text: body.text,
    });
    setResponseStatus(event, result.created ? 201 : 200);
    setResponseHeader(event, "Cache-Control", "no-store");
    return { schemaVersion: 1, created: result.created, message: result.message };
  } catch (error) {
    conversationHttpError(error);
  }
});
