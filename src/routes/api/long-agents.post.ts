import { createError, defineEventHandler, readBody } from "nitro/h3";
import { createLongAgent, LongAgentLifecycleError } from "../../long-agents/lifecycle.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Creates one Long Agent with full provisioning (config root, Daily Project, registry index). */
export default defineEventHandler(async (event) => {
  try {
    const body = await readBody<unknown>(event);
    if (!isRecord(body)) throw new LongAgentLifecycleError(400, "请求体必须是对象");
    const agent = await createLongAgent({
      id: typeof body.id === "string" ? body.id : "",
      name: typeof body.name === "string" ? body.name : "",
      ...(typeof body.description === "string" ? { description: body.description } : {}),
      instanceId: typeof body.instanceId === "string" ? body.instanceId : "",
      nanoclawAgentGroupId: typeof body.nanoclawAgentGroupId === "string" ? body.nanoclawAgentGroupId : "",
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
    if (error instanceof LongAgentLifecycleError) {
      throw createError({ statusCode: error.statusCode, statusMessage: error.message });
    }
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
