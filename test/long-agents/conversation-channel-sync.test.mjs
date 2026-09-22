import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createRouter } from "nitro/h3";
import { fixture } from "./daily-fixture.mjs";
import { readLongAgentRegistry, writeLongAgentRegistry } from "../../src/long-agents/storage.ts";
import { bindParticipationSession, createConversation } from "../../src/long-agents/conversations/service.ts";
import { listConversationChannels, markConversationChannelSynced } from "../../src/long-agents/conversations/channel.ts";
import channelsHandler from "../../src/routes/api/long-agents/[longAgentId]/conversations/[conversationId]/channels.post.ts";

const TOKEN = "test-channel-token-that-is-at-least-32-characters";

async function startGateway(t, { failFirst = 0 } = {}) {
  const calls = [];
  let remainingFailures = failFirst;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = body === "" ? {} : JSON.parse(body);
      calls.push({ url: request.url, authorization: request.headers.authorization, body: parsed });
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "unavailable" }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ schemaVersion: 1, bindingId: parsed.bindingId, status: parsed.action === "unbind" ? "unbound" : "active", revision: parsed.revision }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { calls, port: server.address().port };
}

async function setup(t, gateway) {
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
  const conversation = await createConversation({ chatHome: f.home, storageProjectId: "a", title: "同步群", requestId: "req-sync", memberLongAgentIds: ["friend"] });
  await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend" });
  const router = createRouter();
  router.post("/api/long-agents/:longAgentId/conversations/:conversationId/channels", channelsHandler);
  const post = (body) => router.fetch(new Request(`http://chat.test/api/long-agents/friend/conversations/${conversation.id}/channels`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  return { f, conversation, post };
}

test("LA6 B: the owner bind/unbind mirrors the channel binding to NanoClaw", async (t) => {
  const gateway = await startGateway(t);
  const { conversation, post } = await setup(t, gateway);

  const bound = await post({
    action: "bind", longAgentId: "friend", instanceId: "local", expectedRevision: 0, botPlatformId: "bot-sync",
    destination: { channelType: "telegram", instance: "telegram", platformId: "group-sync", threadId: null, messagingGroupId: "mg-sync" },
  });
  assert.equal(bound.status, 200, JSON.stringify(await bound.clone().json()));
  const boundBody = await bound.json();
  assert.equal(boundBody.binding.status, "active");
  assert.deepEqual(boundBody.synced, [boundBody.binding.bindingId]);
  assert.deepEqual(boundBody.pending, []);
  const bindCall = gateway.calls.find((call) => call.url === "/webhook/chat-backend/v1/conversation-channels");
  assert.deepEqual(bindCall.body, {
    schemaVersion: 1, action: "bind", bindingId: boundBody.binding.bindingId, revision: 1,
    agentGroupId: boundBody.binding.agentGroupId, channelType: "telegram", platformId: "group-sync",
    messagingGroupId: "mg-sync", threadId: null, botPlatformId: "bot-sync",
  });

  gateway.calls.length = 0;
  const unbound = await post({ action: "unbind", bindingId: boundBody.binding.bindingId, expectedRevision: 1 });
  const unboundBody = await unbound.json();
  assert.equal(unboundBody.binding.status, "unbound");
  assert.deepEqual(unboundBody.synced, [boundBody.binding.bindingId]);
  assert.deepEqual(gateway.calls[0].body, {
    schemaVersion: 1, action: "unbind", bindingId: boundBody.binding.bindingId, revision: 2,
    agentGroupId: boundBody.binding.agentGroupId, channelType: "telegram", platformId: "group-sync",
    messagingGroupId: "mg-sync", threadId: null, botPlatformId: "bot-sync",
  });
});

test("LA6 B: a failed mirror stays pending and is repaired by the sync action", async (t) => {
  const gateway = await startGateway(t, { failFirst: 1 });
  const { f, conversation, post } = await setup(t, gateway);
  const bound = await post({
    action: "bind", longAgentId: "friend", instanceId: "local", expectedRevision: 0,
    destination: { channelType: "telegram", instance: "telegram", platformId: "group-sync", threadId: "5", messagingGroupId: "mg-sync" },
  });
  const boundBody = await bound.json();
  assert.deepEqual(boundBody.synced, []);
  assert.deepEqual(boundBody.pending, [boundBody.binding.bindingId]);
  assert.equal((await listConversationChannels(f.home, "a", conversation.id))[0].syncedRevision, null);

  // The durable binding stays active and the explicit owner sync repairs the mirror.
  const repaired = await post({ action: "sync" });
  const repairedBody = await repaired.json();
  assert.deepEqual(repairedBody.synced, [boundBody.binding.bindingId]);
  assert.deepEqual(repairedBody.pending, []);
  assert.equal((await listConversationChannels(f.home, "a", conversation.id))[0].syncedRevision, 1);
});

test("LA6 B: a late sync acknowledgement cannot mark a newer revision synced", async (t) => {
  const gateway = await startGateway(t);
  const { f, conversation, post } = await setup(t, gateway);
  const bound = await post({
    action: "bind", longAgentId: "friend", instanceId: "local", expectedRevision: 0,
    destination: { channelType: "telegram", instance: "telegram", platformId: "group-sync", threadId: null, messagingGroupId: "mg-sync" },
  });
  const bindingId = (await bound.json()).binding.bindingId;
  // Bump the revision with an unbind, then a stale acknowledgement for revision 1 must be ignored.
  await post({ action: "unbind", bindingId, expectedRevision: 1 });
  await markConversationChannelSynced({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, bindingId, syncRevision: 1, synced: true });
  const binding = (await listConversationChannels(f.home, "a", conversation.id))[0];
  assert.equal(binding.syncRevision, 2);
  assert.notEqual(binding.syncedRevision, 1, "a stale ack must not confirm the newer revision");
});

test("LA6 B: a named platform adapter instance travels intact to NanoClaw", async (t) => {
  const gateway = await startGateway(t);
  const { post } = await setup(t, gateway);
  const response = await post({
    action: "bind", longAgentId: "friend", instanceId: "local", expectedRevision: 0,
    destination: { channelType: "telegram", instance: "telegram-work", platformId: "group-sync", threadId: "10", messagingGroupId: "mg-sync" },
  });
  assert.equal(response.status, 200);
  assert.equal(gateway.calls[0].body.instance, "telegram-work", "a non-default adapter instance must not be dropped");
  assert.equal(gateway.calls[0].body.platformId, "group-sync");
  assert.equal(gateway.calls[0].body.threadId, "10");
});
