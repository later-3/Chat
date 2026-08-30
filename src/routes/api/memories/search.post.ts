import { defineEventHandler, readBody } from "nitro/h3";
import { memoryHttpError, parseMemoryTargetsBody, parseSearchMemoryBody } from "../../../memory/http.js";
import { getMemoryStoreManager } from "../../../memory/manager-runtime.js";

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody<unknown>(event);
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("request body must be an object");
    const targets = parseMemoryTargetsBody(body as Record<string, unknown>);
    const { scope: _scope, projectId: _projectId, ...input } = parseSearchMemoryBody(body);
    return { results: await getMemoryStoreManager().search({ ...input, targets }) };
  } catch (error) {
    return memoryHttpError(error);
  }
});
