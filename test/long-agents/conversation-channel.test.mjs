import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { fixture } from "./daily-fixture.mjs";
import { readLongAgentRegistry, writeLongAgentRegistry } from "../../src/long-agents/storage.ts";
import { openChatSession } from "../../src/chat-session.ts";
import {
  bindConversationChannel,
  confirmConversationDelivery,
  recoverConversationDeliveries,
  deliverConversationPublication,
  drainConversationDeliveries,
  findConversationChannelBinding,
  listConversationChannels,
  readConversationDeliveries,
  unbindConversationChannel,
} from "../../src/long-agents/conversations/channel.ts";
import { archiveConversation, bindParticipationSession, createConversation, readConversation } from "../../src/long-agents/conversations/service.ts";
import { publishConversationSpeech, readConversationPublicMessages } from "../../src/long-agents/conversations/publication.ts";

const TOKEN = "test-channel-token-that-is-at-least-32-characters";

async function withGateway(t, initialMode = "ok") {
  let mode = initialMode;
  let hold = null;
  const calls = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = body === "" ? {} : JSON.parse(body);
      calls.push({ url: request.url, authorization: request.headers.authorization, body: parsed });
      if (mode === "down") {
        response.destroy();
        return;
      }
      const send = () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        if (mode === "no-ack") {
          response.end(JSON.stringify({ schemaVersion: 1, messageId: parsed.messageId }));
          return;
        }
        response.end(JSON.stringify({ schemaVersion: 1, persisted: true, messageId: parsed.messageId, nanoSessionId: `nano-${String(calls.length)}` }));
      };
      if (mode === "hold") hold = send; else send();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return {
    calls, port: server.address().port, setMode: (next) => { mode = next; },
    release: () => { const pending = hold; hold = null; pending?.(); },
    awaitingHold: () => hold !== null,
  };
}

async function setup(t, gatewayPort) {
  const f = await fixture(t);
  process.env.CHAT_CHANNEL_GATEWAY_TOKEN = TOKEN;
  t.after(() => { delete process.env.CHAT_CHANNEL_GATEWAY_TOKEN; });
  const registry = await readLongAgentRegistry(f.home);
  await writeLongAgentRegistry({
    ...registry,
    instances: [{ id: "local", name: "Local", gatewayBaseUrl: `http://127.0.0.1:${String(gatewayPort)}/webhook/chat-backend` }],
  }, f.home);
  const conversation = await createConversation({
    chatHome: f.home, storageProjectId: "a", title: "外部群", requestId: "req-channel", memberLongAgentIds: ["friend"],
  });
  const bound = await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend" });
  const binding = await bindConversationChannel({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend",
    instanceId: "local", expectedRevision: 0, botPlatformId: "bot-1",
    destination: { channelType: "telegram", instance: "telegram", platformId: "group-1", threadId: null, messagingGroupId: "mg-group-1" },
  });
  return { f, conversation, bound, binding };
}

