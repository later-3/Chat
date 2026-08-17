import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildSessionSetCookie,
  gateAuthenticatedRequest,
  hashWebAuthPassword,
  isPublicAuthPath,
  loadWebAuthConfig,
  sessionCookieFromRequest,
  SESSION_COOKIE_NAME,
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
      users: [
        { username: "later", scrypt: { salt, hash: hashWebAuthPassword("correct-horse", salt) } },
      ],
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
    writeFileSync(join(fixture.dir, "weak"), "short");
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

test("password verification uses scrypt with constant-time compare", () => {
  const fixture = writeAuthFixture();
  try {
    const config = loadWebAuthConfig(fixture.env);
    assert.ok(verifyWebAuthPassword(config, "later", "correct-horse"));
    assert.equal(verifyWebAuthPassword(config, "later", "wrong"), false);
    assert.equal(verifyWebAuthPassword(config, "nobody", "correct-horse"), false);
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
