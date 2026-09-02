import { createError, defineEventHandler, getQuery, getRouterParam, readBody, setResponseHeader } from "nitro/h3";
import { renameChatSession } from "../../../session-name.js";
import { SessionLifecycleError } from "../../../session-errors.js";
import { toSessionLifecycleHttpError } from "../../../session-removal-http.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default defineEventHandler(async (event) => {
  const sessionId = getRouterParam(event, "sessionId");
  const projectId = getQuery(event).projectId;
  if (!sessionId) throw createError({ statusCode: 400, statusMessage: "缺少sessionId" });
  if (typeof projectId !== "string" || projectId.trim() === "") {
    throw createError({ statusCode: 400, statusMessage: "重命名Session必须提供projectId" });
  }
  setResponseHeader(event, "Cache-Control", "no-store");
  try {
    const body = await readBody<unknown>(event);
    if (!isRecord(body) || typeof body.name !== "string") throw new Error("Session名称必须是字符串");
    return await renameChatSession(projectId, sessionId, body.name);
  } catch (error) {
    if (error instanceof SessionLifecycleError) {
      throw toSessionLifecycleHttpError(error);
    }
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
