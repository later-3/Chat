import { realpath, stat } from "node:fs/promises";
import { createError, defineEventHandler, readBody } from "nitro/h3";
import { allowFileRoot } from "../../../files/access.js";

export default defineEventHandler(async (event) => {
  const body = await readBody<unknown>(event);
  const cwd = typeof body === "object" && body !== null && "cwd" in body
    ? (body as { cwd?: unknown }).cwd
    : undefined;
  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw createError({ statusCode: 400, statusMessage: "cwd必须是非空字符串" });
  }
  try {
    const resolved = await realpath(cwd);
    if (!(await stat(resolved)).isDirectory()) throw new Error("路径不是目录");
    allowFileRoot(resolved);
    return { cwd: resolved, projectRoot: resolved, projectKey: resolved };
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
