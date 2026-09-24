import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./daily-fixture.mjs";
import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { readSessionMemory } from "../../src/long-agents/session-memory.ts";
import { createTopic, createTopicNode, createTopicNodeWithSession, readTopicGraph } from "../../src/long-agents/topics.ts";
import { readChatSession } from "../../src/session-read-model.ts";
import { ensureChatSessionWithId } from "../../src/chat-session.ts";
import { readLongAgentState } from "../../src/long-agents/storage.ts";
import { appendChatUserMessage } from "../../src/workflows/session-conversation.ts";

async function router() {
  const { createRouter } = await import("nitro/h3");
  const routes = [
    ["/api/long-agents/:longAgentId/topics", "../../src/routes/api/long-agents/[longAgentId]/topics/index.get.ts"],
    ["/api/long-agents/:longAgentId/topics/:topicId", "../../src/routes/api/long-agents/[longAgentId]/topics/[topicId].get.ts"],
    ["/api/long-agents/:longAgentId/topics/:topicId/nodes/:nodeId/messages", "../../src/routes/api/long-agents/[longAgentId]/topics/[topicId]/nodes/[nodeId]/messages.get.ts"],
  ];
  const app = createRouter();
  for (const [path, module] of routes) app.get(path, (await import(module)).default);
  app.post("/api/long-agents/:longAgentId/topics/:topicId/nodes/:nodeId/messages",
    (await import("../../src/routes/api/long-agents/[longAgentId]/topics/[topicId]/nodes/[nodeId]/messages.post.ts")).default);
  return app;
}

