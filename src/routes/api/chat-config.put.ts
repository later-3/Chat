import { createError, defineEventHandler, getQuery, readBody } from "nitro/h3";
import { writeChatRootConfig, writeProjectChatConfig } from "../../chat-config.js";

/** Replaces .chat/config.json after strict full-document validation. */
export default defineEventHandler(async (event) => {
  try {
    const body = await readBody<unknown>(event);
    const query = getQuery(event);
    if (query.scope === "project") {
      if (typeof query.projectId !== "string" || query.projectId.trim() === "") {
        throw new Error("Project配置必须提供projectId");
      }
      return writeProjectChatConfig(query.projectId, body);
    }
    return await writeChatRootConfig(body);
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
