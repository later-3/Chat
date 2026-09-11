import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { buildLongAgentActivity } from "../../../../long-agents/activity.js";
import { readLongAgentRegistry } from "../../../../long-agents/storage.js";

function localDate(offsetDays = 0): string {
  const now = new Date();
  now.setDate(now.getDate() + offsetDays);
  return `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** 活动日历数据：某 Long Agent 每天做了多少轮、用了多少 token、调了哪些工具。 */
export default defineEventHandler(async (event) => {
  const longAgentId = getRouterParam(event, "longAgentId");
  if (!longAgentId) throw createError({ statusCode: 400, statusMessage: "缺少Long Agent ID" });
  try {
    const registry = await readLongAgentRegistry();
    if (registry.agents.every((agent) => agent.id !== longAgentId)) {
      throw createError({ statusCode: 404, statusMessage: "找不到Long Agent" });
    }
    const query = getQuery(event);
    const from = typeof query.from === "string" && query.from.trim() !== "" ? query.from : localDate(-14);
    const to = typeof query.to === "string" && query.to.trim() !== "" ? query.to : localDate();
    return await buildLongAgentActivity({ longAgentId, from, to });
  } catch (error) {
    if (error !== null && typeof error === "object" && "statusCode" in error) throw error;
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) });
  }
});
