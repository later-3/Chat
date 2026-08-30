import { createError, defineEventHandler, readBody } from "nitro/h3";
import { writeChatRootConfig } from "../../chat-config.js";

/** Replaces .chat/config.json after strict full-document validation. */
export default defineEventHandler(async (event) => {
  try {
    return await writeChatRootConfig(await readBody<unknown>(event));
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
