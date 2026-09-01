import { createError, defineEventHandler } from "nitro/h3";
import { readChatModelsConfig } from "../../models-config.js";

/** Reads only Chat Home's models.json; it never imports the user's Pi configuration. */
export default defineEventHandler(async () => {
  try {
    return await readChatModelsConfig();
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
