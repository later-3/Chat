import { createError, defineEventHandler, getRouterParam, readBody, setResponseStatus } from "nitro/h3";
import { resolveChatHome } from "../../../../chat-home.js";
import { createProjectSession } from "../../../../long-agents/project-sessions.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 在 Long Agent 绑定项目下新建会话（只创建绑定，不执行模型）；同一 requestId 幂等。 */
export default defineEventHandler(async (event) => {
  const longAgentId = getRouterParam(event, "longAgentId");
  if (!longAgentId) throw createError({ statusCode: 400, statusMessage: "缺少longAgentId" });
  const body = await readBody<unknown>(event);
  if (!isRecord(body)
    || typeof body.projectId !== "string" || !body.projectId.trim()
    || typeof body.requestId !== "string" || !body.requestId.trim()
    || (body.kind !== undefined && body.kind !== "independent" && body.kind !== "fork")
    || (body.forkedFromSessionId !== undefined && (typeof body.forkedFromSessionId !== "string" || !body.forkedFromSessionId.trim()))
    || Object.keys(body).some((key) => !["projectId", "requestId", "kind", "forkedFromSessionId"].includes(key))) {
    throw createError({ statusCode: 400, statusMessage: "无效的项目会话创建请求" });
  }
  try {
    const result = await createProjectSession({
      chatHome: resolveChatHome(),
      longAgentId,
      projectId: body.projectId,
      requestId: body.requestId,
      kind: body.kind === "fork" ? "fork" : "independent",
      ...(body.forkedFromSessionId === undefined ? {} : { forkedFromSessionId: body.forkedFromSessionId as string }),
    });
    setResponseStatus(event, result.isNewSession ? 201 : 200);
    return {
      schemaVersion: 1,
      sessionId: result.binding.sessionId,
      projectId: result.binding.projectId,
      longAgentId: result.binding.longAgentId,
      kind: result.binding.kind,
      ...(result.binding.forkedFromSessionId === undefined ? {} : { forkedFromSessionId: result.binding.forkedFromSessionId }),
      isNewSession: result.isNewSession,
    };
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) });
  }
});
