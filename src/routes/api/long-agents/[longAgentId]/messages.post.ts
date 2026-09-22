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
  if (body.contextProjectId !== undefined && body.contextProjectId !== null
    && (typeof body.contextProjectId !== "string" || body.contextProjectId.trim() === "")) {
    throw createError({ statusCode: 400, statusMessage: "contextProjectId必须是项目ID或null" });
  }
  if (body.requestId !== undefined && (typeof body.requestId !== "string" || !body.requestId.trim() || body.requestId.length > 256)) throw createError({ statusCode: 400, statusMessage: "requestId无效" });
  if (body.interactionRevision !== undefined && (!Number.isSafeInteger(body.interactionRevision) || Number(body.interactionRevision) < 0)) {
    throw createError({ statusCode: 400, statusMessage: "interactionRevision无效" });
  }
  if (Object.keys(body).some((key) => !["projectId", "sessionId", "text", "contextProjectId", "requestId", "interactionRevision"].includes(key))) throw createError({ statusCode: 400, statusMessage: "未知消息字段" });
  try {
    return await executeLongAgentTurn({
      ...(typeof body.requestId === "string" ? { turnId: body.requestId } : {}),
      longAgentId,
      requireInteractionRevision: true,
      projectId: body.projectId,
      ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
      text: body.text,
      contextProjectId: typeof body.contextProjectId === "string" ? body.contextProjectId : null,
      ...(typeof body.interactionRevision === "number" ? { interactionRevision: body.interactionRevision } : {}),
    });
  } catch (error) {
    throw createError({
      statusCode: error instanceof Error && "statusCode" in error && error.statusCode === 409 ? 409 : 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
