import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { clearLongAgentAvatarImage, LongAgentAvatarError } from "../../../../long-agents/avatars.js";
import { readLongAgentConfiguration } from "../../../../long-agents/configuration.js";

/** Removes the image avatar and restores the derived `auto` display identity. */
export default defineEventHandler(async (event) => {
  const longAgentId = getRouterParam(event, "longAgentId");
  if (!longAgentId) throw createError({ statusCode: 400, statusMessage: "缺少Long Agent ID" });
  const expectedRevision = getQuery(event).expectedRevision;
  if (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
    throw createError({ statusCode: 400, statusMessage: "必须提供有效的expectedRevision" });
  }
  try {
    await clearLongAgentAvatarImage(longAgentId, expectedRevision);
    return await readLongAgentConfiguration(longAgentId);
  } catch (error) {
    if (error instanceof LongAgentAvatarError) {
      throw createError({ statusCode: error.statusCode, statusMessage: error.message });
    }
    throw error;
  }
});
