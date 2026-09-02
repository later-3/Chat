import { createError, defineEventHandler, getQuery, setResponseHeader } from "nitro/h3";
import { listRemovedChatSessions } from "../../../session-removal.js";
import { toSessionLifecycleHttpError } from "../../../session-removal-http.js";

export default defineEventHandler(async (event) => {
  const projectId = getQuery(event).projectId;
  if (typeof projectId !== "string" || projectId.trim() === "") {
    throw createError({ statusCode: 400, statusMessage: "查看Session移除区必须提供projectId" });
  }
  setResponseHeader(event, "Cache-Control", "no-store");
  try {
    return await listRemovedChatSessions(projectId);
  } catch (error) {
    throw toSessionLifecycleHttpError(error);
  }
});
