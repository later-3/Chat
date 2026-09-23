import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addTopicNodeParent,
  authorizeTopicSession,
  createTopic,
  createTopicNode,
  findTopicNodeBySession,
  markTopicNodeRemoved,
  readTopicGraph,
  topicNodeIdOf,
  updateTopicNodeStatus,
} from "../../src/long-agents/topics.ts";

function fixture(t, agent = "friend") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "chat-topics-"));
  fs.mkdirSync(path.join(home, "long-agents", agent), { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

const source = (sessionId, entryId) => ({ storageProjectId: "friend", sessionId, entryId });

test("P2 topics: topic creation is request-idempotent and revision-guarded", async (t) => {
  const home = fixture(t);
  const first = await createTopic({ chatHome: home, longAgentId: "friend", title: "定位问题", purpose: "定位线上 NPE", requestId: "topic-req-1", rootSessionId: "s-root", expectedRevision: 0 });
  assert.equal(first.created, true);
  assert.equal(first.topic.ownerLongAgentId, "friend");
  assert.equal(first.graph.revision, 1);
  // A retry with the same request id returns the same topic without a new revision.
  const retry = await createTopic({ chatHome: home, longAgentId: "friend", title: "不同标题", purpose: "不同", requestId: "topic-req-1", rootSessionId: "s-root", expectedRevision: 99 });
  assert.equal(retry.created, false);
  assert.equal(retry.topic.topicId, first.topic.topicId);
  assert.equal(retry.graph.revision, 1);
  // A stale revision is a conflict.
  await assert.rejects(
    createTopic({ chatHome: home, longAgentId: "friend", title: "第二个", purpose: "p", requestId: "topic-req-2", rootSessionId: "s-root", expectedRevision: 0 }),
    /revision/,
  );
});

test("P2 topics: nodes record anchors, provenance and multi-parent edges, and refuse cycles", async (t) => {
  const home = fixture(t);
  const topic = (await createTopic({ chatHome: home, longAgentId: "friend", title: "T", purpose: "P", requestId: "r-topic", rootSessionId: "s-root", expectedRevision: 0 })).topic;
  const root = await createTopicNode({
    chatHome: home, longAgentId: "friend", topicId: topic.topicId, sessionId: "s-root", title: "根节点",
    createdBy: "agent", frozenProjectContext: "a", requestId: "r-root", expectedRevision: 1,
    initialMemoryRefs: [{ entryId: "smem-1", source: source("s-src", "smem-1") }],
  });
  assert.equal(root.created, true);
  assert.deepEqual(root.node.initialMemoryRefs, [{ entryId: "smem-1", source: source("s-src", "smem-1") }]);
  const child = await createTopicNode({
    chatHome: home, longAgentId: "friend", topicId: topic.topicId, sessionId: "s-child", title: "子节点",
    createdBy: "user", requestId: "r-child", expectedRevision: 2,
    initialMemoryRefs: [{ entryId: "smem-2", source: source("s-root", "smem-1") }],
    parents: [{ parentNodeId: root.node.nodeId, anchorEntryId: "entry-20", anchorSequence: 20, memoryRefs: [source("s-root", "smem-1")] }],
  });
  assert.equal(child.graph.edges.length, 1);
  assert.deepEqual(child.graph.edges[0].memoryRefs, [source("s-root", "smem-1")]);
  assert.equal(child.graph.edges[0].anchorSequence, 20);
  // Multi-parent is legal.
  const other = await createTopicNode({
    chatHome: home, longAgentId: "friend", topicId: topic.topicId, sessionId: "s-other", title: "另一支",
    createdBy: "agent", requestId: "r-other", expectedRevision: 3,
  });
  const merge = await createTopicNode({
    chatHome: home, longAgentId: "friend", topicId: topic.topicId, sessionId: "s-merge", title: "合并",
    createdBy: "agent", requestId: "r-merge", expectedRevision: 4,
    parents: [{ parentNodeId: child.node.nodeId }, { parentNodeId: other.node.nodeId }],
  });
  assert.equal(merge.graph.edges.length, 3, "one edge from the child, two from the merge");
  // Supplementary integration is where a cycle is actually possible: adding merge → root would close
  // root → child → merge → root, so it must be refused.
  await assert.rejects(
    addTopicNodeParent({ chatHome: home, longAgentId: "friend", childNodeId: root.node.nodeId, parentNodeId: merge.node.nodeId, expectedRevision: 5 }),
    /形成环/,
  );
  // A legal supplementary edge on an existing node is accepted and idempotent on retry.
  const supplementary = await addTopicNodeParent({ chatHome: home, longAgentId: "friend", childNodeId: child.node.nodeId, parentNodeId: other.node.nodeId, anchorSequence: 3, expectedRevision: 5 });
  assert.equal(supplementary.created, true);
  assert.equal(supplementary.graph.edges.length, 4);
  assert.equal((await addTopicNodeParent({ chatHome: home, longAgentId: "friend", childNodeId: child.node.nodeId, parentNodeId: other.node.nodeId, expectedRevision: 99 })).created, false);
  await assert.rejects(
    createTopicNode({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, sessionId: "s-self", title: "自环", createdBy: "agent", requestId: "r-self", expectedRevision: supplementary.graph.revision, parents: [{ parentNodeId: topicNodeIdOf(topic.topicId, "s-self") }] }),
    /不能作为自己的父节点/,
  );
  // The same (topic, session) retried is the idempotent path, not an error.
  assert.equal(
    (await createTopicNode({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, sessionId: "s-root", title: "重复", createdBy: "agent", requestId: "r-dup", expectedRevision: supplementary.graph.revision })).created,
    false,
  );
  // A session may belong to only one node across topics.
  const secondTopic = (await createTopic({ chatHome: home, longAgentId: "friend", title: "T2", purpose: "P2", requestId: "r-topic-2", rootSessionId: "s-root-2", expectedRevision: supplementary.graph.revision })).topic;
  await assert.rejects(
    createTopicNode({ chatHome: home, longAgentId: "friend", topicId: secondTopic.topicId, sessionId: "s-root", title: "跨主题重复", createdBy: "agent", requestId: "r-dup-2", expectedRevision: supplementary.graph.revision + 1 }),
    /已属于某个主题节点/,
  );
});

test("P2 topics: removing a session marks the node removed and keeps its edges", async (t) => {
  const home = fixture(t);
  const topic = (await createTopic({ chatHome: home, longAgentId: "friend", title: "T", purpose: "P", requestId: "r1", rootSessionId: "s-root", expectedRevision: 0 })).topic;
  const root = await createTopicNode({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, sessionId: "s-root", title: "root", createdBy: "agent", requestId: "r2", expectedRevision: 1 });
  const child = await createTopicNode({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, sessionId: "s-child", title: "child", createdBy: "agent", requestId: "r3", expectedRevision: 2, parents: [{ parentNodeId: root.node.nodeId }] });
  const removed = await markTopicNodeRemoved({ chatHome: home, longAgentId: "friend", sessionId: "s-child" });
  assert.equal(removed.node.status, "removed");
  assert.equal(removed.graph.edges.length, 1, "the edge is kept for provenance");
  assert.equal(await markTopicNodeRemoved({ chatHome: home, longAgentId: "friend", sessionId: "s-unknown" }), null);
  // Archiving is a separate lifecycle state.
  assert.equal((await updateTopicNodeStatus({ chatHome: home, longAgentId: "friend", nodeId: root.node.nodeId, status: "archived" })).status, "archived");
  assert.equal(findTopicNodeBySession(await readTopicGraph(home, "friend"), child.node.sessionId)?.status, "removed");
});

test("P2 topics: the shared authorization decides read/relay/write for every entry", async (t) => {
  const home = fixture(t, "owner");
  const topic = (await createTopic({ chatHome: home, longAgentId: "owner", title: "T", purpose: "P", requestId: "r1", rootSessionId: "s-root", expectedRevision: 0 })).topic;
  const root = await createTopicNode({ chatHome: home, longAgentId: "owner", topicId: topic.topicId, sessionId: "s-root", title: "root", createdBy: "agent", requestId: "r2", expectedRevision: 1 });
  const child = await createTopicNode({ chatHome: home, longAgentId: "owner", topicId: topic.topicId, sessionId: "s-child", title: "child", createdBy: "agent", requestId: "r3", expectedRevision: 2, parents: [{ parentNodeId: root.node.nodeId }] });
  let graph = child.graph;
  const owner = { kind: "agent", longAgentId: "owner" };
  const stranger = { kind: "agent", longAgentId: "other" };

  // The local user keeps full rights; a removed node is read-only.
  assert.equal(authorizeTopicSession({ graph, requester: { kind: "user" }, sessionId: "s-child", capability: "write" }).allowed, true);
  // Another Long Agent may read across trees but must not relay or write.
  assert.equal(authorizeTopicSession({ graph, requester: stranger, sessionId: "s-child", capability: "read" }).allowed, true);
  assert.equal(authorizeTopicSession({ graph, requester: stranger, sessionId: "s-child", capability: "relay" }).allowed, false);
  assert.equal(authorizeTopicSession({ graph, requester: stranger, sessionId: "s-child", capability: "write" }).allowed, false);
  // The owning Long Agent may relay its own tree; write is scoped to its own agent home.
  assert.equal(authorizeTopicSession({ graph, requester: owner, sessionId: "s-child", capability: "relay" }).allowed, true);
  assert.equal(authorizeTopicSession({ graph, requester: owner, sessionId: "s-child", capability: "write" }).allowed, true);
  // A session that is not a topic node is not this subsystem's business.
  assert.equal(authorizeTopicSession({ graph, requester: owner, sessionId: "s-plain", capability: "write" }).applicable, false);

  graph = (await markTopicNodeRemoved({ chatHome: home, longAgentId: "owner", sessionId: "s-child" })).graph;
  assert.equal(authorizeTopicSession({ graph, requester: owner, sessionId: "s-child", capability: "read" }).allowed, true, "removed nodes stay readable");
  assert.equal(authorizeTopicSession({ graph, requester: owner, sessionId: "s-child", capability: "relay" }).allowed, false);
  assert.equal(authorizeTopicSession({ graph, requester: { kind: "user" }, sessionId: "s-child", capability: "write" }).allowed, false);
});
