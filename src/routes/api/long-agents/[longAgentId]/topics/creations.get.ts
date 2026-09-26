import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../../chat-home.js";
import { listTopicCreationRequests } from "../../../../../workflows/topic-session-create/requests.js";

/** Restores creation tasks in both their originating conversation and the topic navigation. */
export default defineEventHandler(async event => {
  const longAgentId = getRouterParam(event, "longAgentId");
  if (!longAgentId) throw createError({ statusCode: 400, statusMessage: "缺少 Friend 标识" });
  const sourceSessionId = getQuery(event).sourceSessionId;
  if (sourceSessionId !== undefined && (typeof sourceSessionId !== "string" || sourceSessionId.trim() === "")) {
    throw createError({ statusCode: 400, statusMessage: "来源会话无效" });
  }
  setResponseHeader(event, "Cache-Control", "no-store");
  return { schemaVersion: 1, creations: await listTopicCreationRequests(resolveChatHome(), longAgentId, sourceSessionId) };
});
