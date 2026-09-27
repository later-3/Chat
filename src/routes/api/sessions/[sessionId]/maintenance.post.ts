import { createError, defineEventHandler, getRouterParam, readBody, setResponseStatus } from "nitro/h3";
import { parseSessionMaintenanceInput, startSessionMaintenance } from "../../../../session-maintenance.js";
import { sessionMaintenanceHttpError } from "../../../../session-maintenance-http.js";
export default defineEventHandler(async event => {
  const sessionId = getRouterParam(event, "sessionId");
  if (!sessionId) throw createError({ statusCode: 400, statusMessage: "Missing session identity" });
  try {
    const result = await startSessionMaintenance(sessionId, parseSessionMaintenanceInput(await readBody<unknown>(event)));
    setResponseStatus(event, result.status === "running" ? 202 : 200);
    return result;
  } catch (error) { throw sessionMaintenanceHttpError(error); }
});
