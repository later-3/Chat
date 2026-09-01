import { createError, defineEventHandler, readBody } from "nitro/h3";
import {
  InvalidChatModelsConfigError,
  writeChatModelsConfig,
} from "../../models-config.js";

/** Replaces Chat Home's models.json after Pi validates the complete document. */
export default defineEventHandler(async (event) => {
  try {
    return await writeChatModelsConfig(await readBody<unknown>(event));
  } catch (error) {
    throw createError({
      statusCode: error instanceof InvalidChatModelsConfigError ? 400 : 500,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
