import { createError, defineEventHandler, getRouterParam, setResponseHeader, setResponseStatus } from "nitro/h3";
import { resolveChatHome } from "../../../../../../chat-home.js";
import { conversationHttpError, locateConversationForHttp, readConversationBody } from "../../../../../../long-agents/conversations/http.js";
import {
  cancelConversationWork,
  drainConversationWorks,
  startConversationWork,
} from "../../../../../../long-agents/conversations/work.js";

/**
 * Owner-facing group background work: `start` creates a work from a verified public origin, `cancel`
 * stops a queued/running one. Execution is drained by the Backend worker, not by this connection.
 */
export default defineEventHandler(async (event) => {
  const namespace = getRouterParam(event, "longAgentId");
  const conversationId = getRouterParam(event, "conversationId", { decode: true });
  if (!namespace || !conversationId) throw createError({ statusCode: 400, statusMessage: "缺少群或 Friend 标识" });
  const body = await readConversationBody(event, ["action", "requestId", "title", "instruction", "originEntryId", "longAgentId", "workId", "source", "discussionId"]);
  const home = resolveChatHome();
  try {
    const located = await locateConversationForHttp(home, conversationId, namespace);
    if (body.action === "start") {
      if (typeof body.requestId !== "string" || typeof body.title !== "string" || typeof body.instruction !== "string" || typeof body.longAgentId !== "string")
        throw createError({ statusCode: 400, statusMessage: "start 需要 requestId/title/instruction/longAgentId" });
      const result = await startConversationWork({
        chatHome: home, storageProjectId: located.storageProjectId, conversationId,
        longAgentId: body.longAgentId, requestId: body.requestId, title: body.title, instruction: body.instruction,
        source: body.source === "discussion" ? "discussion" : "user",
        ...(body.discussionId === undefined || body.discussionId === null ? {} : { discussionId: String(body.discussionId) }),
        originEntryId: body.originEntryId === undefined || body.originEntryId === null ? null : String(body.originEntryId),
      });
      setResponseStatus(event, result.created ? 201 : 200);
      setResponseHeader(event, "Cache-Control", "no-store");
      void drainConversationWorks({ chatHome: home, storageProjectId: located.storageProjectId, conversationId })
        .catch((error: unknown) => console.error("群任务队列执行失败", error));
      return { schemaVersion: 1, created: result.created, work: result.work };
    }
    if (body.action === "cancel") {
      if (typeof body.workId !== "string") throw createError({ statusCode: 400, statusMessage: "cancel 需要 workId" });
      return { schemaVersion: 1, work: await cancelConversationWork({
        chatHome: home, storageProjectId: located.storageProjectId, conversationId, workId: body.workId,
      }) };
    }
    throw createError({ statusCode: 400, statusMessage: "action 必须是 start/cancel" });
  } catch (error) {
    conversationHttpError(error);
  }
});
