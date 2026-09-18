import { createError, defineEventHandler, readBody } from "nitro/h3";
import { enableLongAgents, LongAgentLifecycleError } from "../../../long-agents/lifecycle.js";

export default defineEventHandler(async (event) => {
  const body: unknown = await readBody(event);
  if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length > 0) {
    throw createError({ statusCode: 400, statusMessage: "启用助手不接受配置字段" });
  }
  try {
    const agent = await enableLongAgents();
    return { schemaVersion: 1, agent: { id: agent.id, name: agent.name, description: agent.description,
      defaultProjectId: agent.defaultProjectId, status: agent.status } };
  } catch (error) {
    if (error instanceof LongAgentLifecycleError) {
      throw createError({ statusCode: error.statusCode, statusMessage: error.message });
    }
    throw createError({ statusCode: 503, statusMessage: "启用助手失败，请确认 NanoClaw Host 已更新、启动并完成服务认证后重试" });
  }
});
