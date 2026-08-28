import {
  defineEventHandler,
  getRequestIP,
  getRequestProtocol,
  readRawBody,
  setCookie,
  setResponseHeader,
  setResponseStatus,
} from "nitro/h3";
import {
  CHAT_WEB_AUTH_COOKIE,
  createChatWebAuthToken,
  getChatWebAuthConfig,
  matchesChatWebCredential,
} from "../../../web-auth.js";

const MAX_BODY_BYTES = 4096;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

interface FailureRecord {
  count: number;
  resetAt: number;
}

const attempts = new Map<string, FailureRecord>();

function currentFailure(key: string, now = Date.now()): FailureRecord | null {
  const record = attempts.get(key);
  if (!record) return null;
  if (record.resetAt <= now) {
    attempts.delete(key);
    return null;
  }
  return record;
}

function recordFailure(key: string, now = Date.now()): void {
  const current = currentFailure(key, now);
  attempts.set(key, current
    ? { ...current, count: current.count + 1 }
    : { count: 1, resetAt: now + FAILURE_WINDOW_MS });
}

export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const config = getChatWebAuthConfig();
  if (config.state !== "enabled") {
    setResponseStatus(event, 503);
    return { error: "Chat login is not configured correctly" };
  }

  const clientKey = getRequestIP(event, { xForwardedFor: true }) ?? "local";
  const failure = currentFailure(clientKey);
  if (failure && failure.count >= MAX_FAILURES) {
    setResponseStatus(event, 429);
    setResponseHeader(event, "Retry-After", String(Math.max(1, Math.ceil((failure.resetAt - Date.now()) / 1000))));
    return { error: "Too many login attempts" };
  }

  const declaredLength = Number.parseInt(event.req.headers.get("content-length") ?? "0", 10);
  if (declaredLength > MAX_BODY_BYTES) {
    setResponseStatus(event, 413);
    return { error: "Login request is too large" };
  }

  let body: { username?: unknown; password?: unknown; persistent?: unknown };
  try {
    const rawBody = await readRawBody(event) ?? "";
    if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) {
      setResponseStatus(event, 413);
      return { error: "Login request is too large" };
    }
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    setResponseStatus(event, 400);
    return { error: "Invalid login request" };
  }

  const username = typeof body.username === "string" ? body.username.slice(0, 128) : "";
  const password = typeof body.password === "string" ? body.password.slice(0, 1024) : "";
  if (!matchesChatWebCredential(config, username, password)) {
    recordFailure(clientKey);
    setResponseStatus(event, 401);
    return { error: "Invalid username or password" };
  }

  attempts.delete(clientKey);
  const session = createChatWebAuthToken(config, body.persistent === true);
  setCookie(event, CHAT_WEB_AUTH_COOKIE, session.token, {
    httpOnly: true,
    secure: getRequestProtocol(event, { xForwardedProto: true }) === "https",
    sameSite: "lax",
    path: "/",
    ...(session.maxAge ? { maxAge: session.maxAge } : {}),
  });
  return { ok: true, expiresAt: new Date(session.expiresAt * 1000).toISOString() };
});
