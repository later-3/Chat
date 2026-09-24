import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./daily-fixture.mjs";
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
