import { defineEventHandler, getRouterParam } from "nitro/h3";
import { memoryHttpError } from "../../../memory/http.js";
import { getChatMemoryService } from "../../../memory/runtime.js";

export default defineEventHandler(async (event) => {
  try {
    const memoryId = getRouterParam(event, "memoryId");
    if (memoryId === undefined) throw new Error("missing memoryId route parameter");
    return await (await getChatMemoryService()).delete(memoryId);
  } catch (error) {
    return memoryHttpError(error);
  }
});
