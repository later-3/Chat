import { defineEventHandler, readBody } from "nitro/h3";
import { memoryHttpError, parseMemoryTargetValue } from "../../../memory/http.js";
import { getMemoryStoreManager } from "../../../memory/manager-runtime.js";

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody<unknown>(event);
    if (typeof body !== "object" || body === null || Array.isArray(body) || !("target" in body)) {
      throw new Error("Memory重建必须提供target");
    }
    return await getMemoryStoreManager().rebuild(
      parseMemoryTargetValue((body as Record<string, unknown>).target),
    );
  } catch (error) {
    return memoryHttpError(error);
  }
});
