import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import { readChatSession } from "../../../session-read-model.js";
import { SessionLifecycleError } from "../../../session-errors.js";
import { toSessionLifecycleHttpError } from "../../../session-removal-http.js";

export default defineEventHandler(async (event) => {
  const sessionId = getRouterParam(event, "sessionId");
  if (!sessionId) throw createError({ statusCode: 400, statusMessage: "缺少sessionId" });
  setResponseHeader(event, "Cache-Control", "no-store");
  try {
    const query = getQuery(event);
    const projectId = typeof query.projectId === "string" ? query.projectId : undefined;
    return await readChatSession(sessionId, undefined, {
      deferThinking: "deferThinking" in query,
      deferToolResultImages: "deferMedia" in query,
    }, projectId);
  } catch (error) {
    if (error instanceof SessionLifecycleError) throw toSessionLifecycleHttpError(error);
    throw createError({
      statusCode: 404,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
