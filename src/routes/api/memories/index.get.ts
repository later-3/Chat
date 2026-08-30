import { defineEventHandler, getQuery, setResponseHeader } from "nitro/h3";
import { memoryHttpError, parseListMemoryQuery } from "../../../memory/http.js";
import { getChatMemoryService } from "../../../memory/runtime.js";

export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  try {
    const service = await getChatMemoryService();
    return service.list(parseListMemoryQuery(getQuery(event)));
  } catch (error) {
    return memoryHttpError(error);
  }
});
