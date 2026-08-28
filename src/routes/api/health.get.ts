import { defineEventHandler, setResponseHeader } from "nitro/h3";

/** 无需登录的进程存活检查，供反向代理和部署平台使用。 */
export default defineEventHandler((event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  return { ok: true, service: "chat" };
});