test("LA6 B: inbound external messages keep their real sender, dedupe by stable id and never create an owner", async (t) => {
  const gateway = await withGateway(t);
  const { f, conversation, binding } = await setup(t, gateway.port);
  assert.equal((await listConversationChannels(f.home, "a", conversation.id)).length, 1);
  assert.deepEqual(await findConversationChannelBinding(f.home, binding.bindingId), { binding, storageProjectId: "a", conversationId: conversation.id });
  const before = f.requests.length;

  const first = await receive(f, conversation, binding, { senderExternalId: "user-7", senderDisplayName: "张三", text: "外部提问", eventId: "ev-1", externalMessageId: "m-1" });
  assert.deepEqual({ accepted: first.accepted, appended: first.appended }, { accepted: true, appended: true });
  const duplicate = await receive(f, conversation, binding, { senderExternalId: "user-7", senderDisplayName: "张三", text: "外部提问", eventId: "ev-1", externalMessageId: "m-1" });
  assert.equal(duplicate.appended, false, "a repeated external event is not appended twice");
  assert.equal(duplicate.entryId, first.entryId);
  const resent = await receive(f, conversation, binding, { senderExternalId: "user-7", senderDisplayName: "张三", text: "外部提问", eventId: "ev-1-retry", externalMessageId: "m-1" });
  assert.equal(resent.appended, false, "the same external message id from a webhook resend is deduplicated too");
  assert.equal(f.requests.length, before, "receiving an external message never calls the model");

  const projection = await readConversationPublicMessages({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, viewerLongAgentId: null });
  const external = projection.find((message) => message.entryId === first.entryId);
  assert.equal(external.external, true);
  assert.equal(external.authorLongAgentId, "external:user-7");
  assert.equal(external.authorDisplayName, "张三");
  assert.equal(external.text, "外部提问");
  assert.equal(projection.filter((message) => message.external).length, 1, "the public order holds exactly one external message");

  // The Friend's own bot identity is dropped to avoid a loop.
  const echo = await receive(f, conversation, binding, { senderExternalId: "bot-1", senderDisplayName: "bot", text: "self echo", eventId: "ev-echo", externalMessageId: "m-echo" });
  assert.equal(echo.accepted, false);
  assert.match(echo.reason, /回环/);

  // An unbound destination cannot create an owner or an entry.
  const rejected = await receive(f, conversation, { bindingId: "chb-unknown" }, { senderExternalId: "user-9", senderDisplayName: null, text: "hi", eventId: "ev-x", externalMessageId: "m-x" });
  assert.equal(rejected.accepted, false);
  assert.match(rejected.reason, /未绑定/);
  assert.equal((await readConversationPublicMessages({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, viewerLongAgentId: null })).filter((message) => message.external).length, 1);
});

test("LA6 B: outbound distinguishes Nano persistence from a platform delivery receipt", async (t) => {
  const gateway = await withGateway(t);
  const { f, conversation, bound } = await setup(t, gateway.port);
  const published = await publish(f, conversation, bound, { attemptId: "attempt-1", text: "PUBLIC_REPLY_1" });

  // HTTP 200 from NanoClaw is durable persistence, not platform delivery.
  const queued = await deliverConversationPublication({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, publicationId: published.publication.publicationId });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].status, "queued");
  assert.equal(queued[0].nanoSessionId.startsWith("nano-"), true);
  assert.equal(queued[0].platformMessageId, null);
  const deliveryId = queued[0].deliveryId;
  const firstCall = gateway.calls.find((call) => call.url.endsWith("/v1/agent-messages"));
  assert.equal(firstCall.body.messageId, deliveryId, "the idempotency key is derived from the publication and binding");
  assert.equal(firstCall.body.text, "PUBLIC_REPLY_1");
  assert.equal(firstCall.authorization, `Bearer ${TOKEN}`);
  assert.equal(firstCall.body.messagingGroupId, "mg-group-1");
  const callsAfterQueued = gateway.calls.length;
  // A queued message awaiting a platform receipt is not auto-resent by the retry worker.
  assert.deepEqual(await drainConversationDeliveries({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id }), []);
  assert.equal(gateway.calls.length, callsAfterQueued);

  // Only the platform receipt marks delivered.
  const confirmed = await confirmConversationDelivery({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, deliveryId, status: "delivered", platformMessageId: "pm-1" });
  assert.equal(confirmed.status, "delivered");
  assert.equal(confirmed.platformMessageId, "pm-1");
  // A late "failed" receipt cannot overwrite a confirmed delivery.
  assert.equal((await confirmConversationDelivery({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, deliveryId, status: "failed" })).status, "delivered");

  // A platform failure receipt makes it retryable with the same id and no model call.
  const modelCalls = f.requests.length;
  const published2 = await publish(f, conversation, bound, { attemptId: "attempt-2", text: "PUBLIC_REPLY_2" });
  const queued2 = await deliverConversationPublication({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, publicationId: published2.publication.publicationId });
  assert.equal(queued2[0].status, "queued");
  await confirmConversationDelivery({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, deliveryId: queued2[0].deliveryId, status: "failed", error: "platform rejected" });
  const retried = await drainConversationDeliveries({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id });
  assert.equal(retried.length, 1);
  assert.equal(retried[0].status, "queued");
  const messageIds = gateway.calls.filter((call) => call.body.text === "PUBLIC_REPLY_2").map((call) => call.body.messageId);
  assert.equal(messageIds.length, 2, "the definitive failure was retried once");
  assert.deepEqual(new Set(messageIds), new Set([queued2[0].deliveryId]));
  assert.equal(f.requests.length, modelCalls, "delivery retries never regenerate the answer");
});

