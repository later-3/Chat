import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "nitro/h3";
import { readLongAgentAgentGroup } from "../../../../long-agents/agent-group-service.js";
import { projectLongAgentResourceError } from "../../../../long-agents/http-error.js";

export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  try {
    return await readLongAgentAgentGroup(getRouterParam(event, "longAgentId"));
  } catch (error) {
    throw createError(projectLongAgentResourceError(error, "读取Agent Group"));
  }
});
