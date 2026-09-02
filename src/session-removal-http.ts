import { createError } from "nitro/h3";
import { SessionLifecycleError } from "./session-errors.js";

export function toSessionLifecycleHttpError(error: unknown) {
  if (error instanceof SessionLifecycleError) {
    const statusCode = error.code === "SESSION_PURGED" || error.code === "SESSION_REMOVED"
      ? 410
      : error.code === "SESSION_NOT_FOUND"
        ? 404
        : 409;
    return createError({
      statusCode,
      statusMessage: error.message,
      data: { code: error.code },
    });
  }
  return createError({
    statusCode: 500,
    statusMessage: error instanceof Error ? error.message : String(error),
  });
}
