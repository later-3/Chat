import { defineEventHandler, setResponseHeader } from "nitro/h3";
import { getChatMemoryService } from "../../../memory/runtime.js";

export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  return (await getChatMemoryService()).health();
});
