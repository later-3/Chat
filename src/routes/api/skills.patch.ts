import { createError, defineEventHandler, readBody } from "nitro/h3";
import { resolveResourceCwd, resolveResourceProject, ResourceAccessError } from "../../resources/access.js";
import { setSkillModelInvocation } from "../../resources/skills.js";

export default defineEventHandler(async (event) => {
  const body = await readBody<unknown>(event);
  if (typeof body !== "object" || body === null) {
    throw createError({ statusCode: 400, statusMessage: "请求体必须是对象" });
  }
  const value = body as { projectId?: unknown; cwd?: unknown; filePath?: unknown; disableModelInvocation?: unknown };
  try {
    const project = value.projectId === undefined
      ? undefined
      : await resolveResourceProject(value.projectId, value.cwd);
    const cwd = project?.cwd ?? await resolveResourceCwd(value.cwd ?? process.cwd());
    if (typeof value.filePath !== "string" || typeof value.disableModelInvocation !== "boolean") {
      throw new ResourceAccessError(400, "filePath和disableModelInvocation无效");
    }
    await setSkillModelInvocation(cwd, value.filePath, value.disableModelInvocation, project?.projectId);
    return { success: true };
  } catch (error) {
    throw createError({
      statusCode: error instanceof ResourceAccessError ? error.statusCode : 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
