import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import { dirname } from "node:path";
import { assertChatSessionReadable, requireChatSession } from "../../../../session-read-model.js";
import { SessionLifecycleError } from "../../../../session-errors.js";
import { toSessionLifecycleHttpError } from "../../../../session-removal-http.js";
import { SessionOwnerResolutionError } from "../../../../session-owner.js";
import { hasInteractions, readLatestContextPreview } from "../../../../session-interactions.js";
import { readContextEditBySessionFile } from "../../../../context-edit.js";

/**
 * 发送前的上下文预览（B5）：最近一次发送的**完整请求体** + 当前编辑层。
 * 原文由记录器无条件写入（不依赖"完整记录"开关）；没有发送过 → payloadPresent=false（前端提示先发一条）。
 */
export default defineEventHandler(async (event) => {
  const sessionId = getRouterParam(event, "sessionId");
  if (!sessionId) throw createError({ statusCode: 400, statusMessage: "缺少sessionId" });
  const query = getQuery(event);
  const projectId = typeof query.projectId === "string" ? query.projectId : undefined;
  setResponseHeader(event, "Cache-Control", "no-store");
  let sessionDir: string;
  let sessionPath: string;
  try {
    await assertChatSessionReadable({ sessionId, ...(projectId === undefined ? {} : { projectId }), requester: { kind: "owner" } });
    const session = await requireChatSession(sessionId, projectId);
    sessionPath = session.path;
    sessionDir = dirname(session.path);
  } catch (error) {
    if (error instanceof SessionOwnerResolutionError) throw createError({ statusCode: 500, statusMessage: error.message });
    if (error instanceof SessionLifecycleError) throw toSessionLifecycleHttpError(error);
    throw createError({ statusCode: 404, statusMessage: error instanceof Error ? error.message : String(error) });
  }
  try {
    const edit = await readContextEditBySessionFile(sessionPath);
    if (!(await hasInteractions(sessionDir, sessionId))) {
      return { sessionId, payloadPresent: false, edit };
    }
    const preview = await readLatestContextPreview(sessionDir, sessionId);
    return {
      sessionId,
      edit,
      ...(preview.row === undefined ? {} : { row: preview.row }),
      ...(preview.payload === undefined ? {} : { payload: JSON.parse(preview.payload) }),
      ...(preview.messageRegions === undefined ? {} : { messageRegions: preview.messageRegions }),
      payloadPresent: preview.payloadPresent,
    };
  } catch (error) {
    if (error && typeof error === "object" && "statusCode" in error) throw error;
    console.error("[context-preview] read failed", error);
    throw createError({ statusCode: 500, statusMessage: "无法读取上下文预览" });
  }
});
