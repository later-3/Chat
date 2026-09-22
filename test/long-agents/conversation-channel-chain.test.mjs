import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createRouter } from "nitro/h3";
import { fixture } from "./daily-fixture.mjs";
import { readLongAgentRegistry, writeLongAgentRegistry } from "../../src/long-agents/storage.ts";
import { bindConversationChannel, readConversationDeliveries } from "../../src/long-agents/conversations/channel.ts";
import { bindParticipationSession, createConversation } from "../../src/long-agents/conversations/service.ts";
import { runConversationDiscussion } from "../../src/long-agents/conversations/orchestrator.ts";
import { readConversationPublicMessages } from "../../src/long-agents/conversations/publication.ts";
import conversationEventsHandler from "../../src/routes/api/internal/channel/v1/conversation-events.post.ts";
import conversationDeliveriesHandler from "../../src/routes/api/internal/channel/v1/conversation-deliveries.post.ts";

const TOKEN = "test-channel-token-that-is-at-least-32-characters";

async function startGateway(t) {
  const calls = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = body === "" ? {} : JSON.parse(body);
      calls.push({ url: request.url, authorization: request.headers.authorization, body: parsed });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ schemaVersion: 1, persisted: true, messageId: parsed.messageId, nanoSessionId: "nano-chain" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { calls, port: server.address().port };
}

/** End-to-end local chain: external inbound -> public root -> real dispatch -> gateway -> platform receipt. */
test("LA6 B: the local channel chain delivers the public reply and records the platform receipt", { concurrency: false }, async (t) => {
  const gateway = await startGateway(t);
  const f = await fixture(t);
  const previousHome = process.env.CHAT_HOME;
  process.env.CHAT_HOME = f.home;
  process.env.CHAT_CHANNEL_GATEWAY_TOKEN = TOKEN;
  t.after(() => {
    if (previousHome === undefined) delete process.env.CHAT_HOME; else process.env.CHAT_HOME = previousHome;
    delete process.env.CHAT_CHANNEL_GATEWAY_TOKEN;
  });
  const registry = await readLongAgentRegistry(f.home);
  await writeLongAgentRegistry({
    ...registry,
    instances: [{ id: "local", name: "Local", gatewayBaseUrl: `http://127.0.0.1:${String(gateway.port)}/webhook/chat-backend` }],
  }, f.home);
  const conversation = await createConversation({ chatHome: f.home, storageProjectId: "a", title: "链路群", requestId: "req-chain", memberLongAgentIds: ["friend"] });
  await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend" });
  const binding = await bindConversationChannel({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend",
    instanceId: "local", expectedRevision: 0, botPlatformId: "bot-chain",
    destination: { channelType: "telegram", instance: "telegram", platformId: "group-chain", threadId: null, messagingGroupId: "mg-chain" },
  });

  const router = createRouter();
  router.post("/api/internal/channel/v1/conversation-events", conversationEventsHandler);
  router.post("/api/internal/channel/v1/conversation-deliveries", conversationDeliveriesHandler);
  const post = (path, body) => router.fetch(new Request(`http://chat.test${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body),
  }));

  // Inbound external message through the trusted ingress.
  const inbound = await post("/api/internal/channel/v1/conversation-events", {
    schemaVersion: 1, instanceId: "local",
    events: [{ bindingId: binding.bindingId, senderExternalId: "user-chain", senderDisplayName: "外部用户", text: "外部提问", externalMessageId: "m-chain", eventId: "e-chain" }],
  });
  assert.equal(inbound.status, 202);
  const inboundBody = await inbound.json();
  assert.deepEqual(inboundBody.results[0], { eventId: "e-chain", accepted: true, appended: true, entryId: inboundBody.results[0].entryId, reason: null });
  const duplicate = await (await post("/api/internal/channel/v1/conversation-events", {
    schemaVersion: 1, instanceId: "local",
    events: [{ bindingId: binding.bindingId, senderExternalId: "user-chain", senderDisplayName: "外部用户", text: "外部提问", externalMessageId: "m-chain", eventId: "e-chain" }],
  })).json();
  assert.equal(duplicate.results[0].appended, false);

  // The real group round runs through Pi and publishes; delivery is triggered from the public reference.
  f.setHandler(() => ({ content: "CHAIN_PUBLIC_REPLY" }));
  await runConversationDiscussion({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, discussionId: "chain-round", policy: "mention", targets: ["friend"] });
  const deadline = Date.now() + 15_000;
  let deliveries = [];
  while (Date.now() < deadline) {
    deliveries = await readConversationDeliveries(f.home, "a", conversation.id);
    if (deliveries.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(deliveries.length, 1, "the dispatch chain must trigger exactly one delivery");
  assert.equal(deliveries[0].status, "queued", "Nano persistence is queued, not platform delivery");
  const message = gateway.calls.find((call) => call.url.endsWith("/v1/agent-messages"));
  assert.equal(message.body.text, "CHAIN_PUBLIC_REPLY", "the delivered text comes from the authorized public reference");
  assert.equal(message.body.messageId, deliveries[0].deliveryId);
  assert.equal(message.body.messagingGroupId, "mg-chain");

  // The platform receipt through the trusted ingress marks delivered.
  const receipt = await post("/api/internal/channel/v1/conversation-deliveries", {
    schemaVersion: 1, instanceId: "local",
    receipts: [{ deliveryId: deliveries[0].deliveryId, status: "delivered", platformMessageId: "platform-1" }],
  });
  assert.equal(receipt.status, 202);
  const confirmed = (await readConversationDeliveries(f.home, "a", conversation.id))[0];
  assert.equal(confirmed.status, "delivered");
  assert.equal(confirmed.platformMessageId, "platform-1");
  const projection = await readConversationPublicMessages({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, viewerLongAgentId: null });
  assert.equal(projection.some((entry) => entry.external && entry.text === "外部提问"), true, "the external sender stays visible in the public order");
});
