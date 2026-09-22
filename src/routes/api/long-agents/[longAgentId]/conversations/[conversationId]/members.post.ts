import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../../../chat-home.js";
import {
  conversationHttpError,
  conversationSummary,
  locateConversationForHttp,
  readConversationBody,
} from "../../../../../../long-agents/conversations/http.js";
import {
  rejoinMember,
  revokeMember,
  setMemberGrants,
  updateConversation,
} from "../../../../../../long-agents/conversations/service.js";
import { parseToolGrants } from "../../../../../../long-agents/conversations/contract.js";

/**
 * Owner-facing membership management. Each action carries the group's CAS revision; a revoke ends the
 * participation period, and a re-join starts a new one with no previous context or grants.
 */
export default defineEventHandler(async (event) => {
  const namespace = getRouterParam(event, "longAgentId");
  const conversationId = getRouterParam(event, "conversationId", { decode: true });
  if (!namespace || !conversationId) throw createError({ statusCode: 400, statusMessage: "缺少群或 Friend 标识" });
  const body = await readConversationBody(event, ["action", "expectedRevision", "longAgentId", "grants", "memberLongAgentIds"]);
  if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 1)
    throw createError({ statusCode: 400, statusMessage: "需要 expectedRevision（CAS）" });
  const home = resolveChatHome();
  try {
    const located = await locateConversationForHttp(home, conversationId, namespace);
    const common = {
      chatHome: home, storageProjectId: located.storageProjectId, conversationId,
      expectedRevision: body.expectedRevision as number,
    };
    if (body.action === "add") {
      if (!Array.isArray(body.memberLongAgentIds)) throw createError({ statusCode: 400, statusMessage: "add 需要 memberLongAgentIds" });
      return conversationSummary(await updateConversation({ ...common, memberLongAgentIds: body.memberLongAgentIds as string[] }));
    }
    if (typeof body.longAgentId !== "string" || body.longAgentId.trim() === "")
      throw createError({ statusCode: 400, statusMessage: "需要 longAgentId" });
    if (body.action === "revoke") {
      setResponseHeader(event, "Cache-Control", "no-store");
      return conversationSummary(await revokeMember({ ...common, longAgentId: body.longAgentId }));
    }
    if (body.action === "rejoin") {
      setResponseHeader(event, "Cache-Control", "no-store");
      return conversationSummary(await rejoinMember({ ...common, longAgentId: body.longAgentId }));
    }
    if (body.action === "setGrants") {
      setResponseHeader(event, "Cache-Control", "no-store");
      return conversationSummary(await setMemberGrants({ ...common, longAgentId: body.longAgentId, grants: parseToolGrants(body.grants ?? {}) }));
    }
    throw createError({ statusCode: 400, statusMessage: "action 必须是 add/revoke/rejoin/setGrants" });
  } catch (error) {
    conversationHttpError(error);
  }
});
