import { defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { memoryHttpError, parseMemoryTargetQuery } from "../../../memory/http.js";
import { getMemoryStoreManager } from "../../../memory/manager-runtime.js";

export default defineEventHandler(async (event) => {
  try {
    const memoryId = getRouterParam(event, "memoryId");
    if (memoryId === undefined) throw new Error("missing memoryId route parameter");
    return await getMemoryStoreManager().delete({ target: parseMemoryTargetQuery(getQuery(event)), memoryId });
  } catch (error) {
    return memoryHttpError(error);
  }
});
