import { createError, defineEventHandler, getQuery, setResponseHeader } from "nitro/h3";
import { listChatSessions } from "../../session-read-model.js";

/** 浏览器通过Chat后端读取Session列表；这里是唯一的磁盘Session枚举入口。 */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const projectId = getQuery(event).projectId;
  if (projectId !== undefined && typeof projectId !== "string") {
    throw createError({ statusCode: 400, statusMessage: "projectId必须是字符串" });
  }
  return { sessions: await listChatSessions(projectId), runningSessionIds: [] };
});
