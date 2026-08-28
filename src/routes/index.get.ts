import { createError, defineEventHandler, setResponseHeader } from "nitro/h3";
import { useStorage } from "nitro/storage";

/**
 * 登录通过后才返回前端入口。index.html作为Nitro server asset打入生产产物，
 * 不从运行机器的源码目录读取；JS、CSS、图标和Service Worker仍由public assets提供。
 */
export default defineEventHandler(async (event) => {
  const indexHtml = await useStorage("assets:frontend").getItem("index.html");
  if (typeof indexHtml !== "string") {
    throw createError({ statusCode: 503, statusMessage: "Chat frontend is unavailable" });
  }
  setResponseHeader(event, "Content-Type", "text/html; charset=utf-8");
  setResponseHeader(event, "Cache-Control", "private, no-store, max-age=0");
  return indexHtml;
});
