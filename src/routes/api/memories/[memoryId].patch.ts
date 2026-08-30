import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { memoryHttpError, parseUpdateMemoryBody } from "../../../memory/http.js";
import { getChatMemoryService } from "../../../memory/runtime.js";

export default defineEventHandler(async (event) => {
  try {
    const memoryId = getRouterParam(event, "memoryId");
    if (memoryId === undefined) throw new Error("missing memoryId route parameter");
    const service = await getChatMemoryService();
    return { memory: await service.update(memoryId, parseUpdateMemoryBody(await readBody<unknown>(event))) };
  } catch (error) {
    return memoryHttpError(error);
  }
});
