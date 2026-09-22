import { defineEventHandler, getRouterParam, createError, readBody } from "nitro/h3";
import { resolveChatHome } from "../../../../chat-home.js";
import { manageFriendDuty } from "../../../../long-agents/duties/service.js";
import { FriendDutyError } from "../../../../long-agents/duties/contract.js";
import { NanoClawGatewayError } from "../../../../long-agents/nanoclaw-client.js";
export default defineEventHandler(async event => {
  try {
    const body = await readBody<unknown>(event);
    // Web callers are always the user; the agent tool passes its own source and turn context.
    return await manageFriendDuty(resolveChatHome(), getRouterParam(event, "longAgentId") ?? "",
      { ...(typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}), source: "user" });
  } catch (error) {
    throw createError({ statusCode: error instanceof FriendDutyError ? error.statusCode : error instanceof NanoClawGatewayError ? error.statusCode === 400 ? 400 : 502 : 500,
      statusMessage: error instanceof FriendDutyError ? error.message : error instanceof NanoClawGatewayError ? "职责调度暂不可用，已保存的定义会由维护循环重试" : "保存职责失败，请检查服务日志" });
  }
});