test("topic API: graph, topic, node messages and a node turn are owner-facing and node-scoped", async (t) => {
  const base = await fixture(t);
  const previousHome = process.env.CHAT_HOME;
  process.env.CHAT_HOME = base.home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.CHAT_HOME;
    else process.env.CHAT_HOME = previousHome;
  });
  const app = await router();
  const call = (path, init) => app.fetch(new Request(`http://chat.test${path}`, init));
  const topic = (await createTopic({ chatHome: base.home, longAgentId: "friend", title: "定位", purpose: "定位线上问题", requestId: "api-topic", expectedRevision: 0 })).topic;
  const node = (await createTopicNode({ chatHome: base.home, longAgentId: "friend", topicId: topic.topicId, title: "根节点", createdBy: "agent", requestId: "api-topic", expectedRevision: 1 }));
  const session = await ensureChatSessionWithId({ chatHome: base.home, projectId: "friend" }, node.node.sessionId, "根");
  appendChatUserMessage(session.session.manager, "节点里的第一条消息");
  session.session.manager.flush();

  const graph = await call("/api/long-agents/friend/topics");
  assert.equal(graph.status, 200);
  const graphBody = await graph.json();
  assert.equal(graphBody.topics.length, 1);
  assert.equal(graphBody.topics[0].nodes[0].nodeId, node.node.nodeId);
  assert.equal(graphBody.topics[0].nodes[0].readable, true);
  assert.equal(graphBody.topics[0].nodes[0].sessionId, node.node.sessionId, "the session id is exposed only through the resolved node");

  const one = await call(`/api/long-agents/friend/topics/${topic.topicId}`);
  assert.equal(one.status, 200);
  assert.equal((await one.json()).nodes.length, 1);
  assert.equal((await call("/api/long-agents/friend/topics/topic-00000000000000000000000000000000")).status, 404);

  const messages = await call(`/api/long-agents/friend/topics/${topic.topicId}/nodes/${node.node.nodeId}/messages`);
  assert.equal(messages.status, 200);
  const messagesBody = await messages.json();
  assert.equal(Array.isArray(messagesBody.context.messages), true);
  assert.deepEqual(messagesBody.context.messages.map((message) => message.role), ["user"]);
  assert.equal(messagesBody.context.messages[0].content[0].text, "节点里的第一条消息", "the node's messages are returned");
  assert.equal((await call(`/api/long-agents/friend/topics/${topic.topicId}/nodes/node-00000000000000000000000000000000/messages`)).status, 404);

  // A second topic: the single-topic read must not leak its nodes or edges.
  const other = (await createTopic({ chatHome: base.home, longAgentId: "friend", title: "另一个主题", purpose: "隔离", requestId: "api-topic-2", expectedRevision: graphBody.revision })).topic;
  const otherNode = await createTopicNode({ chatHome: base.home, longAgentId: "friend", topicId: other.topicId, title: "另一个根节点",
    createdBy: "agent", requestId: "api-topic-2", expectedRevision: (await readTopicGraph(base.home, "friend")).revision });
  const scoped = await (await call(`/api/long-agents/friend/topics/${topic.topicId}`)).json();
  assert.equal(scoped.nodes.every((candidate) => candidate.topicId === topic.topicId), true);
  assert.equal(scoped.edges.every((edge) => scoped.nodes.some((candidate) => candidate.nodeId === edge.parentNodeId)
    && scoped.nodes.some((candidate) => candidate.nodeId === edge.childNodeId)), true, "only this topic's edges are returned");
  // A node id from another topic is not reachable through this topic's route.
  const otherMessages = await call(`/api/long-agents/friend/topics/${topic.topicId}/nodes/${otherNode.node.nodeId}/messages`);
  assert.equal(otherMessages.status, 404, "the URL must describe one consistent topic+node path");

  // A node turn is accepted on the NODE session (the client never sends a session id). This example
  // only exercises acceptance, so its fire-and-forget worker is drained before the fixture disappears.
  const sent = await call(`/api/long-agents/friend/topics/${topic.topicId}/nodes/${node.node.nodeId}/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, requestId: "api-turn-1", text: "继续定位" }),
  });
  if (sent.status !== 202) console.log("SENT_ERROR", sent.status, await sent.text());
  assert.equal(sent.status, 202);
  // Restart-equivalent: a fresh read of the durable state exposes the binding AND the accepted turn.
  const fresh = await readLongAgentState(base.home);
  assert.deepEqual(
    fresh.nodeSessions.filter((entry) => entry.sessionId === node.node.sessionId),
    [{ longAgentId: "friend", sessionId: node.node.sessionId, topicId: topic.topicId, nodeId: node.node.nodeId,
      createdAt: fresh.nodeSessions.find((entry) => entry.sessionId === node.node.sessionId).createdAt }],
    "the node binding is durable next to the turn",
  );
  const turn = fresh.turns.find((candidate) => candidate.turnId === "chat-web:friend:api-turn-1");
  assert.notEqual(turn, undefined, "the turn was accepted");
  assert.equal(turn.sessionId, node.node.sessionId, "the turn runs in the node session, not in the daily session");
  assert.deepEqual(turn.topicNode, { topicId: topic.topicId, nodeId: node.node.nodeId }, "the turn carries its node target");
  assert.equal(fresh.dailySessions.some((day) => day.sessionId === node.node.sessionId), false, "a node round never appears in today's index");
  // A mismatched topic/node is refused before anything lands in the state.
  const before = await readLongAgentState(base.home);
  assert.equal((await call(`/api/long-agents/friend/topics/${other.topicId}/nodes/${node.node.nodeId}/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, requestId: "api-turn-2", text: "串主题" }),
  })).status, 404);
  const after = await readLongAgentState(base.home);
  assert.equal(after.turns.length, before.turns.length, "no turn was accepted for the mismatched path");
  assert.equal(after.nodeSessions.length, before.nodeSessions.length, "no binding was written for the mismatched path");
  // Re-sending the SAME node POST is a replay: one turn, one binding, same turn id.
  const replay = await call(`/api/long-agents/friend/topics/${topic.topicId}/nodes/${node.node.nodeId}/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, requestId: "api-turn-1", text: "继续定位" }),
  });
  assert.equal(replay.status, 202, "an identical node POST replays instead of conflicting");
  const replayed = await readLongAgentState(base.home);
  assert.equal(replayed.turns.filter((candidate) => candidate.requestId === "api-turn-1").length, 1, "no second turn was accepted");
  assert.equal(replayed.nodeSessions.filter((entry) => entry.sessionId === node.node.sessionId).length, 1, "no second binding was written");
  // A second node of the SAME topic: the same request id must not be re-pointed at it.
  const sibling = await createTopicNode({ chatHome: base.home, longAgentId: "friend", topicId: topic.topicId,
    title: "另一个节点", createdBy: "agent", requestId: "api-turn-sibling",
    expectedRevision: (await readTopicGraph(base.home, "friend")).revision, parents: [{ parentNodeId: node.node.nodeId }] });
  assert.equal((await call(`/api/long-agents/friend/topics/${topic.topicId}/nodes/${sibling.node.nodeId}/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, requestId: "api-turn-1", text: "继续定位" }),
  })).status, 409, "the same request id cannot be re-pointed at another node");

  // The reverse polarity: a node acceptance cannot be replayed through the ordinary entry.
  const { acceptLongAgentTurn } = await import("../../src/long-agents/turn-queue.ts");
  await assert.rejects(
    acceptLongAgentTurn({ chatHome: base.home, longAgentId: "friend", requireInteractionRevision: false, projectId: "friend",
      turnId: "api-turn-1", text: "继续定位", sessionId: node.node.sessionId, source: "chat-web" }),
    (error) => error.statusCode === 409 && /不可互换/.test(error.message),
    "an ordinary round must not replay a node round with the same request id",
  );
  const afterKindMismatch = await readLongAgentState(base.home);
  assert.equal(afterKindMismatch.turns.filter((candidate) => candidate.requestId === "api-turn-1").length, 1);

  // Invalid bodies are refused before any turn is accepted.
  assert.equal((await call(`/api/long-agents/friend/topics/${topic.topicId}/nodes/${node.node.nodeId}/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, text: "缺少 requestId" }),
  })).status, 400);
  // Let the accepted turn's background worker finish before the fixture (and its model server) go away.
  const { drainLongAgentTurns: drain } = await import("../../src/long-agents/turn-queue.ts");
  await drain(base.home, "friend", node.node.sessionId).catch(() => undefined);
  await readLongAgentState(base.home);

});

test("topic API: a node turn executes from durable state inside its own session, then settles and forks", async (t) => {
  const base = await fixture(t);
  const previousHome = process.env.CHAT_HOME;
  process.env.CHAT_HOME = base.home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.CHAT_HOME;
    else process.env.CHAT_HOME = previousHome;
  });
  const app = await router();
  const call = (path, init) => app.fetch(new Request(`http://chat.test${path}`, init));
  const topic = (await createTopic({ chatHome: base.home, longAgentId: "friend", title: "定位", purpose: "定位线上问题", requestId: "run-topic", expectedRevision: 0 })).topic;
  const node = (await createTopicNodeWithSession({ chatHome: base.home, longAgentId: "friend", topicId: topic.topicId,
    requestId: "run-topic", title: "根节点", createdBy: "agent" })).node;
  const sent = await call(`/api/long-agents/friend/topics/${topic.topicId}/nodes/${node.nodeId}/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, requestId: "run-turn-1", text: "把那个空指针修了" }),
  });
  if (sent.status !== 202) console.log("SENT2_ERROR", sent.status, await sent.text());
  assert.equal(sent.status, 202);
  // Durability-only drive: the worker is given the queued turn and re-resolves the session from the
  // durable binding (no acceptance-time value is reused). NOTE: this is still the SAME process, so it
  // proves "selected from durable state", not a process-level restart; a child-process restart probe is
  // still owed (see the taskbook).
  const { drainLongAgentTurns } = await import("../../src/long-agents/turn-queue.ts");
  await drainLongAgentTurns(base.home, "friend", node.sessionId);
  const settled = await readLongAgentState(base.home);
  const turn = settled.turns.find((candidate) => candidate.turnId === "chat-web:friend:run-turn-1");
  assert.equal(turn.status, "completed", "the node turn executed to completion after the durable state drove it");
  assert.notEqual(turn.settledAt, undefined);
  const produced = await readChatSession(node.sessionId, undefined, {}, "friend", base.home, { kind: "owner" });
  assert.equal(produced.context.messages.some((message) => message.role === "assistant"), true, "the assistant replied in the node session");
  // The assistant round is settled in the node session, so the branch is forkable through the tool.
  const { appendTopicRoundMarker, readTopicSettledAnchors } = await import("../../src/long-agents/topic-anchor.ts");
  const manager = (await ensureChatSessionWithId({ chatHome: base.home, projectId: "friend" }, node.sessionId)).session.manager;
  const round = readTopicSettledAnchors(manager);
  assert.equal(round.length, 1, "the executed node round settles exactly one anchor");
  const childResult = await createTopicNodeWithSession({ chatHome: base.home, longAgentId: "friend", topicId: topic.topicId,
    requestId: "run-child", title: "修复分支", createdBy: "agent", integrationSummary: "已修复空指针", initialMemory: null, source: null,
    parents: [{ parentNodeId: node.nodeId, anchorEntryId: round[0].anchorEntryId, anchorSequence: round[0].anchorSequence }] });
  assert.equal(childResult.created, true);
  assert.equal(childResult.node.initialMemoryRefs.length, 0, "a fork without integration sources keeps an empty provenance list");
  assert.equal(childResult.graph.edges.find((edge) => edge.childNodeId === childResult.node.nodeId).anchorSequence, round[0].anchorSequence);
});

test("topic API: a node round runs work then remember, and only the finished round is forkable", async (t) => {
  const base = await fixture(t);
  const previousHome = process.env.CHAT_HOME;
  process.env.CHAT_HOME = base.home;
  const faux = registerFauxProvider({ api: "chat-node-chain-faux", provider: "chat-node-chain-faux" });
  t.after(() => {
    faux.unregister();
    if (previousHome === undefined) delete process.env.CHAT_HOME;
    else process.env.CHAT_HOME = previousHome;
  });
  // The daily fixture gives a real Long Agent environment; the model is replaced by a faux provider so the
  // node round can be scripted (work answer, then the writer's tool call and reply).
  const model = faux.getModel();
  fs.writeFileSync(path.join(base.home, "agent/settings.json"), JSON.stringify({
    defaultProvider: model.provider, defaultModel: model.id, defaultThinkingLevel: "off", compaction: { enabled: false } }));
  fs.writeFileSync(path.join(base.home, "agent/models.json"), JSON.stringify({ providers: { [model.provider]: {
    baseUrl: model.baseUrl, api: model.api, apiKey: "faux-key", models: [{ id: model.id, name: model.name,
      reasoning: model.reasoning, input: model.input, cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens }] } } }));

  const app = await router();
  const call = (path, init) => app.fetch(new Request(`http://chat.test${path}`, init));
  const topic = (await createTopic({ chatHome: base.home, longAgentId: "friend", title: "定位", purpose: "定位", requestId: "chain-topic", expectedRevision: 0 })).topic;
  const node = (await createTopicNodeWithSession({ chatHome: base.home, longAgentId: "friend", topicId: topic.topicId,
    requestId: "chain-topic", title: "根节点", createdBy: "agent" })).node;
  const { SESSION_MEMORY_WRITER_AGENT } = await import("../../src/workflows/session-memory/agents/writer/index.ts");
  const writerConfig = { [SESSION_MEMORY_WRITER_AGENT.id]: { tools: { mode: "explicit", names: [], exclude: [], addresses: ["system:tool/session_memory"] } } };
  faux.setResponses([
    fauxAssistantMessage("work：空指针在第 42 行"),
    fauxAssistantMessage(fauxToolCall("session_memory", { operation: "write", purpose: "finding", author: "agent", content: "空指针根因在第 42 行", expectedRevision: 0 })),
    (context) => {
      const toolResult = context.messages.filter((message) => message.role === "toolResult").map((message) => JSON.stringify(message)).join("\n");
      const entryId = /"entryId":"([^"]+)"/.exec(toolResult)?.[1] ?? "missing";
      return fauxAssistantMessage(`已写入 ${entryId}`);
    },
  ]);

  const accepted = await call(`/api/long-agents/friend/topics/${topic.topicId}/nodes/${node.nodeId}/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, requestId: "chain-turn-1", text: "为什么这里空指针？" }),
  });
  assert.equal(accepted.status, 202);
  const { readLongAgentState } = await import("../../src/long-agents/storage.ts");
  const { drainLongAgentTurns } = await import("../../src/long-agents/turn-queue.ts");
  await drainLongAgentTurns(base.home, "friend", node.sessionId);
  const turn = (await readLongAgentState(base.home)).turns.find((candidate) => candidate.turnId === "chat-web:friend:chain-turn-1");
  assert.equal(turn.status, "completed", "the round completed");
  assert.notEqual(turn.settledAt, undefined, "the turn settled after the whole outer chain");
  const memory = await readSessionMemory(base.home, "friend", node.sessionId);
  assert.equal(memory.entries.length, 1, "the writer wrote one entry inside the node round");
  const { ensureChatSessionWithId: ensure } = await import("../../src/chat-session.ts");
  const { readTopicSettledAnchors } = await import("../../src/long-agents/topic-anchor.ts");
  const manager = (await ensure({ chatHome: base.home, projectId: "friend" }, node.sessionId)).session.manager;
  const anchors = readTopicSettledAnchors(manager);
  assert.equal(anchors.length, 1, "exactly one settled round is forkable");
  void writerConfig;
});

test("topic API: work finished but remember unfinished is NOT a forkable round", async (t) => {
  const base = await fixture(t);
  const previousHome = process.env.CHAT_HOME;
  process.env.CHAT_HOME = base.home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.CHAT_HOME;
    else process.env.CHAT_HOME = previousHome;
  });
  const { ensureChatSessionWithId: ensure } = await import("../../src/chat-session.ts");
  const { appendChatUserMessage } = await import("../../src/workflows/session-conversation.ts");
  const { appendChatLongAgentTurn } = await import("../../src/long-agents/session-turn.ts");
  const { readTopicSettledAnchors, appendTopicRoundMarker } = await import("../../src/long-agents/topic-anchor.ts");
  const session = await ensure({ chatHome: base.home, projectId: "friend" }, "sess-half-round", "半轮");
  const anchor = appendChatUserMessage(session.session.manager, "为什么这里空指针？");
  session.session.manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "work：在第 42 行" }], timestamp: Date.now() });
  const agentGroupContext = { contextRevision: `sha256:${"a".repeat(64)}`, agentGroupId: "group", agentGroupRevision: `sha256:${"b".repeat(64)}`,
    indexRevision: `sha256:${"c".repeat(64)}`, definitionRevision: `sha256:${"d".repeat(64)}`, stale: false, fetchedAt: "2026-09-24T00:00:00.000Z" };
  // The queue opens the durable "round started" marker BEFORE any work runs, so the Session is in topic
  // mode from the first work entry and its Long Agent turn marker cannot settle the round by itself.
  appendTopicRoundMarker(session.session.manager, { roundId: "turn-half", userEntryId: "", status: "running" });
  // The work segment finished (the Long Agent turn marker says completed) while the writer has not run yet.
  appendChatLongAgentTurn(session.session.manager, { turnId: "turn-half", longAgentId: "friend", bindingId: "bind", source: "chat-web",
    channelType: null, inboundEventId: null, agentGroupContext, status: "completed",
    startedAt: "2026-09-24T00:00:00.000Z", completedAt: "2026-09-24T00:00:05.000Z", error: null });
  session.session.manager.flush();
  assert.equal(readTopicSettledAnchors(session.session.manager).length, 0,
    "a completed work turn is NOT a settled round while the outer chain has not finished");
  // The outer round marker (written after remember) is what makes the round forkable.
  appendTopicRoundMarker(session.session.manager, { roundId: "turn-half", userEntryId: anchor, status: "completed" });
  session.session.manager.flush();
  const settled = readTopicSettledAnchors(session.session.manager);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].anchorEntryId, anchor);
});

test("topic API: recovery opens the round marker BEFORE work, closing the accept-to-work window", async (t) => {
  const base = await fixture(t);
  const previousHome = process.env.CHAT_HOME;
  process.env.CHAT_HOME = base.home;
  const faux = registerFauxProvider({ api: "chat-node-recover-faux", provider: "chat-node-recover-faux" });
  t.after(() => {
    faux.unregister();
    if (previousHome === undefined) delete process.env.CHAT_HOME;
    else process.env.CHAT_HOME = previousHome;
  });
  const model = faux.getModel();
  fs.writeFileSync(path.join(base.home, "agent/settings.json"), JSON.stringify({
    defaultProvider: model.provider, defaultModel: model.id, defaultThinkingLevel: "off", compaction: { enabled: false } }));
  fs.writeFileSync(path.join(base.home, "agent/models.json"), JSON.stringify({ providers: { [model.provider]: {
    baseUrl: model.baseUrl, api: model.api, apiKey: "faux-key", models: [{ id: model.id, name: model.name,
      reasoning: model.reasoning, input: model.input, cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens }] } } }));

  const { openChatSession, ensureChatSessionWithId: ensure } = await import("../../src/chat-session.ts");
  const { acceptLongAgentTurn, drainLongAgentTurns } = await import("../../src/long-agents/turn-queue.ts");
  const { collectTopicRoundMarkers, readTopicSettledAnchors } = await import("../../src/long-agents/topic-anchor.ts");
  const topic = (await createTopic({ chatHome: base.home, longAgentId: "friend", title: "定位", purpose: "定位", requestId: "recover-topic", expectedRevision: 0 })).topic;
  const node = (await createTopicNodeWithSession({ chatHome: base.home, longAgentId: "friend", topicId: topic.topicId,
    requestId: "recover-topic", title: "根节点", createdBy: "agent" })).node;

  // The probe runs from INSIDE the work model call; the operation lock is held, so it opens the file read-only.
  let markersBeforeWork = null;
  faux.setResponses([
    async () => {
      const probe = await openChatSession({ chatHome: base.home, projectId: "friend", sessionId: node.sessionId });
      markersBeforeWork = collectTopicRoundMarkers(probe.manager.getBranch()).map((marker) => ({ roundId: marker.roundId, status: marker.status }));
      return fauxAssistantMessage("work：空指针在第 42 行");
    },
    fauxAssistantMessage(fauxToolCall("session_memory", { operation: "write", purpose: "finding", author: "agent", content: "空指针根因在第 42 行", expectedRevision: 0 })),
    (context) => {
      const toolResult = context.messages.filter((message) => message.role === "toolResult").map((message) => JSON.stringify(message)).join("\n");
      const entryId = /"entryId":"([^"]+)"/.exec(toolResult)?.[1] ?? "missing";
      return fauxAssistantMessage(`已写入 ${entryId}`);
    },
  ]);

  // Accepted, then "interrupted" BEFORE the worker ran: the turn is durable, nothing was executed.
  await acceptLongAgentTurn({ chatHome: base.home, longAgentId: "friend", requireInteractionRevision: false, projectId: "friend",
    turnId: "recover-turn-1", text: "为什么这里空指针？", source: "chat-web", topicNode: { topicId: topic.topicId, nodeId: node.nodeId } });
  const accepted = await openChatSession({ chatHome: base.home, projectId: "friend", sessionId: node.sessionId });
  assert.equal(collectTopicRoundMarkers(accepted.manager.getBranch()).length, 0, "acceptance alone writes no round marker");

  // Recovery drives the queued turn; the marker must already be durable when the work model runs.
  await drainLongAgentTurns(base.home, "friend", node.sessionId);
  assert.deepEqual(markersBeforeWork, [{ roundId: "chat-web:friend:recover-turn-1", status: "running" }],
    "the round is durably open before the work segment runs");
  const turn = (await readLongAgentState(base.home)).turns.find((candidate) => candidate.turnId === "chat-web:friend:recover-turn-1");
  assert.equal(turn.status, "completed", "the recovered round completes");
  const manager = (await ensure({ chatHome: base.home, projectId: "friend" }, node.sessionId)).session.manager;
  const recovered = readTopicSettledAnchors(manager);
  assert.equal(recovered.length, 1, "the recovered round settles exactly one anchor after work + remember");
  assert.equal(recovered[0].turnId, "chat-web:friend:recover-turn-1");
});

test("topic API: the running marker is serialized on the node session operation lock", async (t) => {
  const base = await fixture(t);
  const previousHome = process.env.CHAT_HOME;
  process.env.CHAT_HOME = base.home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.CHAT_HOME;
    else process.env.CHAT_HOME = previousHome;
  });
  const { openChatSession } = await import("../../src/chat-session.ts");
  const { chatSessionOperationKey, withChatSessionOperationLock } = await import("../../src/session-operation-lock.ts");
  const { markTopicRoundRunning } = await import("../../src/long-agents/turn-queue.ts");
  const { collectTopicRoundMarkers } = await import("../../src/long-agents/topic-anchor.ts");
  const topic = (await createTopic({ chatHome: base.home, longAgentId: "friend", title: "锁", purpose: "锁", requestId: "lock-topic", expectedRevision: 0 })).topic;
  const node = (await createTopicNodeWithSession({ chatHome: base.home, longAgentId: "friend", topicId: topic.topicId,
    requestId: "lock-topic", title: "根节点", createdBy: "agent" })).node;
  const seed = await openChatSession({ chatHome: base.home, projectId: "friend", sessionId: node.sessionId });
  appendChatUserMessage(seed.manager, "起点");
  seed.manager.flush();

  // A competing writer (e.g. relay) takes the Session operation lock and snapshots the branch BEFORE the
  // marker is written. The marker must wait for that writer and append AFTER it, rather than append from
  // the same parent and risk landing on an abandoned branch.
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  let holderOpened;
  const opened = new Promise((resolve) => { holderOpened = resolve; });
  let holderSession;
  const holder = withChatSessionOperationLock(chatSessionOperationKey("friend", node.sessionId), async () => {
    holderSession = await openChatSession({ chatHome: base.home, projectId: "friend", sessionId: node.sessionId });
    holderOpened();
    await gate;
    appendChatUserMessage(holderSession.manager, "并发写入");
    holderSession.manager.flush();
  });
  await opened;
  const pending = markTopicRoundRunning(base.home, "friend", { sessionId: node.sessionId, turnId: "chat-web:friend:turn-lock" });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const during = await openChatSession({ chatHome: base.home, projectId: "friend", sessionId: node.sessionId });
  assert.equal(collectTopicRoundMarkers(during.manager.getBranch()).length, 0, "the marker waits for the Session lock");
  releaseGate();
  await holder;
  await pending;
  const after = await openChatSession({ chatHome: base.home, projectId: "friend", sessionId: node.sessionId });
  const branch = after.manager.getBranch();
  const markers = collectTopicRoundMarkers(branch);
  assert.equal(markers.length, 1, "exactly one running marker was written");
  const markerPosition = branch.findIndex((entry) => entry.id === markers[0].entryId);
  const concurrentPosition = branch.findIndex((entry) => entry.type === "message" && JSON.stringify(entry.message?.content ?? "").includes("并发写入"));
  assert.notEqual(concurrentPosition, -1, "the competing write is on the branch");
  assert.ok(markerPosition > concurrentPosition, "the marker lands after the competing write on the SAME branch");
});
