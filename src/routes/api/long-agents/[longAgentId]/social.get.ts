import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { listLongAgentFeed } from "../../../../long-agents/social.js";

/** 朋友圈时间流：默认全部长期同事的动态（用户要求"默认可见全部"），可按天筛选。 */
export default defineEventHandler(async (event) => {
  const longAgentId = getRouterParam(event, "longAgentId");
  if (!longAgentId) throw createError({ statusCode: 400, statusMessage: "缺少Long Agent ID" });
  try {
    const query = getQuery(event);
    return {
      schemaVersion: 1,
      posts: await listLongAgentFeed({
        ...(typeof query.from === "string" ? { from: query.from } : {}),
        ...(typeof query.to === "string" ? { to: query.to } : {}),
        ...(typeof query.only === "string" && query.only === "self" ? { longAgentId } : {}),
        ...(typeof query.limit === "string" && /^\d+$/.test(query.limit) ? { limit: Number(query.limit) } : {}),
      }),
    };
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) });
  }
});
