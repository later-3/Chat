import { createError } from "nitro/h3";
import { SessionInputError, SessionLifecycleError } from "./session-errors.js";
import { toSessionLifecycleHttpError } from "./session-removal-http.js";

export function sessionMaintenanceHttpError(error: unknown) {
  if (error instanceof SessionLifecycleError) return toSessionLifecycleHttpError(error);
  if (error instanceof SessionInputError) return createError({ statusCode: 400, statusMessage: error.message });
  console.error("[session-maintenance]", error);
  return createError({ statusCode: 500, statusMessage: "Session maintenance failed" });
}
