import { createError, defineEventHandler, getRouterParam, readBody, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../chat-home.js";
import { readLongAgentRegistry } from "../../../../long-agents/storage.js";
import { InteractionProjectError, setLongAgentInteractionProject } from "../../../../long-agents/interaction-project.js";

/** Owner-facing CAS write: set or explicitly clear one Friend's collaboration project. */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const longAgentId = getRouterParam(event, "longAgentId");
  if (!longAgentId) throw createError({ statusCode: 400, statusMessage: "缺少 Friend ID" });
  const body = await readBody<unknown>(event);
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw createError({ statusCode: 400, statusMessage: "请求必须是对象" });
  const value = body as Record<string, unknown>;
  const unknown = Object.keys(value).filter((key) => !["projectId", "expectedRevision"].includes(key));
  if (unknown.length > 0) throw createError({ statusCode: 400, statusMessage: `未知字段：${unknown.join(", ")}` });
  if (value.projectId !== null && (typeof value.projectId !== "string" || value.projectId.trim() === ""))
    throw createError({ statusCode: 400, statusMessage: "projectId 必须是字符串或 null" });
  if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0)
    throw createError({ statusCode: 400, statusMessage: "需要 expectedRevision（CAS）" });
  const home = resolveChatHome();
  const agent = (await readLongAgentRegistry(home)).agents.find((candidate) => candidate.id === longAgentId);
  if (agent === undefined) throw createError({ statusCode: 404, statusMessage: `找不到 Friend：${longAgentId}` });
  try {
    return {
      schemaVersion: 1,
      longAgentId,
      ...(await setLongAgentInteractionProject({
        chatHome: home, longAgentId,
        projectId: value.projectId === null ? null : String(value.projectId),
        expectedRevision: Number(value.expectedRevision),
      })),
    };
  } catch (error) {
    throw createError({
      statusCode: error instanceof InteractionProjectError ? error.statusCode : 500,
      statusMessage: error instanceof Error ? error.message : "写入项目关联失败",
    });
  }
});
