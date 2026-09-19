import { setResponseHeader, createError, defineEventHandler, getRouterParam } from "nitro/h3";
import { resolveChatHome } from "../../../../chat-home.js";
import { readFriendDays } from "../../../../long-agents/daily-service.js";
export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const id = getRouterParam(event, "longAgentId");
  if (!id) throw createError({ statusCode: 400, statusMessage: "缺少Friend ID" });
  try { return await readFriendDays(resolveChatHome(), id); }
  catch (error) { throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) }); }
});
