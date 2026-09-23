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
    parents: [{ parentNodeId: root.node.nodeId }],
  });
  const merge = await createTopicNode({
    chatHome: home, longAgentId: "friend", topicId: topic.topicId, sessionId: "s-merge", title: "合并",
    createdBy: "agent", requestId: "r-merge", expectedRevision: 4,
    parents: [{ parentNodeId: child.node.nodeId }, { parentNodeId: other.node.nodeId }],
  });
  assert.equal(merge.graph.edges.length, 4, "one per child branch plus the two merge parents");
  // Supplementary integration is where a cycle is actually possible: adding merge → root would close
  // root → child → merge → root, so it must be refused.
  await assert.rejects(
    addTopicNodeParent({ chatHome: home, longAgentId: "friend", childNodeId: root.node.nodeId, parentNodeId: merge.node.nodeId, expectedRevision: 5 }),
    /形成环/,
  );
  // A legal supplementary edge on an existing node is accepted and idempotent on retry.
  const supplementary = await addTopicNodeParent({ chatHome: home, longAgentId: "friend", childNodeId: child.node.nodeId, parentNodeId: other.node.nodeId, anchorSequence: 3, expectedRevision: 5 });
  assert.equal(supplementary.created, true);
  assert.equal(supplementary.graph.edges.length, 5);
  assert.equal((await addTopicNodeParent({ chatHome: home, longAgentId: "friend", childNodeId: child.node.nodeId, parentNodeId: other.node.nodeId, expectedRevision: 99 })).created, false);
  await assert.rejects(
    createTopicNode({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, sessionId: "s-self", title: "自环", createdBy: "agent", requestId: "r-self", expectedRevision: supplementary.graph.revision, parents: [{ parentNodeId: topicNodeIdOf(topic.topicId, "s-self") }] }),
    /不能作为自己的父节点/,
  );
  // Replaying the identical creation of the root is the idempotent path, not an error.
  assert.equal(
    (await createTopicNode({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, sessionId: "s-root", title: "根节点", createdBy: "agent", requestId: "r-root", expectedRevision: supplementary.graph.revision, frozenProjectContext: "a", initialMemoryRefs: [{ entryId: "smem-1", source: source("s-src", "smem-1") }] })).created,
    false,
  );
  // Same session with a different creation request is a conflict, not a silent reuse.
  await assert.rejects(
    createTopicNode({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, sessionId: "s-root", title: "重复", createdBy: "agent", requestId: "r-dup", expectedRevision: supplementary.graph.revision }),
    /该 requestId 已用于不同的节点创建|创建请求不同/,
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
  assert.equal((await updateTopicNodeStatus({ chatHome: home, longAgentId: "friend", nodeId: root.node.nodeId, status: "archived", expectedRevision: removed.graph.revision })).status, "archived");
  // A removed node is terminal: a normal status update must not resurrect it.
  await assert.rejects(
    updateTopicNodeStatus({ chatHome: home, longAgentId: "friend", nodeId: child.node.nodeId, status: "active", expectedRevision: 7 }),
    /已移除，不能改回可用状态/,
  );
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

test("P2 topics: graph constraints the first round missed (review counter-examples)", async (t) => {
  const home = fixture(t);
  const a = (await createTopic({ chatHome: home, longAgentId: "friend", title: "A", purpose: "PA", requestId: "rA", rootSessionId: "s-a-root", expectedRevision: 0 })).topic;
  const b = (await createTopic({ chatHome: home, longAgentId: "friend", title: "B", purpose: "PB", requestId: "rB", rootSessionId: "s-b-root", expectedRevision: 1 })).topic;
  const rootA = await createTopicNode({ chatHome: home, longAgentId: "friend", topicId: a.topicId, sessionId: "s-a-root", title: "rootA", createdBy: "agent", requestId: "rA-root", expectedRevision: 2 });
  const nodeB = await createTopicNode({ chatHome: home, longAgentId: "friend", topicId: b.topicId, sessionId: "s-b-root", title: "rootB", createdBy: "agent", requestId: "rB-root", expectedRevision: 3 });

  // Gap 1: an edge must not connect two topic trees.
  await assert.rejects(
    addTopicNodeParent({ chatHome: home, longAgentId: "friend", childNodeId: nodeB.node.nodeId, parentNodeId: rootA.node.nodeId, expectedRevision: 4 }),
    /另一个主题，不能跨树建边/,
  );
  await assert.rejects(
    createTopicNode({ chatHome: home, longAgentId: "friend", topicId: b.topicId, sessionId: "s-b-cross", title: "cross", createdBy: "agent", requestId: "rB-cross", expectedRevision: 4, parents: [{ parentNodeId: rootA.node.nodeId }] }),
    /另一个主题，不能跨树建边/,
  );

  // Gap 3: the request id is the retry identity, so a retry with another session id conflicts.
  const retried = await createTopicNode({ chatHome: home, longAgentId: "friend", topicId: a.topicId, sessionId: "s-a-root", title: "rootA", createdBy: "agent", requestId: "rA-root", expectedRevision: 4, parents: [] });
  assert.equal(retried.created, false);
  assert.equal(retried.node.nodeId, rootA.node.nodeId);
  await assert.rejects(
    createTopicNode({ chatHome: home, longAgentId: "friend", topicId: a.topicId, sessionId: "s-a-other", title: "rootA", createdBy: "agent", requestId: "rA-root", expectedRevision: 4, parents: [] }),
    /该 requestId 已用于不同的节点创建/,
  );
  await assert.rejects(
    createTopicNode({ chatHome: home, longAgentId: "friend", topicId: a.topicId, sessionId: "s-a-root", title: "改标题", createdBy: "agent", requestId: "rA-root", expectedRevision: 4, parents: [] }),
    /该 requestId 已用于不同的节点创建/,
  );

  // Gap 4: a topic has exactly one root, and the root session belongs to exactly one topic.
  await assert.rejects(
    createTopic({ chatHome: home, longAgentId: "friend", title: "C", purpose: "PC", requestId: "rC", rootSessionId: "s-a-root", expectedRevision: 4 }),
    /该根会话已属于另一个主题/,
  );
  await assert.rejects(
    createTopicNode({ chatHome: home, longAgentId: "friend", topicId: a.topicId, sessionId: "s-a-stray", title: "无父节点", createdBy: "agent", requestId: "rA-stray", expectedRevision: 4, parents: [] }),
    /无父节点只能是主题根会话/,
  );
  const childA = await createTopicNode({ chatHome: home, longAgentId: "friend", topicId: a.topicId, sessionId: "s-a-child", title: "childA", createdBy: "agent", requestId: "rA-child", expectedRevision: 4, parents: [{ parentNodeId: rootA.node.nodeId }] });
  await assert.rejects(
    createTopicNode({ chatHome: home, longAgentId: "friend", topicId: a.topicId, sessionId: "s-a-root2", title: "第二个根", createdBy: "agent", requestId: "rA-root2", expectedRevision: childA.graph.revision, parents: [] }),
    /无父节点只能是主题根会话/,
  );

  // Gap 3b: the creation digest is immutable, so a retry after a legitimate supplementary edge and a
  // changed anchor are judged correctly (the edges of the graph are mutable, the request is not).
  const before = await readTopicGraph(home, "friend");
  const replayed = await createTopicNode({ chatHome: home, longAgentId: "friend", topicId: a.topicId, sessionId: "s-a-child", title: "childA", createdBy: "agent", requestId: "rA-child", expectedRevision: before.revision, parents: [{ parentNodeId: rootA.node.nodeId }] });
  assert.equal(replayed.created, false, "the original request still replays after supplementary integration");
  assert.equal(replayed.graph.revision, before.revision, "a replay writes nothing");
  const anchored = await createTopicNode({ chatHome: home, longAgentId: "friend", topicId: a.topicId, sessionId: "s-a-anchor", title: "锚点变了", createdBy: "agent", requestId: "rA-anchor", expectedRevision: before.revision, parents: [{ parentNodeId: rootA.node.nodeId, anchorEntryId: "entry-old", anchorSequence: 1 }] });
  assert.equal(anchored.created, true);
  assert.equal(anchored.graph.edges.find((edge) => edge.childNodeId === anchored.node.nodeId).anchorEntryId, "entry-old");
  await assert.rejects(
    createTopicNode({ chatHome: home, longAgentId: "friend", topicId: a.topicId, sessionId: "s-a-anchor", title: "锚点变了", createdBy: "agent", requestId: "rA-anchor", expectedRevision: anchored.graph.revision, parents: [{ parentNodeId: rootA.node.nodeId, anchorEntryId: "entry-new", anchorSequence: 9 }] }),
    /该 requestId 已用于不同的节点创建|创建请求不同/,
  );

  // Gap 2: archived nodes refuse relay for the owner and the user, and stay readable.
  const archived = await updateTopicNodeStatus({ chatHome: home, longAgentId: "friend", nodeId: childA.node.nodeId, status: "archived", expectedRevision: (await readTopicGraph(home, "friend")).revision });
  assert.equal(archived.status, "archived");
  const graph = await readTopicGraph(home, "friend");
  const owner = { kind: "agent", longAgentId: "friend" };
  assert.equal(authorizeTopicSession({ graph, requester: owner, sessionId: "s-a-child", capability: "relay" }).allowed, false);
  assert.equal(authorizeTopicSession({ graph, requester: { kind: "user" }, sessionId: "s-a-child", capability: "relay" }).allowed, false);
  assert.equal(authorizeTopicSession({ graph, requester: owner, sessionId: "s-a-child", capability: "read" }).allowed, true);
  // An archived node refuses integration in both directions (taskbook 3#9). Both probes stay inside
  // topic A so the cross-tree rule cannot mask the archival rule.
  const leafA = await createTopicNode({ chatHome: home, longAgentId: "friend", topicId: a.topicId, sessionId: "s-a-leaf", title: "leafA", createdBy: "agent", requestId: "rA-leaf", expectedRevision: graph.revision, parents: [{ parentNodeId: rootA.node.nodeId }] });
  await assert.rejects(
    addTopicNodeParent({ chatHome: home, longAgentId: "friend", childNodeId: leafA.node.nodeId, parentNodeId: childA.node.nodeId, expectedRevision: leafA.graph.revision }),
    /父节点已归档或移除/,
  );
  await assert.rejects(
    addTopicNodeParent({ chatHome: home, longAgentId: "friend", childNodeId: childA.node.nodeId, parentNodeId: leafA.node.nodeId, expectedRevision: leafA.graph.revision }),
    /节点已归档或移除，不能接受新的整合/,
  );
  // The owner can archive back, but only with a fresh revision.
  await assert.rejects(
    updateTopicNodeStatus({ chatHome: home, longAgentId: "friend", nodeId: childA.node.nodeId, status: "active", expectedRevision: 0 }),
    /revision/,
  );
  assert.equal((await updateTopicNodeStatus({ chatHome: home, longAgentId: "friend", nodeId: childA.node.nodeId, status: "active", expectedRevision: (await readTopicGraph(home, "friend")).revision })).status, "active");
});
