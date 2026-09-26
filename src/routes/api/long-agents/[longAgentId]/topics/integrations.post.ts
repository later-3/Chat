import { createError, defineEventHandler, getRouterParam, readBody, setResponseHeader, setResponseStatus } from "nitro/h3";
import { resolveChatHome } from "../../../../../chat-home.js";
import { readTopicIntegration, startTopicIntegration } from "../../../../../long-agents/topic-integration.js";
import { startOwnerTopicCreation } from "../../../../../workflows/topic-session-create/owner-entry.js";
import { parseTopicCreationParents } from "../../../../../workflows/topic-session-create/request.js";

/**
 * Compatibility entry: historical work requests replay their frozen identity; every new request
 * starts the same review-gated creation Workflow as the current UI and Long Agent tool.
 */
export default defineEventHandler(async (event) => {
  const longAgentId = getRouterParam(event, "longAgentId");
  if (!longAgentId) throw createError({ statusCode: 400, statusMessage: "缺少 Friend ID" });
  setResponseHeader(event, "Cache-Control", "no-store");
  const body = await readBody<unknown>(event);
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw createError({ statusCode: 400, statusMessage: "请求必须是对象" });
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["schemaVersion", "requestId", "title", "purpose", "sourceSessionId", "parents"].includes(key))
    || value.schemaVersion !== 1 || typeof value.requestId !== "string" || value.requestId.trim() === ""
    || typeof value.title !== "string" || value.title.trim() === ""
    || typeof value.purpose !== "string" || value.purpose.trim() === ""
    || (value.sourceSessionId !== undefined && (typeof value.sourceSessionId !== "string" || value.sourceSessionId.trim() === "")))
    throw createError({ statusCode: 400, statusMessage: "无效建题合同" });
  try {
    const input = {
      chatHome: resolveChatHome(), longAgentId,
      requestId: value.requestId, title: value.title, purpose: value.purpose,
      ...(value.sourceSessionId === undefined ? {} : { sourceSessionId: value.sourceSessionId }),
      // A present `parents` makes this a FORK: the child integrates the parent node at a settled anchor.
      ...(value.parents === undefined ? {} : { parents: parseTopicCreationParents(value.parents) }),
    };
    // Historical work requests remain replayable; NEW requests can only enter the review Workflow.
    const existing = await readTopicIntegration(input);
    const started = existing.work !== null
      ? await startTopicIntegration(input)
      : await startOwnerTopicCreation({ ...input, prompt: `请整理主题上下文供用户审核。建议标题：${value.title}；目的：${value.purpose}。` });
    setResponseStatus(event, 202);
    return started;
  } catch (error) {
    throw createError({
      statusCode: error instanceof Error && "statusCode" in error && error.statusCode === 409 ? 409 : 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
