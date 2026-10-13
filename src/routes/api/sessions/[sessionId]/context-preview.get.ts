import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import { assertChatSessionReadable, requireChatSession } from "../../../../session-read-model.js";
import { SessionLifecycleError } from "../../../../session-errors.js";
import { toSessionLifecycleHttpError } from "../../../../session-removal-http.js";
import { SessionOwnerResolutionError } from "../../../../session-owner.js";
import { readContextEditBySessionFile } from "../../../../context-edit.js";
import { buildSendPreview } from "../../../../long-agents/context-preview.js";

/**
 * 发送前预览（B5）：**实时装配**"这一次会发给模型的内容"（不调用模型、不落盘）。
 * 用户 2026-10-13 定界：预览必须是发送前看到的当前内容，不能是回看上一次已发送的请求。
 * `draft` = 用户正在输入的本轮内容（会作为本轮 user 消息出现）。
 */
export default defineEventHandler(async (event) => {
  const sessionId = getRouterParam(event, "sessionId");
  if (!sessionId) throw createError({ statusCode: 400, statusMessage: "缺少sessionId" });
  const query = getQuery(event);
  const projectId = typeof query.projectId === "string" ? query.projectId : undefined;
  const longAgentId = typeof query.longAgentId === "string" ? query.longAgentId : undefined;
  const draft = typeof query.draft === "string" ? query.draft : undefined;
  const contextProjectId = typeof query.contextProjectId === "string" ? query.contextProjectId : null;
  setResponseHeader(event, "Cache-Control", "no-store");
  if (projectId === undefined) throw createError({ statusCode: 400, statusMessage: "缺少projectId" });
  if (longAgentId === undefined) throw createError({ statusCode: 400, statusMessage: "缺少longAgentId" });
  try {
    await assertChatSessionReadable({ sessionId, projectId, requester: { kind: "owner" } });
    const session = await requireChatSession(sessionId, projectId);
    const edit = await readContextEditBySessionFile(session.path);
    const preview = await buildSendPreview({
      projectId, sessionId, longAgentId, contextProjectId, ...(draft === undefined ? {} : { draft }),
    });
    return {
      sessionId,
      edit,
      source: "assembly-preview",
      excludedCount: preview.excludedCount,
      payload: preview.payload,
    };
  } catch (error) {
    if (error instanceof SessionOwnerResolutionError) throw createError({ statusCode: 500, statusMessage: error.message });
    if (error instanceof SessionLifecycleError) throw toSessionLifecycleHttpError(error);
    if (error && typeof error === "object" && "statusCode" in error) throw error;
    console.error("[context-preview] assembly preview failed", error);
    throw createError({ statusCode: 500, statusMessage: error instanceof Error ? error.message : "无法生成发送前预览" });
  }
});
