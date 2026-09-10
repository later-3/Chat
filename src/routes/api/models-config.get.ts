import { createError, defineEventHandler } from "nitro/h3";
import { CHAT_MODEL_CAPABILITIES } from "../../model-capabilities.js";
import { readChatModelsConfig } from "../../models-config.js";

/** Reads only Chat Home's models.json; it never imports the user's Pi configuration. */
export default defineEventHandler(async () => {
  try {
    const document = await readChatModelsConfig();
    return { ...document, capabilities: CHAT_MODEL_CAPABILITIES };
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
