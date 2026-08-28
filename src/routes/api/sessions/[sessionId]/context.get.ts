import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import { readChatSession } from "../../../../session-read-model.js";

export default defineEventHandler(async (event) => {
  const sessionId = getRouterParam(event, "sessionId");
  if (!sessionId) throw createError({ statusCode: 400, statusMessage: "缺少sessionId" });
  const query = getQuery(event);
  const leafId = typeof query.leafId === "string" && query.leafId !== "" ? query.leafId : undefined;
  setResponseHeader(event, "Cache-Control", "no-store");
  try {
    const session = await readChatSession(sessionId, leafId, {
      deferThinking: "deferThinking" in query,
      deferToolResultImages: "deferMedia" in query,
    });
    return { context: session.context };
  } catch (error) {
    throw createError({
      statusCode: 404,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
