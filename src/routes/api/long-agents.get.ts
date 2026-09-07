import { createError, defineEventHandler, getQuery, setResponseHeader } from "nitro/h3";
import { listLongAgents } from "../../long-agents/bridge.js";

export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const projectId = getQuery(event).projectId;
  if (projectId !== undefined && typeof projectId !== "string") {
    throw createError({ statusCode: 400, statusMessage: "projectId必须是字符串" });
  }
  try {
    return await listLongAgents({ ...(typeof projectId === "string" ? { projectId } : {}) });
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
