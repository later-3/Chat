import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { memoryHttpError, parseMemoryTargetValue, parseUpdateMemoryBody } from "../../../memory/http.js";
import { getMemoryStoreManager } from "../../../memory/manager-runtime.js";

export default defineEventHandler(async (event) => {
  try {
    const memoryId = getRouterParam(event, "memoryId");
    if (memoryId === undefined) throw new Error("missing memoryId route parameter");
    const body = await readBody<unknown>(event);
    if (typeof body !== "object" || body === null || Array.isArray(body) || !("target" in body)) {
      throw new Error("Memory更新必须提供target");
    }
    const target = parseMemoryTargetValue((body as Record<string, unknown>).target);
    const { scope: _scope, projectId: _projectId, ...input } = parseUpdateMemoryBody(body);
    return { memory: await getMemoryStoreManager().update({ target, memoryId }, input) };
  } catch (error) {
    return memoryHttpError(error);
  }
});
