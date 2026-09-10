import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { appendChatAuditEvent } from "../../../../../../audit-log.js";
import { resolveProjectContext } from "../../../../../../projects/registry.js";
import { updateAgentDurableConfig } from "../../../../../../workflows/agent-model-config.js";
import { getChatWorkflowDefinition } from "../../../../../../workflows/registry.js";

/** Removes only the Project-scoped resource policy and restores the Workflow default. */
export default defineEventHandler(async (event) => {
  const workflowId = getRouterParam(event, "workflowId");
  const agentId = getRouterParam(event, "agentId");
  const workflow = workflowId === undefined ? undefined : getChatWorkflowDefinition(workflowId);
  const agent = workflow?.agents.find((candidate) => candidate.id === agentId);
  if (workflow === undefined || agent === undefined) {
    throw createError({ statusCode: 404, statusMessage: "找不到Workflow或Agent" });
  }

  try {
    const projectId = getQuery(event).projectId;
    if (typeof projectId !== "string" || projectId.trim() === "") throw new Error("必须提供projectId");
    const project = await resolveProjectContext(projectId);
    await updateAgentDurableConfig(project.projectDataDir, workflow.id, agent.id, { resources: null });
    await appendChatAuditEvent({
      action: "agent.resources.clear",
      target: { type: "project", projectId, workflowId: workflow.id, agentId: agent.id },
      details: {},
    }, project.chatHome);
    return { cleared: true };
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
