import { createError, defineEventHandler, getRouterParam, readBody, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../chat-home.js";
import { exportArtifactVersion, listFriendArtifacts, notifyArtifact, resubmitArtifact, resolveNoteConflict, reviseArtifact } from "../../../../long-agents/artifacts/service.js";
import { FriendArtifactError } from "../../../../long-agents/artifacts/contract.js";

/**
 * User-side artifact operations: 补交已有产物 (resubmit), 修改产物 (revise), 补发通知 (notify),
 * 处理工作区冲突 (resolve), 导出当前版本到新文件 (export).
 * Submitting new model content is only possible from a work execution, never from this route.
 */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const longAgentId = getRouterParam(event, "longAgentId");
  if (!longAgentId) throw createError({ statusCode: 400, statusMessage: "缺少Long Agent ID" });
  try {
    const body = await readBody<unknown>(event);
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new FriendArtifactError(400, "产物操作必须是对象");
    const record = body as Record<string, unknown>;
    const operation = String(record.operation ?? "");
    const home = resolveChatHome();
    let operationResult: { path: string; relativePath: string } | null = null;
    if (operation === "resubmit") await resubmitArtifact(home, longAgentId, String(record.artifactId ?? ""));
    else if (operation === "revise") await reviseArtifact(home, longAgentId, { artifactId: record.artifactId, content: record.content });
    else if (operation === "notify") await notifyArtifact(home, longAgentId, String(record.artifactId ?? ""));
    else if (operation === "resolve") await resolveNoteConflict(home, longAgentId, { artifactId: record.artifactId, choice: record.choice });
    else if (operation === "export") operationResult = await exportArtifactVersion(home, longAgentId, {
      artifactId: record.artifactId,
      ...(typeof record.path === "string" ? { path: record.path } : {}),
    });
    else if (operation !== "list")
      throw new FriendArtifactError(400, "未知产物操作");
    const listed = await listFriendArtifacts(home, longAgentId, {
      ...(typeof record.from === "string" ? { from: record.from } : {}),
      ...(typeof record.to === "string" ? { to: record.to } : {}),
    });
    return { ...listed, operationResult };
  } catch (error) {
    throw createError({
      statusCode: error instanceof FriendArtifactError ? error.statusCode : 500,
      statusMessage: error instanceof FriendArtifactError ? error.message : "保存产物操作失败，请检查服务日志",
    });
  }
});
