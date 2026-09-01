import { createError, defineEventHandler, getQuery } from "nitro/h3";
import { listChatTools } from "../../resources/tools.js";

export default defineEventHandler(async (event) => {
  try {
    const query = getQuery(event);
    if (typeof query.projectId !== "string" || query.projectId.trim() === "") {
      throw new Error("必须提供projectId");
    }
    return await listChatTools(query.projectId);
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
