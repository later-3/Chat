import { defineEventHandler, getCookie, setResponseHeader, setResponseStatus } from "nitro/h3";
import {
  CHAT_WEB_AUTH_COOKIE,
  getChatWebAuthConfig,
  verifyChatWebAuthToken,
} from "../../../web-auth.js";

export default defineEventHandler((event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const config = getChatWebAuthConfig();
  if (config.state === "disabled") return { enabled: false, authenticated: true };
  if (config.state === "misconfigured") {
    setResponseStatus(event, 503);
    return { error: "Chat login is not configured correctly" };
  }

  const verification = verifyChatWebAuthToken(config, getCookie(event, CHAT_WEB_AUTH_COOKIE));
  if (!verification.valid) {
    setResponseStatus(event, 401);
    return { enabled: true, authenticated: false };
  }
  return {
    enabled: true,
    authenticated: true,
    username: verification.username,
    expiresAt: new Date(verification.expiresAt * 1000).toISOString(),
  };
});
