import { defineEventHandler, setResponseHeader } from "nitro/h3";
import { listChatSessions } from "../../session-read-model.js";

/** 浏览器通过Chat后端读取Session列表；这里是唯一的磁盘Session枚举入口。 */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  return { sessions: await listChatSessions(), runningSessionIds: [] };
});
