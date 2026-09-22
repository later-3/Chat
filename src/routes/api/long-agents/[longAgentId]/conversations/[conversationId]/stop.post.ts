import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../../../chat-home.js";
import { conversationHttpError, locateConversationForHttp, readConversationBody } from "../../../../../../long-agents/conversations/http.js";
import { stopDiscussion } from "../../../../../../long-agents/conversations/discussions.js";

/** Owner-facing stop: the discussion stops queueing/dispatching further speeches. */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const namespace = getRouterParam(event, "longAgentId");
  const conversationId = getRouterParam(event, "conversationId", { decode: true });
  if (!namespace || !conversationId) throw createError({ statusCode: 400, statusMessage: "缺少群或 Friend 标识" });
  const body = await readConversationBody(event, ["discussionId", "reason"]);
  if (typeof body.discussionId !== "string" || body.discussionId.trim() === "")
    throw createError({ statusCode: 400, statusMessage: "需要 discussionId" });
  const home = resolveChatHome();
  try {
    const located = await locateConversationForHttp(home, conversationId, namespace);
    const discussion = await stopDiscussion({
      chatHome: home, storageProjectId: located.storageProjectId, conversationId,
      discussionId: body.discussionId,
      status: "stopped",
      stopReason: typeof body.reason === "string" && body.reason.trim() !== "" ? body.reason : "用户停止",
    });
    return { schemaVersion: 1, discussionId: discussion.discussionId, status: discussion.status, stopReason: discussion.stopReason };
  } catch (error) {
    conversationHttpError(error);
  }
});
