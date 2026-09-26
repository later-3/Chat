import { createError, defineEventHandler, getRouterParam, readBody, setResponseHeader, setResponseStatus } from "nitro/h3";
import { randomUUID } from "node:crypto";
import { resolveChatHome } from "../../../../../chat-home.js";
import { startOwnerTopicCreation } from "../../../../../workflows/topic-session-create/owner-entry.js";
import { parseTopicCreationParents } from "../../../../../workflows/topic-session-create/request.js";

/**
 * Owner-facing create entry: starts the REAL review-gated `topic-session-create` Workflow. It returns the
 * prepare Session + Run so the UI can show the review; the target topic Session is created ONLY after the
 * user approves. The source session is resolved server-side from the Long Agent's own daily session.
 */
export default defineEventHandler(async (event) => {
  const longAgentId = getRouterParam(event, "longAgentId");
  if (!longAgentId) throw createError({ statusCode: 400, statusMessage: "缺少 Friend 标识" });
  setResponseHeader(event, "Cache-Control", "no-store");
  const body = await readBody<unknown>(event);
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw createError({ statusCode: 400, statusMessage: "请求必须是对象" });
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["schemaVersion", "prompt", "requestId", "parents"].includes(key))
    || value.schemaVersion !== 1 || typeof value.prompt !== "string" || value.prompt.trim() === ""
    || (value.requestId !== undefined && (typeof value.requestId !== "string" || value.requestId.trim() === "")))
    throw createError({ statusCode: 400, statusMessage: "无效主题创建合同" });
  const home = resolveChatHome();
  const requestId = typeof value.requestId === "string" ? value.requestId : randomUUID();
  try {
    const started = await startOwnerTopicCreation({
      chatHome: home, longAgentId, requestId, prompt: value.prompt,
      parents: parseTopicCreationParents(value.parents),
    });
    setResponseStatus(event, 202);
    return started;
  } catch (error) {
    throw createError({ statusCode: error instanceof Error && "statusCode" in error && error.statusCode === 409 ? 409 : 400, statusMessage: error instanceof Error ? error.message : String(error) });
  }
});
