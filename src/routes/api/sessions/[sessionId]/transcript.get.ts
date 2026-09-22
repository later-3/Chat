import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import { readSessionTranscript } from "../../../../session-transcript.js";
import { SessionInputError, SessionLifecycleError } from "../../../../session-errors.js";
import { toSessionLifecycleHttpError } from "../../../../session-removal-http.js";

export default defineEventHandler(async (event) => {
  const sessionId = getRouterParam(event, "sessionId");
  const query = getQuery(event);
  if (!sessionId || typeof query.projectId !== "string" || !query.projectId.trim()
    || Object.keys(query).some((key) => !["projectId", "cursor", "leafId", "limit"].includes(key))
    || [query.cursor, query.leafId, query.limit].some((value) => value !== undefined && typeof value !== "string")) {
    throw createError({ statusCode: 400, statusMessage: "无效的历史请求" });
  }
  setResponseHeader(event, "Cache-Control", "no-store");
  try {
    return await readSessionTranscript({
      projectId: query.projectId, sessionId,
      ...(typeof query.cursor === "string" ? { cursor: query.cursor } : {}),
      ...(typeof query.leafId === "string" ? { leafId: query.leafId } : {}),
      ...(typeof query.limit === "string" ? { limit: Number(query.limit) } : {}),
      // Owner-facing TUI/history entry: the local user keeps access to group participation history.
      requester: { kind: "owner" },
    });
  } catch (error) {
    if (error instanceof SessionLifecycleError) throw toSessionLifecycleHttpError(error);
    if (error instanceof SessionInputError) throw createError({ statusCode: 400, statusMessage: error.message });
    console.error("[session-transcript] Read failed", error);
    throw createError({ statusCode: 500, statusMessage: "无法读取历史，请检查后端日志" });
  }
});
