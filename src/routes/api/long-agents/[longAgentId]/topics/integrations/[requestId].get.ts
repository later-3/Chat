import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../../../chat-home.js";
import { readTopicIntegration } from "../../../../../../long-agents/topic-integration.js";

/**
 * Status of one 建题 request (P3 resume point): the graph is the success fact, the background work turn
 * is the progress/failure fact. Unknown requests are a 404, never an empty success.
 */
export default defineEventHandler(async (event) => {
  const longAgentId = getRouterParam(event, "longAgentId");
  const requestId = getRouterParam(event, "requestId", { decode: true });
  if (!longAgentId || !requestId) throw createError({ statusCode: 400, statusMessage: "缺少 Friend 或建题请求标识" });
  setResponseHeader(event, "Cache-Control", "no-store");
  const result = await readTopicIntegration({ chatHome: resolveChatHome(), longAgentId, requestId });
  if (result.work === null && result.node === null) throw createError({ statusCode: 404, statusMessage: "找不到该建题请求" });
  return result;
});
