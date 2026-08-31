import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { resolveProjectContext } from "../../../../../../projects/registry.js";
import { clearAgentModelConfig } from "../../../../../../workflows/agent-model-config.js";
import { getChatWorkflowDefinition } from "../../../../../../workflows/registry.js";

/** Removes one Workflow Agent's durable model configuration, restoring the Workflow default. */
export default defineEventHandler(async (event) => {
  const workflowId = getRouterParam(event, "workflowId");
  const agentId = getRouterParam(event, "agentId");
  const workflow = workflowId === undefined ? undefined : getChatWorkflowDefinition(workflowId);
  const agent = workflow?.agents.find((candidate) => candidate.id === agentId);
  if (workflow === undefined || agent === undefined) {
    throw createError({ statusCode: 404, statusMessage: "找不到Workflow或Agent" });
  }

  try {
    const query = getQuery(event);
    if (typeof query.projectId !== "string" || query.projectId.trim() === "") {
      throw new Error("必须提供projectId");
    }
    const project = await resolveProjectContext(query.projectId);
    const removed = await clearAgentModelConfig(project.projectDataDir, workflow.id, agent.id);
    return { schemaVersion: 1, removed };
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
