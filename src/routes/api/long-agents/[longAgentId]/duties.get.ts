import { defineEventHandler, getRouterParam, createError } from "nitro/h3";
import { resolveChatHome } from "../../../../chat-home.js";
import { listFriendDuties } from "../../../../long-agents/duties/service.js";
import { FriendDutyError } from "../../../../long-agents/duties/contract.js";
export default defineEventHandler(async event => {
  try { return await listFriendDuties(resolveChatHome(), getRouterParam(event, "longAgentId") ?? ""); }
  catch (error) { throw createError({ statusCode: error instanceof FriendDutyError ? error.statusCode : 500, statusMessage: error instanceof FriendDutyError ? error.message : "读取职责失败，请检查服务日志" }); }
});
