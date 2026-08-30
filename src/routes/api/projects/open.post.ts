import { createError, defineEventHandler, readBody } from "nitro/h3";
import { openProject } from "../../../projects/registry.js";

export default defineEventHandler(async (event) => {
  const body = await readBody<unknown>(event);
  if (typeof body !== "object" || body === null || !("path" in body) || typeof body.path !== "string") {
    throw createError({ statusCode: 400, statusMessage: "path必须是非空字符串" });
  }
  const value = body as {
    path: string;
    createIfMissing?: unknown;
    id?: unknown;
    name?: unknown;
    description?: unknown;
  };
  try {
    return await openProject({
      path: value.path,
      createIfMissing: value.createIfMissing === true,
      ...(typeof value.id === "string" ? { id: value.id } : {}),
      ...(typeof value.name === "string" ? { name: value.name } : {}),
      ...(typeof value.description === "string" ? { description: value.description } : {}),
    });
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
