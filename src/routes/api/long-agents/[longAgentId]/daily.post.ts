import { setResponseHeader, createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { resolveChatHome } from "../../../../chat-home.js";
import { actOnFriendDay } from "../../../../long-agents/daily-service.js";
export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const id = getRouterParam(event, "longAgentId");
  if (!id) throw createError({ statusCode: 400, statusMessage: "缺少Friend ID" });
  try { return await actOnFriendDay(resolveChatHome(), id, await readBody<unknown>(event)); }
  catch (error) { throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) }); }
});
