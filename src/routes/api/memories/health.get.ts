import { defineEventHandler, getQuery, setResponseHeader } from "nitro/h3";
import { parseMemoryTargetQuery } from "../../../memory/http.js";
import { getMemoryStoreManager } from "../../../memory/manager-runtime.js";

export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  return getMemoryStoreManager().health(parseMemoryTargetQuery(getQuery(event)));
});
