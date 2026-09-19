import {
  defineEventHandler,
  getHeader,
  getRequestURL,
  setResponseHeader,
  setResponseStatus,
} from "nitro/h3";
import type { H3Event } from "nitro/h3";
import {
  getChatChannelGatewayToken,
  isChatChannelServicePath,
  verifyChatChannelAuthorization,
} from "../long-agents/channel-service-auth.js";

function jsonError(event: H3Event, status: number, message: string) {
  setResponseStatus(event, status);
  setResponseHeader(event, "Cache-Control", "no-store");
  setResponseHeader(event, "Content-Type", "application/json; charset=utf-8");
  return { error: message };
}

/** Machine-to-machine Channel endpoints keep their service authentication. */
export default defineEventHandler((event) => {
  const requestUrl = getRequestURL(event, { xForwardedHost: true, xForwardedProto: true });
  if (isChatChannelServicePath(requestUrl.pathname)) {
    try {
      getChatChannelGatewayToken();
    } catch {
      return jsonError(event, 503, "Chat Channel service authentication is not configured correctly");
    }
    if (!verifyChatChannelAuthorization(getHeader(event, "authorization"))) {
      return jsonError(event, 401, "Channel service authentication required");
    }
    return;
  }
});
