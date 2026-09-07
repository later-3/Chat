import { createHash, timingSafeEqual } from "node:crypto";

export const CHAT_CHANNEL_GATEWAY_TOKEN_ENV = "CHAT_CHANNEL_GATEWAY_TOKEN";
export const CHAT_CHANNEL_SERVICE_PATH_PREFIX = "/api/internal/channel/v1/";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function getChatChannelGatewayToken(environment: NodeJS.ProcessEnv = process.env): string {
  const token = environment[CHAT_CHANNEL_GATEWAY_TOKEN_ENV]?.trim();
  if (!token || token.length < 32) {
    throw new Error(`${CHAT_CHANNEL_GATEWAY_TOKEN_ENV}必须包含至少32个字符`);
  }
  return token;
}

export function chatChannelAuthorization(environment: NodeJS.ProcessEnv = process.env): string {
  return `Bearer ${getChatChannelGatewayToken(environment)}`;
}

export function isChatChannelServicePath(pathname: string): boolean {
  return pathname.startsWith(CHAT_CHANNEL_SERVICE_PATH_PREFIX);
}

export function verifyChatChannelAuthorization(
  authorization: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) return false;
  const actual = authorization.slice(prefix.length);
  const expected = getChatChannelGatewayToken(environment);
  return timingSafeEqual(digest(actual), digest(expected));
}
