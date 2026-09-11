import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { requestNanoClawTasks } from "../../../../long-agents/nanoclaw-client.js";
import { readLongAgentRegistry } from "../../../../long-agents/storage.js";

/** Lists one Long Agent's scheduled tasks (its own NanoClaw Agent Group only). */
export default defineEventHandler(async (event) => {
  const longAgentId = getRouterParam(event, "longAgentId");
  if (!longAgentId) throw createError({ statusCode: 400, statusMessage: "缺少Long Agent ID" });
  try {
    const registry = await readLongAgentRegistry();
    const agent = registry.agents.find((candidate) => candidate.id === longAgentId);
    if (agent === undefined) throw createError({ statusCode: 404, statusMessage: "找不到Long Agent" });
    const instance = registry.instances.find((candidate) => candidate.id === agent.instanceId);
    if (instance === undefined) throw createError({ statusCode: 400, statusMessage: `找不到NanoClaw实例: ${agent.instanceId}` });
    const status = getQuery(event).status;
    if (status !== undefined && status !== "pending" && status !== "paused") {
      throw createError({ statusCode: 400, statusMessage: "status必须是pending或paused" });
    }
    const response = await requestNanoClawTasks({
      instance,
      agentGroupId: agent.nanoclawAgentGroupId,
      operation: { operation: "list", ...(status === undefined ? {} : { status }) },
    });
    return { schemaVersion: 1, tasks: response.tasks ?? [] };
  } catch (error) {
    if (error !== null && typeof error === "object" && "statusCode" in error) throw error;
    throw createError({ statusCode: 502, statusMessage: error instanceof Error ? error.message : String(error) });
  }
});
