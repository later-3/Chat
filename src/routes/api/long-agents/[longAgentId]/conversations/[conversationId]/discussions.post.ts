import { createError, defineEventHandler, getRouterParam, setResponseHeader, setResponseStatus } from "nitro/h3";
import { randomUUID } from "node:crypto";
import { resolveChatHome } from "../../../../../../chat-home.js";
import { conversationHttpError, locateConversationForHttp, readConversationBody } from "../../../../../../long-agents/conversations/http.js";
import { startGroupDiscussion } from "../../../../../../workflows/group-discussion/index.js";
import { ConversationError, type ConversationPolicy } from "../../../../../../long-agents/conversations/contract.js";

/**
 * Owner-facing start of one bounded discussion round. The durable Workflow is the single
 * orchestration entry; the HTTP layer only validates the request and returns the run id.
 */
export default defineEventHandler(async (event) => {
  const namespace = getRouterParam(event, "longAgentId");
  const conversationId = getRouterParam(event, "conversationId", { decode: true });
  if (!namespace || !conversationId) throw createError({ statusCode: 400, statusMessage: "缺少群或 Friend 标识" });
  const body = await readConversationBody(event, ["discussionId", "policy", "round", "targets"]);
  const discussionId = body.discussionId === undefined ? `disc-${randomUUID()}` : String(body.discussionId);
  if (discussionId.trim() === "") throw createError({ statusCode: 400, statusMessage: "discussionId 无效" });
  if (body.targets !== undefined && (!Array.isArray(body.targets) || body.targets.some((id) => typeof id !== "string")))
    throw createError({ statusCode: 400, statusMessage: "targets 必须是字符串数组" });
  const home = resolveChatHome();
  try {
    const located = await locateConversationForHttp(home, conversationId, namespace);
    // Fail the start synchronously for a terminal group instead of letting the durable run fail later.
    if (located.conversation.lifecycle === "archived")
      throw new ConversationError(409, "群已归档，不能启动讨论");
    const run = await startGroupDiscussion({
      chatHome: home, storageProjectId: located.storageProjectId, conversationId, discussionId,
      ...(body.policy === undefined ? {} : { policy: body.policy as ConversationPolicy }),
      ...(body.round === undefined ? {} : { round: Number(body.round) }),
      ...(body.targets === undefined ? {} : { targets: body.targets as string[] }),
    });
    setResponseStatus(event, 202);
    setResponseHeader(event, "Cache-Control", "no-store");
    return { schemaVersion: 1, discussionId, runId: run.runId };
  } catch (error) {
    conversationHttpError(error);
  }
});
