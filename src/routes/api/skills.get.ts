import { createError, defineEventHandler, getQuery } from "nitro/h3";
import { resolveResourceCwd, ResourceAccessError } from "../../resources/access.js";
import { listPiSkills } from "../../resources/skills.js";

export default defineEventHandler(async (event) => {
  try {
    return await listPiSkills(await resolveResourceCwd(getQuery(event).cwd));
  } catch (error) {
    throw createError({
      statusCode: error instanceof ResourceAccessError ? error.statusCode : 500,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
