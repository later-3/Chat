import { defineEventHandler, getRouterParam, createError } from "nitro/h3";
import { resolveChatHome } from "../../../../chat-home.js";
import { listFriendTasks } from "../../../../long-agents/tasks/service.js";
import { FriendTaskError } from "../../../../long-agents/tasks/contract.js";
export default defineEventHandler(async event => {
  try { return await listFriendTasks(resolveChatHome(), getRouterParam(event, "longAgentId") ?? ""); }
  catch (error) { throw createError({ statusCode: error instanceof FriendTaskError ? error.statusCode : 500, statusMessage: error instanceof FriendTaskError ? error.message : "读取任务失败，请检查服务日志" }); }
});
