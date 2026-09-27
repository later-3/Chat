import { defineEventHandler, getQuery, setResponseHeader } from "nitro/h3";
import { memoryHttpError, parseMemoryTargetQuery } from "../../../memory/http.js";
import { getMemoryStoreManager } from "../../../memory/manager-runtime.js";

export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  try { return await getMemoryStoreManager().health(parseMemoryTargetQuery(getQuery(event))); }
  catch (error) { return memoryHttpError(error); }
});
