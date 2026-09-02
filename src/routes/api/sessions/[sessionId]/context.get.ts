import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import { readChatSession } from "../../../../session-read-model.js";
import { SessionLifecycleError } from "../../../../session-errors.js";
import { toSessionLifecycleHttpError } from "../../../../session-removal-http.js";

export default defineEventHandler(async (event) => {
  const sessionId = getRouterParam(event, "sessionId");
  if (!sessionId) throw createError({ statusCode: 400, statusMessage: "缺少sessionId" });
  const query = getQuery(event);
  const leafId = typeof query.leafId === "string" && query.leafId !== "" ? query.leafId : undefined;
  const projectId = typeof query.projectId === "string" ? query.projectId : undefined;
  setResponseHeader(event, "Cache-Control", "no-store");
  try {
    const session = await readChatSession(sessionId, leafId, {
      deferThinking: "deferThinking" in query,
      deferToolResultImages: "deferMedia" in query,
    }, projectId);
    return { context: session.context };
  } catch (error) {
    if (error instanceof SessionLifecycleError) throw toSessionLifecycleHttpError(error);
    throw createError({
      statusCode: 404,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
