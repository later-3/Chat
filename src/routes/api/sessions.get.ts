import { createError, defineEventHandler, getQuery, setResponseHeader } from "nitro/h3";
import { listChatSessions } from "../../session-read-model.js";
import { listRemovedChatSessions } from "../../session-removal.js";
import { SessionOwnerResolutionError } from "../../session-owner.js";

/** 浏览器读取active Session；底层磁盘枚举由session-files.ts统一复用Pi。 */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const projectId = getQuery(event).projectId;
  if (projectId !== undefined && typeof projectId !== "string") {
    throw createError({ statusCode: 400, statusMessage: "projectId必须是字符串" });
  }
  if (typeof projectId === "string") {
    await listRemovedChatSessions(projectId).catch((error: unknown) => {
      console.error(`清理Project ${projectId}过期Session失败: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  try {
    return { sessions: await listChatSessions(projectId), runningSessionIds: [] };
  } catch (error) {
    if (error instanceof SessionOwnerResolutionError) {
      throw createError({ statusCode: 500, statusMessage: error.message });
    }
    throw error;
  }
});
