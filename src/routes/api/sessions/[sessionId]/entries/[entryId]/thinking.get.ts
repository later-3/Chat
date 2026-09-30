import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import { readChatDeferredThinking } from "../../../../../../session-read-model.js";
import { SessionLifecycleError } from "../../../../../../session-errors.js";
import { toSessionLifecycleHttpError } from "../../../../../../session-removal-http.js";

/** Owner-facing refetch of one deferred thinking block stripped by `deferThinking` projections. */
export default defineEventHandler(async (event) => {
  const sessionId = getRouterParam(event, "sessionId");
  const entryId = getRouterParam(event, "entryId");
  if (!sessionId) throw createError({ statusCode: 400, statusMessage: "缺少sessionId" });
  if (!entryId) throw createError({ statusCode: 400, statusMessage: "缺少entryId" });
  setResponseHeader(event, "Cache-Control", "no-store");

  const query = getQuery(event);
  const blockIndex = typeof query.blockIndex === "string" ? Number(query.blockIndex) : Number.NaN;
  if (!Number.isSafeInteger(blockIndex) || blockIndex < 0) {
    throw createError({ statusCode: 400, statusMessage: "blockIndex无效" });
  }
  const projectId = typeof query.projectId === "string" ? query.projectId : undefined;

  try {
    const result = await readChatDeferredThinking(sessionId, entryId, blockIndex, projectId, undefined, { kind: "owner" });
    if (result.status === "not-found") {
      throw createError({ statusCode: 404, statusMessage: "找不到Thinking内容" });
    }
    return { thinking: result.thinking };
  } catch (error) {
    if (error instanceof SessionLifecycleError) throw toSessionLifecycleHttpError(error);
    throw error;
  }
});
