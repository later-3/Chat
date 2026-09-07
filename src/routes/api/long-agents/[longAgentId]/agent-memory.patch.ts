import { createError, defineEventHandler, getRouterParam, readBody, setResponseHeader } from "nitro/h3";
import { mutateLongAgentMemory } from "../../../../long-agents/agent-group-service.js";
import { projectLongAgentResourceError } from "../../../../long-agents/http-error.js";

export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  try {
    return await mutateLongAgentMemory(
      getRouterParam(event, "longAgentId"),
      await readBody<unknown>(event),
    );
  } catch (error) {
    throw createError(projectLongAgentResourceError(error, "更新Agent Memory"));
  }
});
