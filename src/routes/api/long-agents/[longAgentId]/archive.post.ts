import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { archiveLongAgent, LongAgentLifecycleError, unarchiveLongAgent } from "../../../../long-agents/lifecycle.js";

/** Archives (or restores with ?restore=true) one Long Agent. */
export default defineEventHandler(async (event) => {
  const longAgentId = getRouterParam(event, "longAgentId");
  if (!longAgentId) throw createError({ statusCode: 400, statusMessage: "缺少Long Agent ID" });
  try {
    const restore = getQuery(event).restore === "true";
    if (restore) await unarchiveLongAgent(longAgentId);
    else await archiveLongAgent(longAgentId);
    return { schemaVersion: 1, status: restore ? "active" : "archived" };
  } catch (error) {
    if (error instanceof LongAgentLifecycleError) {
      throw createError({ statusCode: error.statusCode, statusMessage: error.message });
    }
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
