import { defineEventHandler, getRouterParam, setResponseHeader } from "nitro/h3";
import { memoryHttpError } from "../../../memory/http.js";
import { getChatMemoryService } from "../../../memory/runtime.js";

export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  try {
    const memoryId = getRouterParam(event, "memoryId");
    if (memoryId === undefined) throw new Error("missing memoryId route parameter");
    return { memory: (await getChatMemoryService()).get(memoryId) };
  } catch (error) {
    return memoryHttpError(error);
  }
});
