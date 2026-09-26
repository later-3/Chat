import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../../../chat-home.js";
import { readTopicIntegration } from "../../../../../../long-agents/topic-integration.js";
import { listTopicCreationRequests } from "../../../../../../workflows/topic-session-create/requests.js";

/**
 * New requests project their existing Workflow; historical requests retain the work response shape.
 */
export default defineEventHandler(async (event) => {
  const longAgentId = getRouterParam(event, "longAgentId");
  const requestId = getRouterParam(event, "requestId", { decode: true });
  if (!longAgentId || !requestId) throw createError({ statusCode: 400, statusMessage: "缺少 Friend 或建题请求标识" });
  setResponseHeader(event, "Cache-Control", "no-store");
  const chatHome = resolveChatHome();
  const creation = (await listTopicCreationRequests(chatHome, longAgentId)).find(item => item.requestId === requestId);
  if (creation !== undefined) return { schemaVersion: 1, kind: "workflow", ...creation };
  const result = await readTopicIntegration({ chatHome, longAgentId, requestId });
  if (result.work === null && result.node === null) throw createError({ statusCode: 404, statusMessage: "找不到该建题请求" });
  return result;
});
