import { createError, defineEventHandler, getQuery, readBody, setResponseHeader } from "nitro/h3";
import { updateProjectSessionRetentionDays } from "../../../../chat-config.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default defineEventHandler(async (event) => {
  const projectId = getQuery(event).projectId;
  if (typeof projectId !== "string" || projectId.trim() === "") {
    throw createError({ statusCode: 400, statusMessage: "配置Session移除区必须提供projectId" });
  }
  setResponseHeader(event, "Cache-Control", "no-store");
  try {
    const body = await readBody<unknown>(event);
    if (!isRecord(body)) throw new Error("请求体必须是JSON对象");
    const config = await updateProjectSessionRetentionDays(projectId, body.removedRetentionDays);
    return { removedRetentionDays: config.sessions?.removedRetentionDays };
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
