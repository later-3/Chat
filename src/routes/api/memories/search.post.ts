import { defineEventHandler, readBody } from "nitro/h3";
import { memoryHttpError, parseSearchMemoryBody } from "../../../memory/http.js";
import { getChatMemoryService } from "../../../memory/runtime.js";

export default defineEventHandler(async (event) => {
  try {
    const service = await getChatMemoryService();
    return { results: await service.search(parseSearchMemoryBody(await readBody<unknown>(event))) };
  } catch (error) {
    return memoryHttpError(error);
  }
});
