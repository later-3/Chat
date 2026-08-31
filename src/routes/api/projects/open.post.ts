import { createError, defineEventHandler, readBody } from "nitro/h3";
import { openProject } from "../../../projects/registry.js";

export default defineEventHandler(async (event) => {
  const body = await readBody<unknown>(event);
  if (typeof body !== "object" || body === null || Array.isArray(body)
    || Object.keys(body).some((field) => field !== "path")
    || !("path" in body) || typeof body.path !== "string" || body.path.trim() === "") {
    throw createError({ statusCode: 400, statusMessage: "path必须是非空字符串" });
  }
  try {
    const project = await openProject({
      path: body.path,
    });
    return {
      projectId: project.projectId,
      name: project.name,
      description: project.description,
      cwd: project.cwd,
      projectRoot: project.projectRoot,
    };
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
