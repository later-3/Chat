import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./daily-fixture.mjs";
import { createTopic, createTopicNode, readTopicGraph } from "../../src/long-agents/topics.ts";
import { ensureChatSessionWithId } from "../../src/chat-session.ts";
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

});
