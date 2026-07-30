import assert from "node:assert/strict";
import test from "node:test";

import { joinRuntimeUrl, resolveRuntimeBaseUrl } from "../src/runtime-config.js";

test("browser runtime defaults to the page origin instead of localhost", () => {
  assert.equal(
    resolveRuntimeBaseUrl(undefined, "https://121.43.113.236"),
    "https://121.43.113.236",
  );
});

test("deployment may provide an IP-safe reverse proxy prefix", () => {
  assert.equal(resolveRuntimeBaseUrl("/chat-api/"), "/chat-api");
  assert.equal(joinRuntimeUrl("/chat-api/", "/api/agent"), "/chat-api/api/agent");
});

test("Node contract tests retain an explicit loopback fallback", () => {
  assert.equal(resolveRuntimeBaseUrl(), "http://127.0.0.1:18030");
});
