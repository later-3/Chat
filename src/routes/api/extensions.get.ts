import { createError, defineEventHandler, getQuery } from "nitro/h3";
import { resolveResourceCwd, resolveResourceProject, ResourceAccessError } from "../../resources/access.js";
import { listPiExtensions } from "../../resources/extensions.js";

export default defineEventHandler(async (event) => {
  try {
    const query = getQuery(event);
    if (query.projectId !== undefined) {
      const project = await resolveResourceProject(query.projectId, query.cwd);
      return await listPiExtensions(project.cwd, project.projectId);
    }
    return await listPiExtensions(await resolveResourceCwd(query.cwd));
  } catch (error) {
    throw createError({
      statusCode: error instanceof ResourceAccessError ? error.statusCode : 500,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
