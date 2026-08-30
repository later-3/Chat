import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { setProjectTrust } from "../../../../projects/trust.js";

export default defineEventHandler(async (event) => {
  const projectId = getRouterParam(event, "projectId");
  const body = await readBody<unknown>(event);
  if (projectId === undefined) throw createError({ statusCode: 400, statusMessage: "缺少projectId" });
  if (typeof body !== "object" || body === null || !("trusted" in body) || typeof body.trusted !== "boolean") {
    throw createError({ statusCode: 400, statusMessage: "trusted必须是布尔值" });
  }
  try {
    return await setProjectTrust(projectId, body.trusted);
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) });
  }
});
