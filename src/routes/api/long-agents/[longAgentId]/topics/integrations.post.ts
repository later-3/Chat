import { createError, defineEventHandler, getRouterParam, readBody, setResponseHeader, setResponseStatus } from "nitro/h3";
import { resolveChatHome } from "../../../../../chat-home.js";
import { startTopicIntegration } from "../../../../../long-agents/topic-integration.js";

/**
 * Owner-facing "说一句建题" entry.
 *
 * The server resolves the Friend's daily source and starts the integration background work; the node
 * itself is created by that work through the shared `topic_manage` domain services. The deterministic
 * `topicId`/`nodeId`/`sessionId` let the caller open the node once the work finishes.
 */
export default defineEventHandler(async (event) => {
  const longAgentId = getRouterParam(event, "longAgentId");
  if (!longAgentId) throw createError({ statusCode: 400, statusMessage: "缺少 Friend ID" });
  setResponseHeader(event, "Cache-Control", "no-store");
  const body = await readBody<unknown>(event);
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw createError({ statusCode: 400, statusMessage: "请求必须是对象" });
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["schemaVersion", "requestId", "title", "purpose", "sourceSessionId"].includes(key))
    || value.schemaVersion !== 1 || typeof value.requestId !== "string" || value.requestId.trim() === ""
    || typeof value.title !== "string" || value.title.trim() === ""
    || typeof value.purpose !== "string" || value.purpose.trim() === ""
    || (value.sourceSessionId !== undefined && (typeof value.sourceSessionId !== "string" || value.sourceSessionId.trim() === "")))
    throw createError({ statusCode: 400, statusMessage: "无效建题合同" });
  try {
    const started = await startTopicIntegration({
      chatHome: resolveChatHome(), longAgentId,
      requestId: value.requestId, title: value.title, purpose: value.purpose,
      ...(value.sourceSessionId === undefined ? {} : { sourceSessionId: value.sourceSessionId }),
    });
    setResponseStatus(event, 202);
    return started;
  } catch (error) {
    throw createError({
      statusCode: error instanceof Error && "statusCode" in error && error.statusCode === 409 ? 409 : 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
