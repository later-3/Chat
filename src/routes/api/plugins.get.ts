import { createError, defineEventHandler, getQuery } from "nitro/h3";
import { resolveResourceCwd, resolveResourceProject, ResourceAccessError } from "../../resources/access.js";
import { listPiPlugins } from "../../resources/plugins.js";

export default defineEventHandler(async (event) => {
  try {
    const query = getQuery(event);
    if (query.projectId !== undefined) {
      const project = await resolveResourceProject(query.projectId, query.cwd);
      return await listPiPlugins(project.cwd, project.projectId);
    }
    return await listPiPlugins(await resolveResourceCwd(query.cwd));
  } catch (error) {
    throw createError({
      statusCode: error instanceof ResourceAccessError ? error.statusCode : 500,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
