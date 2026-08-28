import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const CHAT_WEB_AUTH_COOKIE = "chat-session";
export const DEFAULT_CHAT_WEB_AUTH_USERNAME = "later";
export const DEFAULT_CHAT_WEB_AUTH_PASSWORD = "123456";

const TOKEN_VERSION = "v1";
const TRANSIENT_SESSION_SECONDS = 12 * 60 * 60;
const DEFAULT_PERSISTENT_SESSION_DAYS = 30;

export interface ChatWebAuthCredential {
  username: string;
  password: string;
}

export type ChatWebAuthConfig =
  | { state: "disabled" }
  | { state: "misconfigured"; reason: string }
  | {
      state: "enabled";
      credential: ChatWebAuthCredential;
      sessionSecret: string;
      persistentSessionDays: number;
    };

export type ChatWebAuthVerification =
  | { valid: true; expiresAt: number; username: string }
  | { valid: false; reason: "missing" | "expired" | "invalid" | "misconfigured" };

function isDisabled(value: string | undefined): boolean {
  return /^(?:0|false|no|off)$/i.test(value?.trim() ?? "");
}

function sessionDays(value: string | undefined): number {
  if (!value) return DEFAULT_PERSISTENT_SESSION_DAYS;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_PERSISTENT_SESSION_DAYS;
  return Math.min(90, Math.max(1, parsed));
}

/**
 * Chat默认启用网页登录，并按产品约定提供`later / 123456`初始账号。
 * 生产环境可以覆盖账号、密码和独立签名密钥；显式设置
 * `CHAT_WEB_AUTH_ENABLED=0`只用于受信任的本地开发环境。
 */
export function getChatWebAuthConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ChatWebAuthConfig {
  if (isDisabled(environment.CHAT_WEB_AUTH_ENABLED)) return { state: "disabled" };

  const username = environment.CHAT_WEB_AUTH_USERNAME ?? DEFAULT_CHAT_WEB_AUTH_USERNAME;
  const password = environment.CHAT_WEB_AUTH_PASSWORD ?? DEFAULT_CHAT_WEB_AUTH_PASSWORD;
  if (!username.trim() || username.length > 128) {
    return { state: "misconfigured", reason: "CHAT_WEB_AUTH_USERNAME is invalid" };
  }
  if (!password || password.length > 1024) {
    return { state: "misconfigured", reason: "CHAT_WEB_AUTH_PASSWORD is invalid" };
  }

  // 未配置独立密钥时，用账号和密码派生稳定密钥。部署时设置独立随机密钥
  // 可以让登录密码轮换和会话签名密钥轮换分别进行。
  const configuredSecret = environment.CHAT_WEB_AUTH_SESSION_SECRET?.trim();
  if (configuredSecret && configuredSecret.length < 32) {
    return { state: "misconfigured", reason: "CHAT_WEB_AUTH_SESSION_SECRET must contain at least 32 characters" };
  }
  const sessionSecret = configuredSecret ?? createHash("sha256")
    .update("chat-web-session-v1\0")
    .update(username)
    .update("\0")
    .update(password)
    .digest("base64url");

  return {
    state: "enabled",
    credential: { username: username.trim(), password },
    sessionSecret,
    persistentSessionDays: sessionDays(environment.CHAT_WEB_AUTH_SESSION_DAYS),
  };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function constantTimeEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(digest(actual), digest(expected));
}

export function matchesChatWebCredential(
  config: Extract<ChatWebAuthConfig, { state: "enabled" }>,
  username: string,
  password: string,
): boolean {
  const usernameMatches = constantTimeEqual(username, config.credential.username);
  const passwordMatches = constantTimeEqual(password, config.credential.password);
  return usernameMatches && passwordMatches;
}

function credentialFingerprint(config: Extract<ChatWebAuthConfig, { state: "enabled" }>): string {
  return createHmac("sha256", config.sessionSecret)
    .update(config.credential.username)
    .update("\0")
    .update(config.credential.password)
    .digest("base64url")
    .slice(0, 22);
}

function tokenSignature(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(`${TOKEN_VERSION}.${payload}`).digest("base64url");
}

export function createChatWebAuthToken(
  config: Extract<ChatWebAuthConfig, { state: "enabled" }>,
  persistent: boolean,
  nowSeconds = Math.floor(Date.now() / 1000),
): { token: string; expiresAt: number; maxAge?: number } {
  const lifetime = persistent
    ? config.persistentSessionDays * 24 * 60 * 60
    : TRANSIENT_SESSION_SECONDS;
  const expiresAt = nowSeconds + lifetime;
  const payload = Buffer.from(JSON.stringify({
    exp: expiresAt,
    sub: config.credential.username,
    cred: credentialFingerprint(config),
  })).toString("base64url");
  const token = `${TOKEN_VERSION}.${payload}.${tokenSignature(config.sessionSecret, payload)}`;
  return {
    token,
    expiresAt,
    ...(persistent ? { maxAge: lifetime } : {}),
  };
}

export function verifyChatWebAuthToken(
  config: ChatWebAuthConfig,
  token: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): ChatWebAuthVerification {
  if (config.state === "misconfigured") return { valid: false, reason: "misconfigured" };
  if (config.state === "disabled") {
    return { valid: true, expiresAt: Number.MAX_SAFE_INTEGER, username: "local" };
  }
  if (!token) return { valid: false, reason: "missing" };
  if (token.length > 2048) return { valid: false, reason: "invalid" };

  const [version, payload, signature, extra] = token.split(".");
  if (version !== TOKEN_VERSION || !payload || !signature || extra !== undefined) {
    return { valid: false, reason: "invalid" };
  }
  if (!constantTimeEqual(signature, tokenSignature(config.sessionSecret, payload))) {
    return { valid: false, reason: "invalid" };
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown;
      sub?: unknown;
      cred?: unknown;
    };
    if (
      !Number.isInteger(decoded.exp)
      || typeof decoded.sub !== "string"
      || typeof decoded.cred !== "string"
      || !constantTimeEqual(decoded.sub, config.credential.username)
      || !constantTimeEqual(decoded.cred, credentialFingerprint(config))
    ) {
      return { valid: false, reason: "invalid" };
    }
    const expiresAt = decoded.exp as number;
    if (expiresAt <= nowSeconds) return { valid: false, reason: "expired" };
    return { valid: true, expiresAt, username: decoded.sub };
  } catch {
    return { valid: false, reason: "invalid" };
  }
}

export function sanitizeChatWebAuthNext(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  if (/\p{Cc}/u.test(value)) return "/";
  try {
    const parsed = new URL(value, "https://chat.invalid");
    if (parsed.origin !== "https://chat.invalid" || parsed.pathname === "/login") return "/";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

export function isPublicChatWebPath(pathname: string): boolean {
  return pathname === "/login"
    || pathname === "/api/auth/session"
    || pathname === "/api/health"
    || pathname === "/manifest.webmanifest"
    || pathname === "/sw.js"
    || pathname === "/offline.html"
    || pathname === "/favicon.ico"
    || pathname === "/apple-touch-icon.png"
    || pathname.startsWith("/assets/")
    || pathname.startsWith("/icons/")
    || /^\/icon-(?:maskable-)?(?:192x192|512x512)\.png$/.test(pathname);
}

export function isProtectedChatWebPath(pathname: string): boolean {
  if (isPublicChatWebPath(pathname)) return false;
  return pathname === "/"
    || pathname === "/api"
    || pathname.startsWith("/api/")
    || pathname === "/run"
    || pathname === "/runs"
    || pathname.startsWith("/runs/");
}
