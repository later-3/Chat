import assert from "node:assert/strict";
import test from "node:test";

import {
  chatChannelAuthorization,
  getChatChannelGatewayToken,
  isChatChannelServicePath,
  verifyChatChannelAuthorization,
} from "../../src/long-agents/channel-service-auth.ts";

const token = "test-channel-token-that-is-at-least-32-characters";

test("Channel service authentication is separate from browser login", () => {
  const environment = { CHAT_CHANNEL_GATEWAY_TOKEN: token };
  assert.equal(getChatChannelGatewayToken(environment), token);
  assert.equal(chatChannelAuthorization(environment), `Bearer ${token}`);
  assert.equal(verifyChatChannelAuthorization(`Bearer ${token}`, environment), true);
  assert.equal(verifyChatChannelAuthorization("Bearer wrong", environment), false);
  assert.equal(verifyChatChannelAuthorization(undefined, environment), false);
  assert.equal(isChatChannelServicePath("/api/internal/channel/v1/events"), true);
  assert.equal(isChatChannelServicePath("/api/long-agents"), false);
});

test("Channel service rejects missing or weak credentials", () => {
  assert.throws(() => getChatChannelGatewayToken({}), /至少32个字符/);
  assert.throws(() => getChatChannelGatewayToken({ CHAT_CHANNEL_GATEWAY_TOKEN: "short" }), /至少32个字符/);
});
