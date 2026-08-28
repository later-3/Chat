import {
  defineEventHandler,
  getCookie,
  getRequestURL,
  sendRedirect,
  setResponseHeader,
  setResponseStatus,
} from "nitro/h3";
import type { H3Event } from "nitro/h3";
import {
  CHAT_WEB_AUTH_COOKIE,
  getChatWebAuthConfig,
  isProtectedChatWebPath,
  sanitizeChatWebAuthNext,
  verifyChatWebAuthToken,
} from "../web-auth.js";

function jsonError(event: H3Event, status: number, message: string) {
  setResponseStatus(event, status);
  setResponseHeader(event, "Cache-Control", "no-store");
  setResponseHeader(event, "Content-Type", "application/json; charset=utf-8");
  if (status === 401) setResponseHeader(event, "X-Chat-Auth-Required", "1");
  return { error: message };
}

/**
 * Chat产品API必须先通过网页登录。Vercel Workflow自己的
 * `/.well-known/workflow/*`回调不属于浏览器产品API，因此不会被这里拦截。
 */
export default defineEventHandler((event) => {
  const requestUrl = getRequestURL(event, { xForwardedHost: true, xForwardedProto: true });
  if (!isProtectedChatWebPath(requestUrl.pathname)) return;

  const config = getChatWebAuthConfig();
  if (config.state === "disabled") return;
  const isApiRequest = requestUrl.pathname === "/run"
    || requestUrl.pathname.startsWith("/runs")
    || requestUrl.pathname.startsWith("/api");
  if (config.state === "misconfigured") {
    return jsonError(event, 503, "Chat login is not configured correctly");
  }

  const verification = verifyChatWebAuthToken(config, getCookie(event, CHAT_WEB_AUTH_COOKIE));
  if (verification.valid) return;
  if (isApiRequest) return jsonError(event, 401, "Authentication required");

  const next = sanitizeChatWebAuthNext(`${requestUrl.pathname}${requestUrl.search}`);
  const params = new URLSearchParams({ next });
  if (verification.reason !== "missing") params.set("expired", "1");
  return sendRedirect(event, `/login?${params.toString()}`, 307);
});
