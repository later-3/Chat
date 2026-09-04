import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import { openChatSession } from "../../../../../chat-session.js";
import { SessionLifecycleError } from "../../../../../session-errors.js";
import { toSessionLifecycleHttpError } from "../../../../../session-removal-http.js";
import { cancelActiveChatWorkflowCall } from "../../../../../workflows/workflow-call.js";

export default defineEventHandler(async (event) => {
  const sessionId = getRouterParam(event, "sessionId");
  const callId = getRouterParam(event, "callId");
  if (!sessionId) throw createError({ statusCode: 400, statusMessage: "缺少sessionId" });
  if (!callId) throw createError({ statusCode: 400, statusMessage: "缺少callId" });
  const query = getQuery(event);
  const projectId = typeof query.projectId === "string" && query.projectId.trim() !== ""
    ? query.projectId
    : undefined;
  if (projectId === undefined) throw createError({ statusCode: 400, statusMessage: "缺少projectId" });
  setResponseHeader(event, "Cache-Control", "no-store");

  try {
    const session = await openChatSession({ projectId, sessionId });
    const result = await cancelActiveChatWorkflowCall({
      parentSessionManager: session.manager,
      callId,
    });
    return { result };
  } catch (error) {
    if (error instanceof SessionLifecycleError) throw toSessionLifecycleHttpError(error);
    throw createError({
      statusCode: 409,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
