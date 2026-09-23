import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createTopic,
  createTopicNode,
  readTopicGraph,
  reserveTopicNodeSession,
  updateTopicNodeStatus,
  updateTopicStatus,
} from "../../src/long-agents/topics.ts";

function fixture(t, agent = "friend") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "chat-topic-create-"));
  fs.mkdirSync(path.join(home, "long-agents", agent), { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function allocator(prefix = "sess") {
  const calls = [];
  return {
    calls,
    allocate: async () => {
      const id = `${prefix}-${calls.length + 1}`;
      calls.push(id);
      return id;
    },
  };
}

async function topicFixture(home) {
  return (await createTopic({ chatHome: home, longAgentId: "friend", title: "T", purpose: "P", requestId: "r-topic", rootSessionId: "s-root", expectedRevision: 0 })).topic;
}

test("P2 creation: concurrent retries of one requestId reserve exactly one session", async (t) => {
  const home = fixture(t);
  const topic = await topicFixture(home);
  const { calls, allocate } = allocator();
  const [first, second] = await Promise.all([
    reserveTopicNodeSession({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, requestId: "req-1", allocateSessionId: allocate }),
    reserveTopicNodeSession({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, requestId: "req-1", allocateSessionId: allocate }),
  ]);
  assert.equal(calls.length, 1, "the allocator must run once for one request id");
  assert.equal(first.sessionId, second.sessionId);
  assert.equal([first.created, second.created].filter(Boolean).length, 1, "exactly one caller creates the reservation");
  const graph = await readTopicGraph(home, "friend");
  assert.equal(graph.reservations.length, 1);
  assert.equal(graph.reservations[0].sessionId, first.sessionId);

  // A retry after a crash (reservation written, node not yet registered) reuses the same session and
  // must not allocate a second one.
  const retry = await reserveTopicNodeSession({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, requestId: "req-1", allocateSessionId: allocate });
  assert.equal(retry.created, false);
  assert.equal(retry.sessionId, first.sessionId);
  assert.equal(calls.length, 1, "a retry never allocates another session");

  // A different request id is independent.
  const other = await reserveTopicNodeSession({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, requestId: "req-2", allocateSessionId: allocate });
  assert.equal(other.created, true);
  assert.notEqual(other.sessionId, first.sessionId);
  assert.equal((await readTopicGraph(home, "friend")).reservations.length, 2);
});

test("P2 creation: reservation is validated against the topic and consumed by node registration", async (t) => {
  const home = fixture(t);
  const topic = await topicFixture(home);
  const other = (await createTopic({ chatHome: home, longAgentId: "friend", title: "T2", purpose: "P2", requestId: "r-topic-2", rootSessionId: "s-root-2", expectedRevision: 1 })).topic;
  const { allocate } = allocator();

  await assert.rejects(
    reserveTopicNodeSession({ chatHome: home, longAgentId: "friend", topicId: "topic-00000000000000000000000000000000", requestId: "req-x", allocateSessionId: allocate }),
    /找不到主题/,
  );
  // The graph is per agent home, so another Long Agent has no such topic at all: a foreign owner is
  // refused before any session is allocated (the owner check is defence in depth for the same file).
  await assert.rejects(
    reserveTopicNodeSession({ chatHome: home, longAgentId: "another-agent", topicId: topic.topicId, requestId: "req-x", allocateSessionId: allocate }),
    /找不到主题/,
  );
  await assert.rejects(
    reserveTopicNodeSession({ chatHome: home, longAgentId: "another-agent", topicId: topic.topicId, requestId: "req-x", allocateSessionId: allocate }),
    /找不到主题/,
  );
  // A non-root node needs a parent, so register the topic root first.
  const root = await createTopicNode({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, sessionId: "s-root", title: "根节点", createdBy: "agent", requestId: "r-root", expectedRevision: 2 });
  const reserved = await reserveTopicNodeSession({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, requestId: "req-3", allocateSessionId: allocate });
  // The same request id cannot be re-pointed at another topic.
  await assert.rejects(
    reserveTopicNodeSession({ chatHome: home, longAgentId: "friend", topicId: other.topicId, requestId: "req-3", allocateSessionId: allocate }),
    /已预留给另一个主题/,
  );
  // Registering the node consumes the reservation in the same graph write.
  const node = await createTopicNode({
    chatHome: home, longAgentId: "friend", topicId: topic.topicId, sessionId: reserved.sessionId,
    title: "子节点", createdBy: "agent", requestId: "req-3", expectedRevision: (await readTopicGraph(home, "friend")).revision,
    parents: [{ parentNodeId: root.node.nodeId }],
  });
  assert.equal(node.created, true);
  assert.equal(node.graph.reservations.some((reservation) => reservation.requestId === "req-3"), false);
  assert.equal(node.graph.nodes.find((candidate) => candidate.nodeId === node.node.nodeId).createdByRequestId, "req-3");
  // A node can still be archived, and an archived TOPIC refuses new reservations while staying readable.
  assert.equal((await updateTopicNodeStatus({ chatHome: home, longAgentId: "friend", nodeId: node.node.nodeId, status: "archived", expectedRevision: (await readTopicGraph(home, "friend")).revision })).status, "archived");
  assert.equal((await updateTopicStatus({ chatHome: home, longAgentId: "friend", topicId: other.topicId, status: "archived", expectedRevision: (await readTopicGraph(home, "friend")).revision })).status, "archived");
  const { calls: calls2, allocate: allocate2 } = allocator();
  await assert.rejects(
    reserveTopicNodeSession({ chatHome: home, longAgentId: "friend", topicId: other.topicId, requestId: "req-4", allocateSessionId: allocate2 }),
    /主题已归档/,
  );
  assert.equal(calls2.length, 0, "no session is allocated for an archived topic");
  assert.equal((await readTopicGraph(home, "friend")).topics.find((candidate) => candidate.topicId === other.topicId).status, "archived");
});
