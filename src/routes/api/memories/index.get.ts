import { defineEventHandler, getQuery, setResponseHeader } from "nitro/h3";
import { memoryHttpError, parseListMemoryQuery, parseMemoryTargetQuery } from "../../../memory/http.js";
import { getMemoryStoreManager } from "../../../memory/manager-runtime.js";

export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  try {
    const query = getQuery(event);
    const target = parseMemoryTargetQuery(query);
    const { scope: _scope, projectId: _projectId, ...input } = parseListMemoryQuery(query);
    return await getMemoryStoreManager().list(target, input);
  } catch (error) {
    return memoryHttpError(error);
  }
});
