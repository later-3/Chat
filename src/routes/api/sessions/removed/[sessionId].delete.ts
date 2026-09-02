import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import { purgeRemovedChatSession } from "../../../../session-removal.js";
import { toSessionLifecycleHttpError } from "../../../../session-removal-http.js";

export default defineEventHandler(async (event) => {
  const sessionId = getRouterParam(event, "sessionId");
  const projectId = getQuery(event).projectId;
  if (!sessionId) throw createError({ statusCode: 400, statusMessage: "缺少sessionId" });
  if (typeof projectId !== "string" || projectId.trim() === "") {
    throw createError({ statusCode: 400, statusMessage: "永久删除Session必须提供projectId" });
  }
  setResponseHeader(event, "Cache-Control", "no-store");
  try {
    return await purgeRemovedChatSession(projectId, sessionId);
  } catch (error) {
    throw toSessionLifecycleHttpError(error);
  }
});
