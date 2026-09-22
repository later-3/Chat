import { createError, defineEventHandler, getRouterParam, setResponseHeader, setResponseStatus } from "nitro/h3";
import { randomUUID } from "node:crypto";
import { resolveChatHome } from "../../../../../../chat-home.js";
import { conversationHttpError, locateConversationForHttp, readConversationBody } from "../../../../../../long-agents/conversations/http.js";
import { ConversationError } from "../../../../../../long-agents/conversations/contract.js";
import { startConversationConsultation } from "../../../../../../workflows/group-discussion/index.js";

/**
 * Owner-facing start of one bounded A→B→A consultation. Both Friends must be current members; the
 * durable Workflow is the single orchestration entry.
 */
export default defineEventHandler(async (event) => {
  const namespace = getRouterParam(event, "longAgentId");
  const conversationId = getRouterParam(event, "conversationId", { decode: true });
  if (!namespace || !conversationId) throw createError({ statusCode: 400, statusMessage: "缺少群或 Friend 标识" });
  const body = await readConversationBody(event, ["discussionId", "fromLongAgentId", "toLongAgentId", "question", "depth"]);
  const discussionId = body.discussionId === undefined ? `disc-${randomUUID()}` : String(body.discussionId);
  for (const field of ["fromLongAgentId", "toLongAgentId", "question"] as const) {
    if (typeof body[field] !== "string" || String(body[field]).trim() === "")
      throw createError({ statusCode: 400, statusMessage: `需要 ${field}` });
  }
  const home = resolveChatHome();
  try {
    const located = await locateConversationForHttp(home, conversationId, namespace);
    if (located.conversation.lifecycle === "archived") throw new ConversationError(409, "群已归档，不能发起请教");
    const run = await startConversationConsultation({
      chatHome: home, storageProjectId: located.storageProjectId, conversationId, discussionId,
      fromLongAgentId: String(body.fromLongAgentId), toLongAgentId: String(body.toLongAgentId), question: String(body.question),
      ...(body.depth === undefined ? {} : { depth: Number(body.depth) }),
    });
    setResponseStatus(event, 202);
    setResponseHeader(event, "Cache-Control", "no-store");
    return { schemaVersion: 1, discussionId, runId: run.runId };
  } catch (error) {
    conversationHttpError(error);
  }
});
