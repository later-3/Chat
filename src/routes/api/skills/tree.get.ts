import { createError, defineEventHandler, getQuery } from "nitro/h3";
import { resolveResourceProject, ResourceAccessError } from "../../../resources/access.js";
import { buildChatSkillTree } from "../../../resources/skills-tree.js";

/** Returns the four-level Skill ownership tree (Chat system / Project / Workflow / Long Agent). */
export default defineEventHandler(async (event) => {
  try {
    const query = getQuery(event);
    if (typeof query.projectId !== "string" || query.projectId.trim() === "") {
      throw new ResourceAccessError(400, "必须提供projectId");
    }
    const project = await resolveResourceProject(query.projectId, query.cwd);
    return await buildChatSkillTree({ projectId: project.projectId });
  } catch (error) {
    throw createError({
      statusCode: error instanceof ResourceAccessError ? error.statusCode : 500,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
