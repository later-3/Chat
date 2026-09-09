import { createError, defineEventHandler, getQuery, getRequestHeader, getRouterParam, readRawBody } from "nitro/h3";
import {
  LongAgentAvatarError,
  MAX_AVATAR_BYTES,
  saveLongAgentAvatarImage,
} from "../../../../long-agents/avatars.js";
import { readLongAgentConfiguration } from "../../../../long-agents/configuration.js";

/** Replaces the image avatar with raw bytes; requires the current config revision. */
export default defineEventHandler(async (event) => {
  const longAgentId = getRouterParam(event, "longAgentId");
  if (!longAgentId) throw createError({ statusCode: 400, statusMessage: "缺少Long Agent ID" });
  const expectedRevision = getQuery(event).expectedRevision;
  if (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
    throw createError({ statusCode: 400, statusMessage: "必须提供有效的expectedRevision" });
  }
  const declaredLength = Number(getRequestHeader(event, "content-length") ?? 0);
  if (declaredLength > MAX_AVATAR_BYTES) {
    throw createError({ statusCode: 413, statusMessage: `头像不能超过${MAX_AVATAR_BYTES}字节` });
  }
  try {
    const bytes = await readRawBody(event, false);
    if (bytes === undefined) throw new LongAgentAvatarError("头像内容为空", 400);
    await saveLongAgentAvatarImage(longAgentId, bytes, expectedRevision);
    // Return the updated configuration document so the page can refresh its baseline revision.
    return await readLongAgentConfiguration(longAgentId);
  } catch (error) {
    if (error instanceof LongAgentAvatarError) {
      throw createError({ statusCode: error.statusCode, statusMessage: error.message });
    }
    throw error;
  }
});
