import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { readChatToolResultImage } from "../../../../../../session-read-model.js";
import { SessionLifecycleError } from "../../../../../../session-errors.js";
import { toSessionLifecycleHttpError } from "../../../../../../session-removal-http.js";

export default defineEventHandler(async (event) => {
  const sessionId = getRouterParam(event, "sessionId");
  const entryId = getRouterParam(event, "entryId");
  if (!sessionId) throw createError({ statusCode: 400, statusMessage: "缺少sessionId" });
  if (!entryId) throw createError({ statusCode: 400, statusMessage: "缺少entryId" });

  const query = getQuery(event);
  const blockIndex = typeof query.blockIndex === "string" ? Number(query.blockIndex) : Number.NaN;
  if (!Number.isSafeInteger(blockIndex) || blockIndex < 0) {
    throw createError({ statusCode: 400, statusMessage: "blockIndex无效" });
  }
  const projectId = typeof query.projectId === "string" ? query.projectId : undefined;

  try {
    const image = await readChatToolResultImage(sessionId, entryId, blockIndex, projectId);
    if (image.status === "not-found") {
      throw createError({ statusCode: 404, statusMessage: "找不到Tool结果图片" });
    }
    if (image.status === "unsupported") {
      throw createError({ statusCode: 415, statusMessage: "不支持的图片类型" });
    }
    if (image.status === "invalid-or-oversized") {
      throw createError({ statusCode: 413, statusMessage: "图片数据无效或超过10MB" });
    }

    const body = new ArrayBuffer(image.bytes.byteLength);
    new Uint8Array(body).set(image.bytes);
    return new Response(body, {
      headers: {
        "Content-Type": image.mime,
        "Content-Length": String(image.bytes.byteLength),
        "Cache-Control": "private, no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof SessionLifecycleError) throw toSessionLifecycleHttpError(error);
    throw error;
  }
});
