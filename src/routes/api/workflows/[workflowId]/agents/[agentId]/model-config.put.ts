import { join } from "node:path";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolveProjectContext } from "../../../../../../projects/registry.js";
import { writeAgentModelConfig } from "../../../../../../workflows/agent-model-config.js";
import { getChatWorkflowDefinition } from "../../../../../../workflows/registry.js";

function errorResponse(error: unknown): never {
  throw createError({
    statusCode: 400,
    statusMessage: error instanceof Error ? error.message : String(error),
  });
}

/** Persists one Workflow Agent's durable model configuration for a Project. */
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
    if (typeof body !== "object" || body === null) {
      throw createError({ statusCode: 400, statusMessage: "请求体必须是对象" });
    }
    const rawProjectId = "projectId" in body && typeof body.projectId === "string" ? body.projectId : undefined;
    if (rawProjectId === undefined) throw new Error("必须提供projectId");
    const project = await resolveProjectContext(rawProjectId);

    const rawModel = "model" in body && typeof body.model === "object" && body.model !== null ? body.model : undefined;
    const rawThinkingLevel = "thinkingLevel" in body && typeof body.thinkingLevel === "string"
      ? body.thinkingLevel
      : undefined;
    if (rawModel === undefined && rawThinkingLevel === undefined) {
      throw new Error("至少需要model或thinkingLevel");
    }
    if (rawModel !== undefined && ("provider" in rawModel || "modelId" in rawModel)) {
      const provider = "provider" in rawModel && typeof rawModel.provider === "string" ? rawModel.provider : undefined;
      const modelId = "modelId" in rawModel && typeof rawModel.modelId === "string" ? rawModel.modelId : undefined;
      if (provider === undefined || modelId === undefined) throw new Error("model必须包含provider和modelId");
      const runtime = await ModelRuntime.create({
        authPath: join(project.agentDir, "auth.json"),
        modelsPath: join(project.agentDir, "models.json"),
      });
      const model = runtime.getModel(provider, modelId);
      if (model === undefined) throw new Error(`找不到Model: ${provider}/${modelId}`);
      if (!runtime.hasConfiguredAuth(model.provider)) throw new Error(`Provider没有认证: ${model.provider}`);
    }

    const config = await writeAgentModelConfig(project.projectDataDir, workflow.id, agent.id, {
      schemaVersion: 1,
      ...(rawModel === undefined ? {} : { model: rawModel }),
      ...(rawThinkingLevel === undefined ? {} : { thinkingLevel: rawThinkingLevel }),
    });
    return config;
  } catch (error) {
    return errorResponse(error);
  }
});
