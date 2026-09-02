import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import { removeChatSession } from "../../../../session-removal.js";
import { toSessionLifecycleHttpError } from "../../../../session-removal-http.js";

export default defineEventHandler(async (event) => {
  const sessionId = getRouterParam(event, "sessionId");
  const projectId = getQuery(event).projectId;
  if (!sessionId) throw createError({ statusCode: 400, statusMessage: "缺少sessionId" });
  if (typeof projectId !== "string" || projectId.trim() === "") {
    throw createError({ statusCode: 400, statusMessage: "移除Session必须提供projectId" });
  }
  setResponseHeader(event, "Cache-Control", "no-store");
  try {
    return { state: "removed" as const, session: await removeChatSession(projectId, sessionId) };
  } catch (error) {
    throw toSessionLifecycleHttpError(error);
  }
});
