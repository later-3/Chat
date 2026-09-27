import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import { readSessionMaintenance } from "../../../../session-maintenance.js";
import { sessionMaintenanceHttpError } from "../../../../session-maintenance-http.js";
export default defineEventHandler(async event => {
  const sessionId = getRouterParam(event, "sessionId"), projectId = getQuery(event).projectId;
  if (!sessionId || typeof projectId !== "string" || !projectId) throw createError({ statusCode: 400, statusMessage: "Missing session identity" });
  setResponseHeader(event, "Cache-Control", "no-store");
  try { return await readSessionMaintenance(projectId, sessionId); }
  catch (error) { throw sessionMaintenanceHttpError(error); }
});
