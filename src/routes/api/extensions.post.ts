import { createError, defineEventHandler, readBody } from "nitro/h3";
import { resolveResourceCwd, ResourceAccessError } from "../../resources/access.js";
import { listPiExtensions, togglePiExtension } from "../../resources/extensions.js";

export default defineEventHandler(async (event) => {
  const body = await readBody<unknown>(event);
  if (typeof body !== "object" || body === null) {
    throw createError({ statusCode: 400, statusMessage: "请求体必须是对象" });
  }
  const value = body as { cwd?: unknown; action?: unknown; path?: unknown };
  try {
    const cwd = await resolveResourceCwd(value.cwd);
    if ((value.action !== "enable" && value.action !== "disable") || typeof value.path !== "string") {
      throw new ResourceAccessError(400, "action必须是enable或disable，path必须是字符串");
    }
    await togglePiExtension(cwd, value.path, value.action === "enable");
    return { success: true, ...await listPiExtensions(cwd) };
  } catch (error) {
    throw createError({
      statusCode: error instanceof ResourceAccessError ? error.statusCode : 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
