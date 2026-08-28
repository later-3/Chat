import assert from "node:assert/strict";
import test from "node:test";

const {
  createChatWebAuthToken,
  DEFAULT_CHAT_WEB_AUTH_PASSWORD,
  DEFAULT_CHAT_WEB_AUTH_USERNAME,
  getChatWebAuthConfig,
  isProtectedChatWebPath,
  matchesChatWebCredential,
  sanitizeChatWebAuthNext,
  verifyChatWebAuthToken,
} = await import("./web-auth.ts");

test("web authentication defaults to the requested Later account", () => {
  const config = getChatWebAuthConfig({});
  assert.equal(config.state, "enabled");
  assert.equal(DEFAULT_CHAT_WEB_AUTH_USERNAME, "later");
  assert.equal(DEFAULT_CHAT_WEB_AUTH_PASSWORD, "123456");
  assert.equal(matchesChatWebCredential(config, "later", "123456"), true);
  assert.equal(matchesChatWebCredential(config, "later", "wrong"), false);
  assert.equal(matchesChatWebCredential(config, "other", "123456"), false);
});

test("authentication can be disabled explicitly for trusted local development", () => {
  assert.deepEqual(getChatWebAuthConfig({ CHAT_WEB_AUTH_ENABLED: "0" }), { state: "disabled" });
});

test("signed sessions expire and are invalidated by credential rotation", () => {
  const config = getChatWebAuthConfig({});
  assert.equal(config.state, "enabled");
  const session = createChatWebAuthToken(config, true, 1_000);
  assert.deepEqual(verifyChatWebAuthToken(config, session.token, 1_001), {
    valid: true,
    expiresAt: 1_000 + 30 * 24 * 60 * 60,
    username: "later",
  });
  assert.deepEqual(verifyChatWebAuthToken(config, session.token, session.expiresAt), {
    valid: false,
    reason: "expired",
  });
  const rotated = getChatWebAuthConfig({ CHAT_WEB_AUTH_PASSWORD: "rotated" });
  assert.deepEqual(verifyChatWebAuthToken(rotated, session.token, 1_001), {
    valid: false,
    reason: "invalid",
  });
});

test("post-login destinations stay on the Chat origin", () => {
  assert.equal(sanitizeChatWebAuthNext("/?session=abc#message"), "/?session=abc#message");
  assert.equal(sanitizeChatWebAuthNext("https://attacker.example"), "/");
  assert.equal(sanitizeChatWebAuthNext("//attacker.example/path"), "/");
  assert.equal(sanitizeChatWebAuthNext("/login"), "/");
});

test("authentication protects product APIs but not Workflow runtime callbacks", () => {
  assert.equal(isProtectedChatWebPath("/api/sessions"), true);
  assert.equal(isProtectedChatWebPath("/runs/123"), true);
  assert.equal(isProtectedChatWebPath("/api/auth/session"), false);
  assert.equal(isProtectedChatWebPath("/manifest.webmanifest"), false);
  assert.equal(isProtectedChatWebPath("/.well-known/workflow/v1/step"), false);
});