test("LA6 B: delivery always resolves the authorized public reference and rejects unknown or archived groups", async (t) => {
  const gateway = await withGateway(t);
  const { f, conversation, bound } = await setup(t, gateway.port);
  const before = gateway.calls.length;
  // A nonexistent publication with arbitrary content must never reach the gateway.
  await assert.rejects(deliverConversationPublication({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, publicationId: "pub-does-not-exist",
  }), /公开引用不存在或不可用/);
  assert.equal(gateway.calls.length, before, "no gateway call for an unverifiable reference");

  // An archived group neither receives inbound external messages nor delivers outbound.
  const published = await publish(f, conversation, bound, { attemptId: "archived-attempt", text: "ARCHIVED_REPLY" });
  await archiveConversation({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, expectedRevision: (await readConversation(f.home, "a", conversation.id)).revision });
  const inbound = await receive(f, conversation, { bindingId: (await listConversationChannels(f.home, "a", conversation.id))[0].bindingId }, { senderExternalId: "user-1", senderDisplayName: null, text: "late", eventId: "ev-archived", externalMessageId: "m-archived" });
  assert.equal(inbound.accepted, false);
  assert.match(inbound.reason, /已归档/);
  await assert.rejects(deliverConversationPublication({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, publicationId: published.publication.publicationId,
  }), /已归档/);
});

test("LA6 B: an unavailable gateway is recorded as 待核查 and is not auto-resent; unbind stops delivery", async (t) => {
  const gateway = await withGateway(t, "down");
  const { f, conversation, bound } = await setup(t, gateway.port);
  const published = await publish(f, conversation, bound, { attemptId: "uncertain-attempt", text: "UNCERTAIN_REPLY" });
  const result = await deliverConversationPublication({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, publicationId: published.publication.publicationId });
  assert.equal(result[0].status, "unknown", "an ambiguous result is 待核查, not delivered");
  const before = gateway.calls.length;
  assert.deepEqual(await drainConversationDeliveries({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id }), [], "an uncertain delivery is not auto-resent");
  assert.equal(gateway.calls.length, before);

  const channels = await listConversationChannels(f.home, "a", conversation.id);
  await unbindConversationChannel({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, bindingId: channels[0].bindingId, expectedRevision: 1 });
  gateway.setMode("ok");
  assert.deepEqual(await deliverConversationPublication({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, publicationId: published.publication.publicationId }), [], "an unbound destination receives nothing");
  assert.equal((await readConversationDeliveries(f.home, "a", conversation.id)).every((delivery) => delivery.status !== "delivered"), true);
});

async function publish(f, conversation, bound, { attemptId, text }) {
  const session = await openChatSession({ chatHome: f.home, projectId: "a", sessionId: bound.sessionId });
  session.manager.appendMessage({ role: "assistant", content: text, timestamp: Date.now() });
  session.manager.flush();
  const entry = session.manager.getEntries().filter((candidate) => candidate.type === "message" && candidate.message.role === "assistant").at(-1);
  const current = await readConversation(f.home, "a", conversation.id);
  return publishConversationSpeech({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend",
    attemptId, participationEpoch: 1, authorizationRevision: current.authorizationRevision,
    sourceSessionId: bound.sessionId, sourceEntryId: entry.id, text,
  });
}

async function receive(f, conversation, binding, event) {
  const { acceptConversationInboundMessage } = await import("../../src/long-agents/conversations/channel.ts");
  return acceptConversationInboundMessage({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, bindingId: binding.bindingId, ...event,
  });
}

