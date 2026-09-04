import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import { SessionLifecycleError } from "../../../../session-errors.js";
import { toSessionLifecycleHttpError } from "../../../../session-removal-http.js";
import { readChatWorkflowCallProjection } from "../../../../workflows/workflow-call-read-model.js";

export default defineEventHandler(async (event) => {
  const sessionId = getRouterParam(event, "sessionId");
  if (!sessionId) throw createError({ statusCode: 400, statusMessage: "缺少sessionId" });
  const query = getQuery(event);
  const projectId = typeof query.projectId === "string" && query.projectId.trim() !== ""
    ? query.projectId
    : undefined;
  if (projectId === undefined) throw createError({ statusCode: 400, statusMessage: "缺少projectId" });
  setResponseHeader(event, "Cache-Control", "no-store");
  try {
    return await readChatWorkflowCallProjection({ projectId, sessionId });
  } catch (error) {
    if (error instanceof SessionLifecycleError) throw toSessionLifecycleHttpError(error);
    throw createError({
      statusCode: 404,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
