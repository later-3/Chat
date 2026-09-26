import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../chat-home.js";
import { inspectLongAgentTurnCapabilities, readLongAgentInputCapabilities } from "../../../../long-agents/capabilities.js";
import { LongAgentScopeError } from "../../../../long-agents/scope.js";

/**
 * No turn reference: resolve the current definition/model's input capabilities for the composer.
 * With sessionId + turnId: inspect that turn's frozen scope and actually registered tools.
 * Both paths are read-only, do not create a Session, and never return private configuration.
 */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const longAgentId = getRouterParam(event, "longAgentId");
  if (!longAgentId) throw createError({ statusCode: 400, statusMessage: "缺少Long Agent ID" });
  const query = getQuery(event);
  const sessionId = typeof query.sessionId === "string" ? query.sessionId : "";
  const turnId = typeof query.turnId === "string" ? query.turnId : "";
  if ((query.sessionId !== undefined || query.turnId !== undefined) && (sessionId === "" || turnId === ""))
    throw createError({ statusCode: 400, statusMessage: "需要 sessionId 与 turnId" });
  try {
    if (sessionId === "" && turnId === "") return await readLongAgentInputCapabilities(resolveChatHome(), longAgentId);
    return await inspectLongAgentTurnCapabilities({ chatHome: resolveChatHome(), longAgentId, sessionId, turnId });
  } catch (error) {
    throw createError({
      statusCode: error instanceof LongAgentScopeError ? 409 : 500,
      statusMessage: error instanceof LongAgentScopeError ? error.message : "读取有效能力失败，请检查服务日志",
    });
  }
});
