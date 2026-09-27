import { createError, defineEventHandler, getRouterParam, getQuery } from "nitro/h3";
import { cancelSessionMaintenance } from "../../../../session-maintenance.js";
import { sessionMaintenanceHttpError } from "../../../../session-maintenance-http.js";
export default defineEventHandler(async event => {
  const sessionId = getRouterParam(event, "sessionId"), { projectId, requestId } = getQuery(event);
  if (!sessionId || typeof projectId !== "string" || !projectId || typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) throw createError({ statusCode: 400, statusMessage: "Missing operation identity" });
  try { return await cancelSessionMaintenance(projectId, sessionId, requestId); }
  catch (error) { throw sessionMaintenanceHttpError(error); }
});
