import { defineEventHandler, getRouterParam, createError, readBody } from "nitro/h3";
import { resolveChatHome } from "../../../../chat-home.js";
import { manageFriendTask } from "../../../../long-agents/tasks/service.js";
import { FriendTaskError } from "../../../../long-agents/tasks/contract.js";
import { NanoClawGatewayError } from "../../../../long-agents/nanoclaw-client.js";
export default defineEventHandler(async event => {
  try { return await manageFriendTask(resolveChatHome(), getRouterParam(event, "longAgentId") ?? "", await readBody<unknown>(event)); }
  catch (error) { throw createError({ statusCode: error instanceof FriendTaskError ? error.statusCode : error instanceof NanoClawGatewayError ? error.statusCode === 400 ? 400 : 502 : 500,
    statusMessage: error instanceof FriendTaskError ? error.message : error instanceof NanoClawGatewayError ? error.statusCode === 400 ? "任务时间规则无效，请检查cron表达式、时区和每条周期每天最多4次的限制" : "任务调度暂不可用，请检查NanoClaw连接与版本" : "保存任务失败，请检查服务日志" }); }
});
