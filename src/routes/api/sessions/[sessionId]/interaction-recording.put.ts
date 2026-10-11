import { createError, defineEventHandler, getQuery, getRouterParam, readBody, setResponseHeader } from "nitro/h3";
import { assertChatSessionReadable, requireChatSession } from "../../../../session-read-model.js";
import { SessionLifecycleError } from "../../../../session-errors.js";
import { toSessionLifecycleHttpError } from "../../../../session-removal-http.js";
import { SessionOwnerResolutionError } from "../../../../session-owner.js";
import { RecordingConflictError, setSessionInteractionRecording } from "../../../../session-interactions.js";

/**
 * 写完整记录开关（会话级服务端事实）。
 * 语义：从下一轮起生效（02 §2.1）；expectedRevision 不符 → 409；好友历史会话只读（镜像 rename 规则）。
 */
export default defineEventHandler(async (event) => {
  const sessionId = getRouterParam(event, "sessionId");
  if (!sessionId) throw createError({ statusCode: 400, statusMessage: "缺少sessionId" });
  setResponseHeader(event, "Cache-Control", "no-store");
  const query = getQuery(event);
  const projectId = typeof query.projectId === "string" ? query.projectId : undefined;
  if (projectId === undefined) throw createError({ statusCode: 400, statusMessage: "缺少projectId" });
  const body = (await readBody<{ enabled?: unknown; expectedRevision?: unknown }>(event)) ?? {};
  if (typeof body.enabled !== "boolean") throw createError({ statusCode: 400, statusMessage: "enabled必须是布尔值" });
  if (typeof body.expectedRevision !== "number" || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
    throw createError({ statusCode: 400, statusMessage: "expectedRevision必须是非负整数" });
  }
  try {
    await assertChatSessionReadable({ sessionId, projectId, requester: { kind: "owner" } });
    const session = await requireChatSession(sessionId, projectId);
    void session;
    return await setSessionInteractionRecording({ projectId, sessionId, enabled: body.enabled, expectedRevision: body.expectedRevision });
  } catch (error) {
    if (error instanceof RecordingConflictError) throw createError({ statusCode: 409, statusMessage: error.message });
    if (error instanceof SessionOwnerResolutionError) throw createError({ statusCode: 500, statusMessage: error.message });
    if (error instanceof SessionLifecycleError) throw toSessionLifecycleHttpError(error);
    throw createError({ statusCode: 404, statusMessage: error instanceof Error ? error.message : String(error) });
  }
});