test("LA6 B: a receipt racing an in-flight send cannot downgrade or duplicate the delivery", async (t) => {
  const gateway = await withGateway(t, "hold");
  const { f, conversation, bound } = await setup(t, gateway.port);
  const published = await publish(f, conversation, bound, { attemptId: "race-attempt", text: "RACE_REPLY" });
  const deliveryId = (await import("../../src/long-agents/conversations/channel.ts")).deliveryIdOf(published.publication.publicationId, (await listConversationChannels(f.home, "a", conversation.id))[0].bindingId);

  const pending = deliverConversationPublication({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, publicationId: published.publication.publicationId });
  const deadline = Date.now() + 5_000;
  while (!gateway.awaitingHold() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(gateway.awaitingHold(), true, "the send must be in flight");
  // The platform receipt is processed while the HTTP send is still in flight.
  const receipt = confirmConversationDelivery({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, deliveryId, status: "delivered", platformMessageId: "pm-race" });
  gateway.release();
  await pending;
  const confirmed = await receipt;
  assert.equal(confirmed.status, "delivered");
  assert.equal(confirmed.platformMessageId, "pm-race");
  assert.equal((await readConversationDeliveries(f.home, "a", conversation.id))[0].status, "delivered", "a late persistence write must not downgrade a confirmed delivery");

  // A second publish/call must not resend a delivered message.
  const callsBefore = gateway.calls.length;
  await deliverConversationPublication({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, publicationId: published.publication.publicationId });
  assert.equal(gateway.calls.length, callsBefore, "an already delivered publication is never sent again");
  assert.equal(gateway.calls.filter((call) => call.url.endsWith("/v1/agent-messages")).length, 1);
});

test("LA6 B: concurrent publish calls and a crashed in-flight attempt never resend or roll back", async (t) => {
  const gateway = await withGateway(t, "hold");
  const { f, conversation, bound } = await setup(t, gateway.port);
  const published = await publish(f, conversation, bound, { attemptId: "concurrent-attempt", text: "CONCURRENT_REPLY" });
  const [{ deliveryIdOf }, channels] = await Promise.all([
    import("../../src/long-agents/conversations/channel.ts"),
    listConversationChannels(f.home, "a", conversation.id),
  ]);
  const deliveryId = deliveryIdOf(published.publication.publicationId, channels[0].bindingId);

  // Two concurrent calls for the same publication must produce exactly one gateway request.
  const first = deliverConversationPublication({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, publicationId: published.publication.publicationId });
  const deadline = Date.now() + 5_000;
  while (!gateway.awaitingHold() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  const second = deliverConversationPublication({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, publicationId: published.publication.publicationId });
  gateway.release();
  await Promise.all([first, second]);
  const { readConversationDeliveries } = await import("../../src/long-agents/conversations/channel.ts");
  assert.equal((await readConversationDeliveries(f.home, "a", conversation.id))[0].status, "queued");
  assert.equal(gateway.calls.filter((call) => call.url.endsWith("/v1/agent-messages")).length, 1, "a concurrent duplicate is not sent twice");

  // Crash recovery: an in-flight claim older than the threshold becomes 待核查 and is never resent.
  const published2 = await publish(f, conversation, bound, { attemptId: "crash-attempt", text: "CRASH_REPLY" });
  const delivery2 = deliveryIdOf(published2.publication.publicationId, channels[0].bindingId);
  gateway.setMode("hold");
  const inFlight = deliverConversationPublication({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, publicationId: published2.publication.publicationId });
  const deadline2 = Date.now() + 5_000;
  while (!gateway.awaitingHold() && Date.now() < deadline2) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(gateway.awaitingHold(), true);
  const recovered = await recoverConversationDeliveries({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, now: Date.now() + 10 * 60 * 1000, staleClaimMs: 60_000 });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].status, "unknown");
  gateway.release();
  await inFlight;
  const after = (await readConversationDeliveries(f.home, "a", conversation.id)).find((delivery) => delivery.deliveryId === delivery2);
  assert.equal(after.status, "unknown", "a stale in-flight result must not overwrite the recovered state");
  const callsBefore = gateway.calls.length;
  assert.deepEqual(await drainConversationDeliveries({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id }), [], "a recovered unknown delivery is not auto-resent");
  assert.equal(gateway.calls.length, callsBefore);
});
