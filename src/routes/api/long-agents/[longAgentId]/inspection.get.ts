import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { readLongAgentRegistry } from "../../../../long-agents/storage.js";
import { createLongAgentDefinition } from "../../../../long-agents/runtime.js";
import { resolveProjectContext } from "../../../../projects/registry.js";
import { inspectWorkflowAgent } from "../../../../workflows/agent-inspection.js";

/**
 * Resolves one Long Agent's effective assembly (Skills、Tools、Prompt 等) through
 * the exact same Pi assembly path used by execution. Read-only; execution and
 * inspection always resolve the same definition.
 */
export default defineEventHandler(async (event) => {
  const longAgentId = getRouterParam(event, "longAgentId");
  if (!longAgentId) throw createError({ statusCode: 400, statusMessage: "缺少Long Agent ID" });
  try {
    const registry = await readLongAgentRegistry();
    const agent = registry.agents.find((candidate) => candidate.id === longAgentId);
    if (agent === undefined) throw createError({ statusCode: 404, statusMessage: "找不到Long Agent" });

    const query = getQuery(event);
    const projectId = typeof query.projectId === "string" && query.projectId.trim() !== ""
      ? query.projectId
      : agent.defaultProjectId;
    const project = await resolveProjectContext(projectId);

    return await inspectWorkflowAgent({
      projectId: project.projectId,
      chatHome: project.chatHome,
      cwd: project.cwd,
      defaultAgent: createLongAgentDefinition(agent),
      agentId: agent.id,
      longAgentId: agent.id,
    });
  } catch (error) {
    if (error !== null && typeof error === "object" && "statusCode" in error) throw error;
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
