import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import { dirname } from "node:path";
import { assertChatSessionReadable, requireChatSession } from "../../../../../../session-read-model.js";
import { SessionLifecycleError } from "../../../../../../session-errors.js";
import { toSessionLifecycleHttpError } from "../../../../../../session-removal-http.js";
import { SessionOwnerResolutionError } from "../../../../../../session-owner.js";
import { hasInteractions, readInteractionRequest } from "../../../../../../session-interactions.js";

/**
 * 按请求读取：payload=0 仅区域摘要（响应不含原文字节——基线门禁）；payload=1 含完整原文。
 * 旧会话（无 interactions）→ 404 legacy:true（B3 用旧 prompt-captures API 回落）。
 */
export default defineEventHandler(async (event) => {
  const sessionId = getRouterParam(event, "sessionId");
  const requestId = getRouterParam(event, "requestId");
  if (!sessionId || !requestId) throw createError({ statusCode: 400, statusMessage: "缺少sessionId或requestId" });
  const query = getQuery(event);
  const projectId = typeof query.projectId === "string" ? query.projectId : undefined;
  const withPayload = query.payload === "1";
  setResponseHeader(event, "Cache-Control", "no-store");
  let sessionDir: string;
  try {
    await assertChatSessionReadable({ sessionId, ...(projectId === undefined ? {} : { projectId }), requester: { kind: "owner" } });
    const session = await requireChatSession(sessionId, projectId);
    sessionDir = dirname(session.path);
  } catch (error) {
    if (error instanceof SessionOwnerResolutionError) throw createError({ statusCode: 500, statusMessage: error.message });
    if (error instanceof SessionLifecycleError) throw toSessionLifecycleHttpError(error);
    throw createError({ statusCode: 404, statusMessage: error instanceof Error ? error.message : String(error) });
  }
  try {
    if (!(await hasInteractions(sessionDir, sessionId))) {
      throw createError({ statusCode: 404, statusMessage: "旧会话（legacy），请使用 prompt-captures 接口", data: { legacy: true } });
    }
    const result = await readInteractionRequest(sessionDir, sessionId, requestId, withPayload);
    if (result.row === undefined) throw createError({ statusCode: 404, statusMessage: "找不到请求记录" });
    return {
      sessionId,
      row: result.row,
      ...(result.payload === undefined ? {} : { payload: JSON.parse(result.payload) }),
      ...(result.messageRegions === undefined ? {} : { messageRegions: result.messageRegions }),
      payloadPresent: result.payloadPresent,
    };
  } catch (error) {
    if (error && typeof error === "object" && "statusCode" in error) throw error;
    console.error("[interactions] request read failed", error);
    throw createError({ statusCode: 500, statusMessage: "无法读取请求记录" });
  }
});
