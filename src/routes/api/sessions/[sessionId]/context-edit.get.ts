import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import { assertChatSessionReadable, requireChatSession } from "../../../../session-read-model.js";
import { SessionLifecycleError } from "../../../../session-errors.js";
import { toSessionLifecycleHttpError } from "../../../../session-removal-http.js";
import { SessionOwnerResolutionError } from "../../../../session-owner.js";
import { readContextEditBySessionFile } from "../../../../context-edit.js";

/** 当前会话的上下文编辑层（B5）：excluded/modified/added + revision（服务端事实）。 */
export default defineEventHandler(async (event) => {
  const sessionId = getRouterParam(event, "sessionId");
  if (!sessionId) throw createError({ statusCode: 400, statusMessage: "缺少sessionId" });
  const query = getQuery(event);
  const projectId = typeof query.projectId === "string" ? query.projectId : undefined;
  setResponseHeader(event, "Cache-Control", "no-store");
  try {
    await assertChatSessionReadable({ sessionId, ...(projectId === undefined ? {} : { projectId }), requester: { kind: "owner" } });
    const session = await requireChatSession(sessionId, projectId);
    const edit = await readContextEditBySessionFile(session.path);
    return { sessionId, ...edit };
  } catch (error) {
    if (error instanceof SessionOwnerResolutionError) throw createError({ statusCode: 500, statusMessage: error.message });
    if (error instanceof SessionLifecycleError) throw toSessionLifecycleHttpError(error);
    throw createError({ statusCode: 404, statusMessage: error instanceof Error ? error.message : String(error) });
  }
});
