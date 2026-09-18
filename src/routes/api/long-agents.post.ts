import { createError, defineEventHandler, readBody } from "nitro/h3";
import { createLongAgent, LongAgentLifecycleError } from "../../long-agents/lifecycle.js";
import { NanoClawGatewayError } from "../../long-agents/nanoclaw-client.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Creates one Long Agent with full provisioning (config root, Daily Project, registry index). */
export default defineEventHandler(async (event) => {
  try {
    const body = await readBody<unknown>(event);
    if (!isRecord(body)) throw new LongAgentLifecycleError(400, "请求体必须是对象");
    if (Object.keys(body).some((key) => !["id", "name", "description", "instanceId", "nanoclawAgentGroupId"].includes(key))
      || ["description", "instanceId", "nanoclawAgentGroupId"].some((key) => body[key] !== undefined && typeof body[key] !== "string")) {
      throw new LongAgentLifecycleError(400, "创建助手的字段无效");
    }
    const agent = await createLongAgent({
      id: typeof body.id === "string" ? body.id : "",
      name: typeof body.name === "string" ? body.name : "",
      ...(typeof body.description === "string" ? { description: body.description } : {}),
      ...(typeof body.instanceId === "string" ? { instanceId: body.instanceId } : {}),
      ...(typeof body.nanoclawAgentGroupId === "string" ? { nanoclawAgentGroupId: body.nanoclawAgentGroupId } : {}),
    });
    return {
      schemaVersion: 1,
      agent: {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        defaultProjectId: agent.defaultProjectId,
        status: agent.status,
      },
    };
  } catch (error) {
    if (error instanceof NanoClawGatewayError) {
      throw createError({ statusCode: 503, statusMessage: "创建助手需要可用且已更新的 NanoClaw Host，请检查连接与服务认证后重试" });
    }
    if (error instanceof LongAgentLifecycleError) {
      throw createError({ statusCode: error.statusCode, statusMessage: error.message });
    }
    throw createError({
      statusCode: 500,
      statusMessage: "创建助手失败，请检查服务日志后重试",
    });
  }
});
