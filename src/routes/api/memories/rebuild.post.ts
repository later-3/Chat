import { defineEventHandler } from "nitro/h3";
import { memoryHttpError } from "../../../memory/http.js";
import { getChatMemoryService } from "../../../memory/runtime.js";

export default defineEventHandler(async () => {
  try {
    const service = await getChatMemoryService();
    return await service.rebuild();
  } catch (error) {
    return memoryHttpError(error);
  }
});
