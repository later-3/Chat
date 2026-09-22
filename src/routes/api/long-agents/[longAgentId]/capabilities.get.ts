import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../chat-home.js";
import { inspectLongAgentTurnCapabilities } from "../../../../long-agents/capabilities.js";
import { LongAgentScopeError } from "../../../../long-agents/scope.js";

/**
 * Read-only effective-capability check for one finished turn: the frozen authorization scope plus the
 * tools execution actually registered. It never widens anything and never returns private content.
 */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const longAgentId = getRouterParam(event, "longAgentId");
  if (!longAgentId) throw createError({ statusCode: 400, statusMessage: "缺少Long Agent ID" });
  const query = getQuery(event);
  const sessionId = typeof query.sessionId === "string" ? query.sessionId : "";
  const turnId = typeof query.turnId === "string" ? query.turnId : "";
  if (sessionId === "" || turnId === "") throw createError({ statusCode: 400, statusMessage: "需要 sessionId 与 turnId" });
  try {
    return await inspectLongAgentTurnCapabilities({ chatHome: resolveChatHome(), longAgentId, sessionId, turnId });
  } catch (error) {
    throw createError({
      statusCode: error instanceof LongAgentScopeError ? 409 : 500,
      statusMessage: error instanceof LongAgentScopeError ? error.message : "读取有效能力失败，请检查服务日志",
    });
  }
});
