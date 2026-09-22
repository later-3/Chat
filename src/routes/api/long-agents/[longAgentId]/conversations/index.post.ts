import { createError, defineEventHandler, getRouterParam, setResponseHeader, setResponseStatus } from "nitro/h3";
import { resolveChatHome } from "../../../../../chat-home.js";
import {
  conversationHttpError,
  conversationSummary,
  readConversationBody,
} from "../../../../../long-agents/conversations/http.js";
import { createConversation } from "../../../../../long-agents/conversations/service.js";
import type { ConversationBudget, ConversationPolicy } from "../../../../../long-agents/conversations/contract.js";

/**
 * Create a group. The URL namespace is the creating Friend and must be one of the members; the
 * storage Project comes from the body but is verified by the record, not trusted as authority.
 */
export default defineEventHandler(async (event) => {
  const namespace = getRouterParam(event, "longAgentId");
  if (!namespace) throw createError({ statusCode: 400, statusMessage: "缺少 Friend 标识" });
  const body = await readConversationBody(event, ["storageProjectId", "title", "requestId", "memberLongAgentIds", "policy", "budget", "collaborationProjectId"]);
  const storageProjectId = body.storageProjectId;
  const title = body.title;
  const requestId = body.requestId;
  const memberLongAgentIds = body.memberLongAgentIds;
  if (typeof storageProjectId !== "string" || storageProjectId.trim() === "") throw createError({ statusCode: 400, statusMessage: "需要 storageProjectId" });
  if (typeof title !== "string" || title.trim() === "") throw createError({ statusCode: 400, statusMessage: "需要群名称" });
  if (typeof requestId !== "string" || requestId.trim() === "") throw createError({ statusCode: 400, statusMessage: "需要 requestId" });
  if (!Array.isArray(memberLongAgentIds) || memberLongAgentIds.some((id) => typeof id !== "string"))
    throw createError({ statusCode: 400, statusMessage: "memberLongAgentIds 必须是字符串数组" });
  if (!memberLongAgentIds.includes(namespace))
    throw createError({ statusCode: 400, statusMessage: "创建者 Friend 必须在成员内" });
  try {
    const conversation = await createConversation({
      chatHome: resolveChatHome(), storageProjectId, title, requestId,
      memberLongAgentIds: memberLongAgentIds as string[],
      ...(body.collaborationProjectId === undefined ? {} : { collaborationProjectId: body.collaborationProjectId === null ? null : String(body.collaborationProjectId) }),
      ...(body.policy === undefined ? {} : { policy: body.policy as { defaultPolicy?: ConversationPolicy; moderatorLongAgentId?: string | null; roundRobinOrder?: string[] } }),
      ...(body.budget === undefined ? {} : { budget: body.budget as Partial<ConversationBudget> }),
    });
    setResponseStatus(event, 201);
    setResponseHeader(event, "Cache-Control", "no-store");
    return conversationSummary(conversation);
  } catch (error) {
    conversationHttpError(error);
  }
});
