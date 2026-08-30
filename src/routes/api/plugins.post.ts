import { createError, defineEventHandler, readBody } from "nitro/h3";
import { resolveResourceCwd, resolveResourceProject, ResourceAccessError } from "../../resources/access.js";
import { changePiPlugin } from "../../resources/plugins.js";

const ACTIONS = new Set(["install", "remove", "update", "disable", "enable"] as const);

export default defineEventHandler(async (event) => {
  const body = await readBody<unknown>(event);
  if (typeof body !== "object" || body === null) {
    throw createError({ statusCode: 400, statusMessage: "请求体必须是对象" });
  }
  const value = body as { projectId?: unknown; cwd?: unknown; action?: unknown; source?: unknown; scope?: unknown };
  try {
    const project = value.projectId === undefined
      ? undefined
      : await resolveResourceProject(value.projectId, value.cwd);
    const cwd = project?.cwd ?? await resolveResourceCwd(value.cwd);
    if (typeof value.action !== "string" || !ACTIONS.has(value.action as never)) {
      throw new ResourceAccessError(400, "Plugin action无效");
    }
    if (typeof value.source !== "string" || value.source.trim() === "") {
      throw new ResourceAccessError(400, "Plugin source必须是非空字符串");
    }
    return await changePiPlugin({
      ...(project === undefined ? {} : { projectId: project.projectId }),
      cwd,
      action: value.action as "install" | "remove" | "update" | "disable" | "enable",
      source: value.source.trim(),
      scope: value.scope === "project" ? "project" : "global",
    });
  } catch (error) {
    throw createError({
      statusCode: error instanceof ResourceAccessError ? error.statusCode : 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
