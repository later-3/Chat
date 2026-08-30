import { defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import { memoryHttpError, parseMemoryTargetQuery } from "../../../memory/http.js";
import { getMemoryStoreManager } from "../../../memory/manager-runtime.js";

export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  try {
    const memoryId = getRouterParam(event, "memoryId");
    if (memoryId === undefined) throw new Error("missing memoryId route parameter");
    return { memory: await getMemoryStoreManager().get({ target: parseMemoryTargetQuery(getQuery(event)), memoryId }) };
  } catch (error) {
    return memoryHttpError(error);
  }
});
