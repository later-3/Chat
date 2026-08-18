import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildSessionSetCookie,
  createAuthRouteHandler,
  createLoginThrottle,
  gateAuthenticatedRequest,
  hashWebAuthPassword,
  isPublicAuthPath,
  loadWebAuthConfig,
  sessionCookieFromRequest,
  SESSION_COOKIE_NAME,
  WEB_AUTH_CREDENTIAL_SCHEMA_VERSION,
  WEB_AUTH_SCRYPT_PARAMS,
  verifySessionCookieValue,
  verifyWebAuthPassword,
} from "./web-auth.mjs";

function writeAuthFixture() {
  const dir = mkdtempSync(join(tmpdir(), "chat-web-auth-"));
  const salt = randomBytes(16).toString("hex");
  const credentialsFile = join(dir, "credentials.json");
  const secretFile = join(dir, "session-secret");
  writeFileSync(
    credentialsFile,
    JSON.stringify({
      schemaVersion: WEB_AUTH_CREDENTIAL_SCHEMA_VERSION,
      users: [{ username: "later", scrypt: hashWebAuthPassword("correct-horse", salt) }],
    }),
    { mode: 0o600 },
  );
  writeFileSync(secretFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  return {
    dir,
    env: {
      CHAT_WEB_AUTH_REQUIRED: "1",
      CHAT_WEB_AUTH_CREDENTIALS_FILE: credentialsFile,
      CHAT_WEB_AUTH_SESSION_SECRET_FILE: secretFile,
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("disabled auth returns undefined and keeps local posture", () => {
  assert.equal(loadWebAuthConfig({}), undefined);
  assert.equal(loadWebAuthConfig({ CHAT_WEB_AUTH_REQUIRED: "0" }), undefined);
});

test("enabled auth fails closed on missing files or weak secret", () => {
  assert.throws(() => loadWebAuthConfig({ CHAT_WEB_AUTH_REQUIRED: "1" }), /CREDENTIALS_FILE/u);
  const fixture = writeAuthFixture();
  try {
    assert.throws(
      () =>
        loadWebAuthConfig({
          CHAT_WEB_AUTH_REQUIRED: "1",
          CHAT_WEB_AUTH_CREDENTIALS_FILE: fixture.env.CHAT_WEB_AUTH_CREDENTIALS_FILE,
          CHAT_WEB_AUTH_SESSION_SECRET_FILE: join(fixture.dir, "missing"),
        }),
      /unreadable|ENOENT/u,
    );
    writeFileSync(join(fixture.dir, "weak"), "short", { mode: 0o600 });
    assert.throws(
      () =>
        loadWebAuthConfig({
          CHAT_WEB_AUTH_REQUIRED: "1",
          CHAT_WEB_AUTH_CREDENTIALS_FILE: fixture.env.CHAT_WEB_AUTH_CREDENTIALS_FILE,
          CHAT_WEB_AUTH_SESSION_SECRET_FILE: join(fixture.dir, "weak"),
        }),
      /at least 32/u,
    );
  } finally {
    fixture.cleanup();
  }
});

test("password verification uses the versioned scrypt contract with constant-time compare", async () => {
  const fixture = writeAuthFixture();
  try {
    const config = loadWebAuthConfig(fixture.env);
    assert.deepEqual(config.users.get("later"), {
      salt: config.users.get("later").salt,
      hash: config.users.get("later").hash,
      ...WEB_AUTH_SCRYPT_PARAMS,
    });
    assert.ok(await verifyWebAuthPassword(config, "later", "correct-horse"));
    assert.equal(await verifyWebAuthPassword(config, "later", "wrong"), false);
    assert.equal(await verifyWebAuthPassword(config, "nobody", "correct-horse"), false);
  } finally {
    fixture.cleanup();
  }
});

test("a valid single-user legacy credential upgrades atomically after successful login", async () => {
  const fixture = writeAuthFixture();
  try {
    const legacy = fixture.env.CHAT_WEB_AUTH_CREDENTIALS_FILE;
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync("correct-horse", Buffer.from(salt, "hex"), 64).toString("hex");
    writeFileSync(
      legacy,
      JSON.stringify({ users: [{ username: "later", scrypt: { salt, hash } }] }),
      { mode: 0o600 },
    );
    const config = loadWebAuthConfig(fixture.env);
    assert.equal(config.users.get("later").legacy, true);
    assert.equal(await verifyWebAuthPassword(config, "later", "wrong"), false);
    assert.equal(JSON.parse(readFileSync(legacy, "utf8")).schemaVersion, undefined);
    assert.equal(await verifyWebAuthPassword(config, "later", "correct-horse"), true);
    const upgraded = JSON.parse(readFileSync(legacy, "utf8"));
    assert.equal(upgraded.schemaVersion, WEB_AUTH_CREDENTIAL_SCHEMA_VERSION);
    assert.deepEqual(upgraded.users[0].scrypt, {
      salt: upgraded.users[0].scrypt.salt,
      hash: upgraded.users[0].scrypt.hash,
      ...WEB_AUTH_SCRYPT_PARAMS,
    });
    assert.equal(config.users.get("later").legacy, undefined);
  } finally {
    fixture.cleanup();
  }
});

test("malformed legacy credentials and permissive credential files fail closed", () => {
  const fixture = writeAuthFixture();
  try {
    const legacy = fixture.env.CHAT_WEB_AUTH_CREDENTIALS_FILE;
    writeFileSync(
      legacy,
      JSON.stringify({ users: [{ username: "later", scrypt: { salt: "00", hash: "00" } }] }),
      { mode: 0o600 },
    );
    assert.throws(() => loadWebAuthConfig(fixture.env), /malformed/u);
    writeFileSync(
      legacy,
      JSON.stringify({ schemaVersion: WEB_AUTH_CREDENTIAL_SCHEMA_VERSION, users: [] }),
    );
    chmodSync(legacy, 0o644);
    assert.throws(() => loadWebAuthConfig(fixture.env), /permissions/u);
  } finally {
    fixture.cleanup();
  }
});

test("login throttle limits account and client failures before expensive verification", () => {
  let now = 1_000;
  const throttle = createLoginThrottle({ failureLimit: 2, windowMs: 60_000, now: () => now });
  const req = { headers: { "cf-connecting-ip": "203.0.113.9" }, socket: {} };
  const first = throttle.begin(req, "later");
  assert.ok(first !== undefined);
  first.settle(false);
  const second = throttle.begin(req, "later");
  assert.ok(second !== undefined);
  second.settle(false);
  assert.equal(throttle.begin(req, "later"), undefined);
  assert.equal(throttle.begin(req, "another"), undefined, "client bucket must also be limited");
  now += 60_001;
  const recovered = throttle.begin(req, "later");
  assert.ok(recovered !== undefined);
  recovered.settle(true);
});

test("login route returns generic 429 without invoking password verification", async () => {
  const fixture = writeAuthFixture();
  try {
    const config = loadWebAuthConfig(fixture.env);
    const handler = createAuthRouteHandler(config, {
      secure: true,
      throttle: { begin: () => undefined },
    });
    const body = "username=later&password=correct-horse";
    const req = new (await import("node:stream")).PassThrough();
    req.method = "POST";
    req.headers = {
      host: "chat.example.com",
      origin: "https://chat.example.com",
      "content-type": "application/x-www-form-urlencoded",
    };
    req.socket = {};
    const response = {};
    const res = {
      writeHead(status, headers) {
        response.status = status;
        response.headers = headers;
      },
      end(value = "") {
        response.body = String(value);
      },
    };
    const handled = handler(req, res, "/login");
    req.end(body);
    assert.equal(await handled, true);
    assert.equal(response.status, 429);
    assert.match(response.body, /登录尝试过多/u);
  } finally {
    fixture.cleanup();
  }
});

test("session cookies round-trip and reject tampering and expiry", () => {
  const fixture = writeAuthFixture();
  try {
    const config = loadWebAuthConfig(fixture.env);
    const setCookie = buildSessionSetCookie(config, "later", true);
    assert.match(setCookie, /HttpOnly/u);
    assert.match(setCookie, /Secure/u);
    assert.match(setCookie, /SameSite=Lax/u);
    const value = setCookie.split(";")[0].slice(SESSION_COOKIE_NAME.length + 1);
    assert.equal(verifySessionCookieValue(config, value), "later");
    assert.equal(verifySessionCookieValue(config, `${value}x`), undefined);
    assert.equal(verifySessionCookieValue(config, "garbage"), undefined);
    const [, payloadB64] = value.split(".");
    const forged = `${Buffer.from(JSON.stringify({ u: "later", exp: Date.now() - 1000 })).toString("base64url")}.${value.split(".")[2]}`;
    assert.equal(verifySessionCookieValue(config, forged), undefined);
    assert.ok(payloadB64.length > 0);
  } finally {
    fixture.cleanup();
  }
});

test("cookie header parsing isolates the session cookie", () => {
  assert.equal(sessionCookieFromRequest({ headers: {} }), undefined);
  assert.equal(
    sessionCookieFromRequest({ headers: { cookie: "other=1; chat_session=abc.def; theme=dark" } }),
    "abc.def",
  );
});

test("public auth paths cover login, health and PWA install assets only", () => {
  for (const path of [
    "/login",
    "/healthz",
    "/manifest.webmanifest",
    "/sw.js",
    "/pwa/icons/icon-192.png",
  ]) {
    assert.ok(isPublicAuthPath(path), path);
  }
  for (const path of [
    "/",
    "/assets/index.js",
    "/lifeos/sessions/x",
    "/api/health",
    "/workbench/code/",
  ]) {
    assert.equal(isPublicAuthPath(path), false, path);
  }
});

test("gate redirects navigations and rejects api calls with 401", () => {
  const fixture = writeAuthFixture();
  try {
    const config = loadWebAuthConfig(fixture.env);
    const responses = [];
    const res = {
      writeHead(status, headers) {
        responses.push({ status, headers });
      },
      end() {},
    };
    assert.equal(
      gateAuthenticatedRequest(
        { method: "GET", headers: { accept: "text/html" } },
        res,
        config,
        "/",
      ),
      undefined,
    );
    assert.equal(responses.at(-1).status, 302);
    assert.equal(responses.at(-1).headers.location, "/login");
    assert.equal(
      gateAuthenticatedRequest({ method: "POST", headers: {} }, res, config, "/lifeos/sessions/x"),
      undefined,
    );
    assert.equal(responses.at(-1).status, 401);
    assert.equal(responses.at(-1).headers["content-type"], "application/json; charset=utf-8");
  } finally {
    fixture.cleanup();
  }
});
