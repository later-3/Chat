import { createError, defineEventHandler, getRouterParam } from "nitro/h3";
import { LongAgentAvatarError, readLongAgentAvatarImage } from "../../../../long-agents/avatars.js";

/** Serves the managed image avatar; `?v=<revision>` is the browser cache key. */
export default defineEventHandler(async (event) => {
  const longAgentId = getRouterParam(event, "longAgentId");
  if (!longAgentId) throw createError({ statusCode: 400, statusMessage: "缺少Long Agent ID" });
  try {
    const image = await readLongAgentAvatarImage(longAgentId);
    if (image === null) throw createError({ statusCode: 404, statusMessage: "该Long Agent没有图片头像" });
    const body = new ArrayBuffer(image.bytes.byteLength);
    new Uint8Array(body).set(image.bytes);
    return new Response(body, {
      headers: {
        "Content-Type": image.mime,
        "Content-Length": String(image.bytes.byteLength),
        // The URL carries the avatar revision, so content is immutable per URL.
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof LongAgentAvatarError) {
      throw createError({ statusCode: error.statusCode, statusMessage: error.message });
    }
    throw error;
  }
});
