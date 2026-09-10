import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { appendChatAuditEvent } from "../../../../../../audit-log.js";
import { resolveProjectContext } from "../../../../../../projects/registry.js";
import { parseWorkflowAgentResources } from "../../../../../../workflows/agent-config.js";
import { updateAgentDurableConfig } from "../../../../../../workflows/agent-model-config.js";
import { getChatWorkflowDefinition } from "../../../../../../workflows/registry.js";

/** Persists one Workflow Agent's Project-scoped resource (Skill/Extension/Plugin) policy. */
export default defineEventHandler(async (event) => {
  const workflowId = getRouterParam(event, "workflowId");
  const agentId = getRouterParam(event, "agentId");
  const workflow = workflowId === undefined ? undefined : getChatWorkflowDefinition(workflowId);
  const agent = workflow?.agents.find((candidate) => candidate.id === agentId);
  if (workflow === undefined || agent === undefined) {
    throw createError({ statusCode: 404, statusMessage: "找不到Workflow或Agent" });
  }

  try {
    const body = await readBody<unknown>(event);
    if (typeof body !== "object" || body === null) throw new Error("请求体必须是对象");
    const projectId = "projectId" in body && typeof body.projectId === "string" ? body.projectId : undefined;
    if (projectId === undefined) throw new Error("必须提供projectId");
    if (!("resources" in body)) throw new Error("必须提供resources");
    const resources = parseWorkflowAgentResources(body.resources);
    const project = await resolveProjectContext(projectId);
    const config = await updateAgentDurableConfig(project.projectDataDir, workflow.id, agent.id, { resources });
    await appendChatAuditEvent({
      action: "agent.resources.update",
      target: { type: "project", projectId, workflowId: workflow.id, agentId: agent.id },
      details: {
        mode: resources.mode,
        skillPaths: resources.mode === "explicit" ? resources.skillPaths.length : 0,
        extensionPaths: resources.mode === "explicit" ? resources.extensionPaths.length : 0,
        pluginSources: resources.mode === "explicit" ? resources.pluginSources.length : 0,
      },
    }, project.chatHome);
    return config;
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
