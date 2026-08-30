import { createError, defineEventHandler, readBody } from "nitro/h3";
import { openProject } from "../../../projects/registry.js";

export default defineEventHandler(async (event) => {
  const body = await readBody<unknown>(event);
  const cwd = typeof body === "object" && body !== null && "cwd" in body
    ? (body as { cwd?: unknown }).cwd
    : undefined;
  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw createError({ statusCode: 400, statusMessage: "cwd必须是非空字符串" });
  }
  try {
    const project = await openProject({ path: cwd });
    return {
      projectId: project.projectId,
      cwd: project.cwd,
      projectRoot: project.projectRoot,
      projectKey: project.projectId,
    };
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
