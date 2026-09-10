import { createError, defineEventHandler, getRouterParam } from "nitro/h3";
import { deleteLongAgent, LongAgentLifecycleError } from "../../../long-agents/lifecycle.js";

/** Two-phase delete: the Agent must be archived first. */
export default defineEventHandler(async (event) => {
  const longAgentId = getRouterParam(event, "longAgentId");
  if (!longAgentId) throw createError({ statusCode: 400, statusMessage: "缺少Long Agent ID" });
  try {
    await deleteLongAgent(longAgentId);
    return { schemaVersion: 1, deleted: true };
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
