import { createError, defineEventHandler, getRouterParam } from "nitro/h3";
import { resolveProjectContext } from "../../../projects/registry.js";

export default defineEventHandler(async (event) => {
  const projectId = getRouterParam(event, "projectId");
  if (projectId === undefined) throw createError({ statusCode: 400, statusMessage: "缺少projectId" });
  try {
    return await resolveProjectContext(projectId);
  } catch (error) {
    throw createError({
      statusCode: 404,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
