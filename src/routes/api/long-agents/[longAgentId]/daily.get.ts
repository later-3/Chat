import { setResponseHeader, createError, defineEventHandler, getRouterParam, getQuery } from "nitro/h3";
import { resolveChatHome } from "../../../../chat-home.js";
import { readFriendDays } from "../../../../long-agents/daily-service.js";
export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const id = getRouterParam(event, "longAgentId");
  if (!id) throw createError({ statusCode: 400, statusMessage: "缺少Friend ID" });
  const year = getQuery(event).year;
  if (year !== undefined && (typeof year !== "string" || !/^\d{4}$/.test(year))) throw createError({ statusCode: 400, statusMessage: "日历年份无效" });
  try { return await readFriendDays(resolveChatHome(), id, year === undefined ? undefined : Number(year)); }
  catch (error) { throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) }); }
});
