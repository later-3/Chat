import { defineEventHandler, readBody, setResponseStatus } from "nitro/h3";
import { memoryHttpError, parseCreateMemoryBody } from "../../../memory/http.js";
import { getChatMemoryService } from "../../../memory/runtime.js";

export default defineEventHandler(async (event) => {
  try {
    const service = await getChatMemoryService();
    const memory = await service.create(parseCreateMemoryBody(await readBody<unknown>(event)));
    setResponseStatus(event, 201);
    return { memory };
  } catch (error) {
    return memoryHttpError(error);
  }
});
