import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureChatSessionWithId } from "../../src/chat-session.ts";
import { ensureAgentHomeProject } from "../../src/projects/registry.ts";
import {
  createTopic,
  createTopicNode,
  readTopicGraph,
  topicGraphFile,
  topicNodeSessionIdOf,
  topicRootSessionIdOf,
  topicIdOf,
} from "../../src/long-agents/topics.ts";

function fixture(t, agent = "friend") {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chat-topic-create-")));
  fs.mkdirSync(path.join(home, "long-agents", agent), { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

async function topicFixture(home, requestId = "r-topic", expectedRevision = 0) {
  return (await createTopic({ chatHome: home, longAgentId: "friend", title: "T", purpose: "P", requestId, expectedRevision })).topic;
}

test("P2 creation: a node session id is derived from (topicId, requestId), so retries recompute it", async (t) => {
  const home = fixture(t);
  const topic = await topicFixture(home);
  // The topic's root session is derived from its own request id: no mapping has to exist first.
  assert.equal(topic.rootSessionId, topicRootSessionIdOf("friend", "r-topic"));
  assert.equal(topic.topicId, topicIdOf("friend", "r-topic"));
  // Derivation is stable and per-request/per-topic distinct.
  assert.equal(topicNodeSessionIdOf(topic.topicId, "req-1"), topicNodeSessionIdOf(topic.topicId, "req-1"));
  assert.notEqual(topicNodeSessionIdOf(topic.topicId, "req-1"), topicNodeSessionIdOf(topic.topicId, "req-2"));
  assert.notEqual(topicNodeSessionIdOf(topic.topicId, "req-1"), topicNodeSessionIdOf("topic-" + "0".repeat(32), "req-1"));

  const root = await createTopicNode({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, title: "根节点", createdBy: "agent", requestId: "r-topic", expectedRevision: 1 });
  assert.equal(root.node.sessionId, topic.rootSessionId, "the root node's session IS the topic's root session");
  const child = await createTopicNode({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, title: "子节点", createdBy: "agent", requestId: "req-1", expectedRevision: 2, parents: [{ parentNodeId: root.node.nodeId }] });
  assert.equal(child.node.sessionId, topicNodeSessionIdOf(topic.topicId, "req-1"));

  // A retry of the whole creation (same request id) recomputes the same session and stays idempotent:
  // there is no "session created but the graph write failed" window that could leak a session.
  const retry = await createTopicNode({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, title: "子节点", createdBy: "agent", requestId: "req-1", expectedRevision: 2, parents: [{ parentNodeId: root.node.nodeId }] });
  assert.equal(retry.created, false);
  assert.equal(retry.node.sessionId, child.node.sessionId);
  assert.equal(retry.graph.revision, child.graph.revision, "a replay writes nothing");
  // A different request id can never reuse that session (it derives its own).
  const other = await createTopicNode({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, title: "另一节点", createdBy: "agent", requestId: "req-2", expectedRevision: child.graph.revision, parents: [{ parentNodeId: root.node.nodeId }] });
  assert.notEqual(other.node.sessionId, child.node.sessionId);
});

test("P2 creation: a Chat session can be created for a derived id and reopened idempotently", async (t) => {
  const home = fixture(t);
  await ensureAgentHomeProject("friend", "Friend", home);
  const sessionId = topicNodeSessionIdOf(topicIdOf("friend", "req-session"), "req-session");
  const first = await ensureChatSessionWithId({ chatHome: home, projectId: "friend" }, sessionId, "节点会话");
  assert.equal(first.created, true);
  assert.equal(first.session.manager.getSessionId(), sessionId);
  assert.equal(first.session.manager.isPersisted(), true);
  const second = await ensureChatSessionWithId({ chatHome: home, projectId: "friend" }, sessionId, "节点会话");
  assert.equal(second.created, false, "a retry reopens the same session instead of allocating a new one");
  assert.equal(second.session.manager.getSessionId(), sessionId);
  const files = fs.readdirSync(second.session.sessionDir).filter((name) => name.includes(sessionId));
  assert.equal(files.length, 1, "exactly one session file exists for the derived id");
});

test("P2 creation: a v1 graph written before these fields existed still loads", async (t) => {
  const home = fixture(t);
  const topic = await topicFixture(home);
  const root = await createTopicNode({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, title: "根节点", createdBy: "agent", requestId: "r-topic", expectedRevision: 1 });
  // Rewrite the file the way an intermediate revision would have: no digest on the node, plus the
  // withdrawn reservations array.
  const file = topicGraphFile(home, "friend");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const node of state.nodes) delete node.createdByRequestDigest;
  state.reservations = [];
  fs.writeFileSync(file, JSON.stringify(state));

  const loaded = await readTopicGraph(home, "friend");
  assert.equal(loaded.nodes.length, 1);
  assert.equal(loaded.nodes[0].createdByRequestDigest, null, "a pre-digest node is legacy, not a load failure");
  // A legacy node cannot be judged, so a retry fails closed instead of silently reusing it.
  await assert.rejects(
    createTopicNode({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, title: "根节点", createdBy: "agent", requestId: "r-topic", expectedRevision: loaded.revision }),
    /登记早于创建摘要/,
  );
  // Registering a NEW node still works on the migrated file.
  const child = await createTopicNode({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, title: "子节点", createdBy: "agent", requestId: "req-legacy", expectedRevision: loaded.revision, parents: [{ parentNodeId: root.node.nodeId }] });
  assert.equal(child.created, true);
  assert.equal(typeof child.node.createdByRequestDigest, "string");
});
