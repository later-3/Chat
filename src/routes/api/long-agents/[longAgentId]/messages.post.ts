import {
  createError,
  defineEventHandler,
  getRouterParam,
  readBody,
} from "nitro/h3";
import { executeLongAgentTurn } from "../../../../long-agents/runtime.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default defineEventHandler(async (event) => {
  const longAgentId = getRouterParam(event, "longAgentId");
  if (!longAgentId) throw createError({ statusCode: 400, statusMessage: "缺少longAgentId" });
  const body = await readBody<unknown>(event);
  if (!isRecord(body)) throw createError({ statusCode: 400, statusMessage: "请求体必须是对象" });
  if (typeof body.projectId !== "string" || body.projectId.trim() === "") {
    throw createError({ statusCode: 400, statusMessage: "projectId必须是非空字符串" });
  }
  if (body.sessionId !== undefined && (typeof body.sessionId !== "string" || body.sessionId.trim() === "")) {
    throw createError({ statusCode: 400, statusMessage: "sessionId必须是非空字符串" });
  }
  try {
    return await executeLongAgentTurn({
      longAgentId,
      projectId: body.projectId,
      ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
      text: body.text,
    });
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
