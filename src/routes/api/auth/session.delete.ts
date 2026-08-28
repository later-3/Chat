import { deleteCookie, defineEventHandler, setResponseHeader } from "nitro/h3";
import { CHAT_WEB_AUTH_COOKIE } from "../../../web-auth.js";

export default defineEventHandler((event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  deleteCookie(event, CHAT_WEB_AUTH_COOKIE, { path: "/" });
  return { ok: true };
});
