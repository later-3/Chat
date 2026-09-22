import { defineEventHandler, createError, readBody, setResponseStatus } from "nitro/h3";
import { resolveChatHome } from "../../../../../chat-home.js";
import { acceptTaskTrigger } from "../../../../../long-agents/tasks/service.js";
import { FriendTaskError, record } from "../../../../../long-agents/tasks/contract.js";
/** Service authentication is enforced by the existing Channel middleware. */
export default defineEventHandler(async event => {
  try {
    const body: unknown = await readBody(event); record(body);
    if (body.source !== "time" && body.source !== "event") throw new FriendTaskError(400, "服务事件不接受手动触发来源");
    const result = await acceptTaskTrigger(resolveChatHome(), body); setResponseStatus(event, 202); return result;
  } catch (error) { throw createError({ statusCode: error instanceof FriendTaskError ? error.statusCode : 500, statusMessage: error instanceof FriendTaskError ? error.message : "触发任务持久化失败" }); }
});
