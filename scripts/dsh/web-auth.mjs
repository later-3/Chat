import { createHmac, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { promisify } from "node:util";

/**
 * Chat Web 网关认证（服务器部署模式）。
 *
 * 是什么：网关唯一的浏览器入口认证——App 自有登录页 + scrypt 口令校验 +
 * HMAC 签名 HttpOnly 会话 Cookie。
 *
 * 为什么：公网暴露前置 blocker 是认证；Nginx auth_basic 在已安装 iOS PWA 中
 * 会弹出浏览器原生框且没有可恢复登录面（pi-web 已验证），所以登录面必须由
 * App 拥有。口令散列与会话密钥只存在于 Mac 本机文件，绝不进入环境变量值、
 * 日志或 Git；环境变量只携带文件路径。
 *
 * 怎样失败：配置缺失或文件不可读时启动直接失败（失败关闭）；口令校验使用
 * 恒时间比较；Cookie 签名或过期无效一律视为未登录，导航 302 到 /login，
 * API 与 WebSocket 返回 401/403，绝不降级为放行。
 */

export const SESSION_COOKIE_NAME = "chat_session";
export const WEB_AUTH_CREDENTIAL_SCHEMA_VERSION = "chat-web-auth.v2";
const SCRYPT_KEY_LENGTH = 64;
export const WEB_AUTH_SCRYPT_PARAMS = Object.freeze({
  cost: 2 ** 17,
  blockSize: 8,
  parallelization: 1,
});
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const MAX_SESSION_DAYS = 90;
const DEFAULT_SESSION_DAYS = 30;
const MAX_LOGIN_BODY_BYTES = 4 * 1024;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_IN_FLIGHT = 2;
const LOGIN_BUCKET_LIMIT = 1_024;
const scryptAsync = promisify(scrypt);

function requiredPath(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required when CHAT_WEB_AUTH_REQUIRED=1`);
  }
  return value;
}

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function assertPrivateFile(path, label) {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`${label} permissions must deny group and other access`);
  }
}

function scryptOptions() {
  return { ...WEB_AUTH_SCRYPT_PARAMS, maxmem: SCRYPT_MAXMEM };
}

function validScryptRecord(value) {
  return (
    typeof value?.salt === "string" &&
    typeof value?.hash === "string" &&
    /^[0-9a-f]+$/u.test(value.salt) &&
    /^[0-9a-f]+$/u.test(value.hash) &&
    value.hash.length === SCRYPT_KEY_LENGTH * 2 &&
    value.cost === WEB_AUTH_SCRYPT_PARAMS.cost &&
    value.blockSize === WEB_AUTH_SCRYPT_PARAMS.blockSize &&
    value.parallelization === WEB_AUTH_SCRYPT_PARAMS.parallelization
  );
}

function validLegacyScryptRecord(value) {
  return (
    typeof value?.salt === "string" &&
    typeof value?.hash === "string" &&
    /^[0-9a-f]{32}$/u.test(value.salt) &&
    /^[0-9a-f]{128}$/u.test(value.hash)
  );
}

function writeCredentialsAtomically(path, credentials) {
  const temporary = `${path}.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(credentials, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** 从环境装配认证配置；未启用时返回 undefined。文件只在此刻读取一次。 */
export function loadWebAuthConfig(environment = process.env) {
  if (environment.CHAT_WEB_AUTH_REQUIRED !== "1") return undefined;
  const credentialsFile = requiredPath(
    environment.CHAT_WEB_AUTH_CREDENTIALS_FILE,
    "CHAT_WEB_AUTH_CREDENTIALS_FILE",
  );
  const secretFile = requiredPath(
    environment.CHAT_WEB_AUTH_SESSION_SECRET_FILE,
    "CHAT_WEB_AUTH_SESSION_SECRET_FILE",
  );
  const daysRaw = environment.CHAT_WEB_AUTH_SESSION_DAYS;
  let sessionDays = DEFAULT_SESSION_DAYS;
  if (daysRaw !== undefined && daysRaw.trim() !== "") {
    sessionDays = Number(daysRaw);
    if (!Number.isSafeInteger(sessionDays) || sessionDays < 1 || sessionDays > MAX_SESSION_DAYS) {
      throw new Error(
        `CHAT_WEB_AUTH_SESSION_DAYS must be an integer from 1 to ${MAX_SESSION_DAYS}`,
      );
    }
  }
  let credentials;
  try {
    credentials = JSON.parse(readFileSync(credentialsFile, "utf8"));
  } catch (error) {
    throw new Error(
      `Chat web auth credentials file is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertPrivateFile(credentialsFile, "Chat web auth credentials file");
  const isCurrentSchema = credentials?.schemaVersion === WEB_AUTH_CREDENTIAL_SCHEMA_VERSION;
  const isLegacySchema = credentials?.schemaVersion === undefined;
  if (!isCurrentSchema && !isLegacySchema) {
    throw new Error(`Chat web auth credentials must use ${WEB_AUTH_CREDENTIAL_SCHEMA_VERSION}`);
  }
  const users = new Map();
  if (!Array.isArray(credentials?.users) || credentials.users.length === 0) {
    throw new Error("Chat web auth credentials file must contain a non-empty users array");
  }
  // v1没有记录派生参数，不能在无明文口令时离线重算。只允许既有的单用户精确
  // 形状进入一次性过渡：下一次成功登录会用当次表单口令原子重写为v2。多用户、
  // 畸形或未知schema继续失败关闭，避免把兼容入口变成长期的宽松解析器。
  if (isLegacySchema && credentials.users.length !== 1) {
    throw new Error("Legacy Chat web auth credentials must contain exactly one user");
  }
  for (const entry of credentials.users) {
    const username = entry?.username;
    const validRecord = isCurrentSchema
      ? validScryptRecord(entry?.scrypt)
      : validLegacyScryptRecord(entry?.scrypt);
    if (typeof username !== "string" || username === "" || !validRecord) {
      throw new Error("Chat web auth credentials entry is malformed");
    }
    users.set(
      username,
      Object.freeze(isCurrentSchema ? { ...entry.scrypt } : { ...entry.scrypt, legacy: true }),
    );
  }
  const secret = readFileSync(secretFile, "utf8").trim();
  assertPrivateFile(secretFile, "Chat web auth session secret file");
  if (secret.length < 32) {
    throw new Error("Chat web auth session secret must be at least 32 characters");
  }
  return Object.freeze({
    users,
    secret,
    sessionTtlMs: sessionDays * 24 * 60 * 60 * 1000,
    credentialsFile,
  });
}

/** 生成一个口令散列条目（供初始化脚本使用；口令值绝不落日志）。 */
export function hashWebAuthPassword(password, salt) {
  const derived = scryptSync(
    password,
    Buffer.from(salt, "hex"),
    SCRYPT_KEY_LENGTH,
    scryptOptions(),
  );
  return Object.freeze({
    salt,
    hash: derived.toString("hex"),
    ...WEB_AUTH_SCRYPT_PARAMS,
  });
}

export async function verifyWebAuthPassword(config, username, password) {
  const entry = config.users.get(username);
  // 对不存在的用户也执行同参数派生与等长比较，避免用户枚举的时间侧信道。
  const salt = entry === undefined ? Buffer.alloc(16, 1) : Buffer.from(entry.salt, "hex");
  const derived = await scryptAsync(
    password,
    salt,
    SCRYPT_KEY_LENGTH,
    entry?.legacy === true ? undefined : scryptOptions(),
  );
  const expected =
    entry === undefined ? Buffer.alloc(SCRYPT_KEY_LENGTH) : Buffer.from(entry.hash, "hex");
  const matches = derived.length === expected.length && timingSafeEqual(derived, expected);
  if (entry === undefined || !matches) return false;
  if (entry.legacy === true) {
    const upgraded = hashWebAuthPassword(password, randomBytes(16).toString("hex"));
    writeCredentialsAtomically(config.credentialsFile, {
      schemaVersion: WEB_AUTH_CREDENTIAL_SCHEMA_VERSION,
      users: [{ username, scrypt: upgraded }],
    });
    // 同一进程立即改用强参数记录，后续校验与Cookie用户存在性无需重启。
    config.users.set(username, upgraded);
  }
  return true;
}

function loginClientKey(req) {
  const forwarded = req.headers["cf-connecting-ip"];
  if (typeof forwarded === "string" && isIP(forwarded.trim()) !== 0) {
    return `client:${forwarded.trim()}`;
  }
  return `client:${req.socket?.remoteAddress ?? "unknown"}`;
}

function loginAccountKey(username) {
  return `account:${/^[a-zA-Z0-9_.-]{1,64}$/u.test(username) ? username : "invalid"}`;
}

/**
 * 进程内登录节流。公网入口只有单个受管Gateway，账号桶阻止分布式猜测，客户端桶
 * 限制单一来源；并发上限先于昂贵scrypt，避免一次突发占满libuv线程池。重启只会
 * 清空短期防护状态，不影响凭据与会话事实。
 */
export function createLoginThrottle({
  failureLimit = LOGIN_FAILURE_LIMIT,
  windowMs = LOGIN_FAILURE_WINDOW_MS,
  maxInFlight = LOGIN_MAX_IN_FLIGHT,
  now = () => Date.now(),
} = {}) {
  const failures = new Map();
  let inFlight = 0;

  const prune = (at) => {
    for (const [key, values] of failures) {
      const recent = values.filter((value) => at - value < windowMs);
      if (recent.length === 0) failures.delete(key);
      else failures.set(key, recent);
    }
    while (failures.size > LOGIN_BUCKET_LIMIT) failures.delete(failures.keys().next().value);
  };

  return Object.freeze({
    begin(req, username) {
      const at = now();
      prune(at);
      const keys = [loginAccountKey(username), loginClientKey(req)];
      if (
        inFlight >= maxInFlight ||
        keys.some((key) => (failures.get(key)?.length ?? 0) >= failureLimit)
      ) {
        return undefined;
      }
      inFlight += 1;
      let settled = false;
      return Object.freeze({
        settle(success) {
          if (settled) return;
          settled = true;
          inFlight -= 1;
          if (success) {
            for (const key of keys) failures.delete(key);
            return;
          }
          const failedAt = now();
          for (const key of keys) failures.set(key, [...(failures.get(key) ?? []), failedAt]);
        },
      });
    },
  });
}

function sign(config, payload) {
  return createHmac("sha256", config.secret).update(payload).digest();
}

export function issueSessionCookieValue(config, username, now = Date.now()) {
  const payload = base64url(JSON.stringify({ u: username, exp: now + config.sessionTtlMs }));
  return `${payload}.${base64url(sign(config, payload))}`;
}

export function verifySessionCookieValue(config, value, now = Date.now()) {
  if (typeof value !== "string") return undefined;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const payload = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  let expected;
  try {
    expected = base64url(sign(config, payload));
  } catch {
    return undefined;
  }
  const givenBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    givenBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(givenBuffer, expectedBuffer)
  ) {
    return undefined;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      typeof claims?.u !== "string" ||
      !config.users.has(claims.u) ||
      typeof claims?.exp !== "number" ||
      claims.exp < now
    ) {
      return undefined;
    }
    return claims.u;
  } catch {
    return undefined;
  }
}

export function sessionCookieFromRequest(req) {
  const header = req.headers.cookie;
  if (typeof header !== "string") return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE_NAME) {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

export function buildSessionSetCookie(config, username, secure) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${issueSessionCookieValue(config, username)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${String(Math.floor(config.sessionTtlMs / 1000))}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function buildSessionClearCookie(secure) {
  const parts = [`${SESSION_COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** 认证放行的公开路径：登录页、健康检查与 PWA 安装所需的静态资产。 */
export function isPublicAuthPath(pathname) {
  return (
    pathname === "/login" ||
    pathname === "/healthz" ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/sw.js" ||
    pathname === "/favicon.svg" ||
    pathname.startsWith("/pwa/")
  );
}

const LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#FFFFFF" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="icon" href="/pwa/icons/icon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/pwa/icons/apple-touch-icon.png" />
    <title>登录 · Chat</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #fff; }
      main { width: 100%; max-width: 320px; padding: 24px; }
      h1 { font-size: 20px; margin: 0 0 24px; }
      label { display: block; font-size: 13px; color: #555; margin: 12px 0 4px; }
      input { width: 100%; box-sizing: border-box; font-size: 16px; padding: 10px; border: 1px solid #ccc; border-radius: 8px; }
      button { width: 100%; margin-top: 20px; min-height: 44px; font-size: 16px; border: 0; border-radius: 8px; background: #1d1d1f; color: #fff; }
      .error { color: #b00020; font-size: 13px; margin-top: 12px; }
    </style>
  </head>
  <body>
    <main>
      <h1>登录 Chat</h1>
      <form method="post" action="/login">
        <label for="username">账号</label>
        <input id="username" name="username" autocomplete="username" required />
        <label for="password">密码</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
        <button type="submit">登录</button>
        __ERROR__
      </form>
    </main>
  </body>
</html>
`;

function loginPage(error) {
  const message =
    error === "invalid"
      ? "账号或密码不正确。"
      : error === "throttled"
        ? "登录尝试过多，请稍后重试。"
        : undefined;
  return LOGIN_PAGE.replace(
    "__ERROR__",
    message === undefined ? "" : `<p class="error">${message}</p>`,
  );
}

function sendHtml(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function readFormBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_LOGIN_BODY_BYTES) {
        reject(new Error("login body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function assertLoginOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return;
  const host = req.headers.host;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error("Origin header is invalid");
  }
  // 公网入口是 HTTPS；同源提交只允许 https://<host> 或 loopback http://<host>。
  const expected = [`https://${host}`, `http://${host}`];
  if (parsed.origin === "/" || !expected.includes(parsed.origin)) {
    throw new Error("Origin must match Host");
  }
}

/**
 * 处理 /login 与 /logout。已处理返回 true；其他路径返回 false 继续走认证门。
 * secure 由部署模式决定：公网主机名配置后 Cookie 始终带 Secure。
 */
export function createAuthRouteHandler(config, { secure, throttle = createLoginThrottle() }) {
  return async (req, res, pathname) => {
    if (pathname === "/logout" && req.method === "POST") {
      res.writeHead(302, {
        location: "/login",
        "set-cookie": buildSessionClearCookie(secure),
        "cache-control": "no-store",
      });
      res.end();
      return true;
    }
    if (pathname !== "/login") return false;
    if (req.method === "GET" || req.method === "HEAD") {
      sendHtml(res, 200, loginPage());
      return true;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "GET, POST" });
      res.end();
      return true;
    }
    try {
      assertLoginOrigin(req);
      const contentType = req.headers["content-type"];
      if (
        typeof contentType !== "string" ||
        !contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")
      ) {
        throw new Error("login form must be urlencoded");
      }
      const params = new URLSearchParams(await readFormBody(req));
      const username = params.get("username") ?? "";
      const password = params.get("password") ?? "";
      const permit = throttle.begin(req, username);
      if (permit === undefined) {
        sendHtml(res, 429, loginPage("throttled"));
        return true;
      }
      let valid = false;
      try {
        valid = await verifyWebAuthPassword(config, username, password);
      } finally {
        permit.settle(valid);
      }
      if (!valid) {
        sendHtml(res, 401, loginPage("invalid"));
        return true;
      }
      res.writeHead(302, {
        location: "/",
        "set-cookie": buildSessionSetCookie(config, username, secure),
        "cache-control": "no-store",
      });
      res.end();
      return true;
    } catch {
      sendHtml(res, 400, loginPage("invalid"));
      return true;
    }
  };
}

/** 认证门：返回放行用户名；未放行时直接写出 302/401 并返回 undefined。 */
export function gateAuthenticatedRequest(req, res, config, pathname) {
  const username = verifySessionCookieValue(config, sessionCookieFromRequest(req));
  if (username !== undefined) return username;
  const acceptsHtml = String(req.headers.accept ?? "").includes("text/html");
  if (
    (req.method === "GET" || req.method === "HEAD") &&
    acceptsHtml &&
    !pathname.startsWith("/lifeos")
  ) {
    res.writeHead(302, { location: "/login", "cache-control": "no-store" });
    res.end();
    return undefined;
  }
  const body = `${JSON.stringify({
    type: "about:blank",
    title: "Authentication required",
    status: 401,
    code: "chat_web_auth_required",
    retryable: false,
  })}\n`;
  res.writeHead(401, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
  return undefined;
}

/** WebSocket 升级门：只校验 Cookie，由调用方在失败时销毁 socket。 */
export function authenticateUpgrade(req, config) {
  return verifySessionCookieValue(config, sessionCookieFromRequest(req));
}
