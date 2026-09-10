import { createError, defineEventHandler, readBody } from "nitro/h3";
import { CHAT_MODEL_CAPABILITIES } from "../../model-capabilities.js";
import {
  InvalidChatModelsConfigError,
  writeChatModelsConfig,
} from "../../models-config.js";

/** Replaces Chat Home's models.json after Pi validates the complete document. */
export default defineEventHandler(async (event) => {
  try {
    const document = await writeChatModelsConfig(await readBody<unknown>(event));
    return { ...document, capabilities: CHAT_MODEL_CAPABILITIES };
  } catch (error) {
    throw createError({
      statusCode: error instanceof InvalidChatModelsConfigError ? 400 : 500,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
