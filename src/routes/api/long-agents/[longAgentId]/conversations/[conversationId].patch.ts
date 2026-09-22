import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../../chat-home.js";
import {
  conversationHttpError,
  conversationSummary,
  locateConversationForHttp,
  readConversationBody,
} from "../../../../../long-agents/conversations/http.js";
import { updateConversation } from "../../../../../long-agents/conversations/service.js";
import type { ConversationBudget, ConversationPolicyConfig } from "../../../../../long-agents/conversations/contract.js";

/** Owner-facing configuration write with the group's compare-and-swap revision. */
export default defineEventHandler(async (event) => {
  const namespace = getRouterParam(event, "longAgentId");
  const conversationId = getRouterParam(event, "conversationId", { decode: true });
  if (!namespace || !conversationId) throw createError({ statusCode: 400, statusMessage: "缺少群或 Friend 标识" });
  const body = await readConversationBody(event, ["expectedRevision", "title", "policy", "budget", "memberLongAgentIds", "collaborationProjectId"]);
  if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 1)
    throw createError({ statusCode: 400, statusMessage: "需要 expectedRevision（CAS）" });
  const home = resolveChatHome();
  try {
    const located = await locateConversationForHttp(home, conversationId, namespace);
    const conversation = await updateConversation({
      chatHome: home, storageProjectId: located.storageProjectId, conversationId,
      expectedRevision: body.expectedRevision as number,
      ...(body.title === undefined ? {} : { title: String(body.title) }),
      ...(body.policy === undefined ? {} : { policy: body.policy as ConversationPolicyConfig }),
      ...(body.budget === undefined ? {} : { budget: body.budget as ConversationBudget }),
      ...(body.memberLongAgentIds === undefined ? {} : { memberLongAgentIds: body.memberLongAgentIds as string[] }),
      ...(body.collaborationProjectId === undefined ? {} : { collaborationProjectId: body.collaborationProjectId === null ? null : String(body.collaborationProjectId) }),
    });
    setResponseHeader(event, "Cache-Control", "no-store");
    return conversationSummary(conversation);
  } catch (error) {
    conversationHttpError(error);
  }
});
