import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureChatSessionWithId, openChatSession } from "../../src/chat-session.ts";
import { appendChatUserMessage } from "../../src/workflows/session-conversation.ts";
import { appendChatLongAgentTurn } from "../../src/long-agents/session-turn.ts";
import { readSessionMemory, writeSessionMemoryEntry } from "../../src/long-agents/session-memory.ts";
import { ensureAgentHomeProject, openProject } from "../../src/projects/registry.ts";
import { purgeRemovedChatSession, removeChatSession, restoreRemovedChatSession } from "../../src/session-removal.ts";
import {
  addTopicNodeParent,
  createTopic,
  createTopicNode,
  readTopicGraph,
  topicGraphFile,
  topicNodeSessionIdOf,
  topicRootSessionIdOf,
  topicIdOf,
  updateTopicNodeStatus,
  createTopicNodeWithSession,
  TOPIC_INTEGRATION_SUMMARY_CUSTOM_TYPE,
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

  // Concurrent calls for one id must serialize: Pi names the file `<timestamp>_<id>.jsonl`, so two
  // creations would leave two session files behind.
  const concurrentId = topicNodeSessionIdOf(topicIdOf("friend", "req-concurrent"), "req-concurrent");
  const results = await Promise.all(Array.from({ length: 12 }, () => ensureChatSessionWithId({ chatHome: home, projectId: "friend" }, concurrentId)));
  assert.equal(results.filter((result) => result.created).length, 1, "exactly one concurrent caller creates the session");
  assert.equal(new Set(results.map((result) => result.session.manager.getSessionId())).size, 1);
  const concurrentFiles = fs.readdirSync(second.session.sessionDir).filter((name) => name.includes(concurrentId));
  assert.equal(concurrentFiles.length, 1, "one session file for one id, even under concurrency");
});

test("P2 creation: a removed or purged session is never re-created by id", async (t) => {
  const home = fixture(t);
  await ensureAgentHomeProject("friend", "Friend", home);
  const sessionId = topicNodeSessionIdOf(topicIdOf("friend", "req-removed"), "req-removed");
  const created = await ensureChatSessionWithId({ chatHome: home, projectId: "friend" }, sessionId, "节点会话");
  const sessionDir = created.session.sessionDir;

  await removeChatSession("friend", sessionId, home);
  assert.equal(fs.readdirSync(sessionDir).filter((name) => name.includes(sessionId)).length, 0, "the file moved out of the active directory");
  await assert.rejects(
    ensureChatSessionWithId({ chatHome: home, projectId: "friend" }, sessionId),
    (error) => error.code === "SESSION_REMOVED",
    "re-creating a removed id would bypass the topic node removed state",
  );
  assert.equal(fs.readdirSync(sessionDir).filter((name) => name.includes(sessionId)).length, 0, "no session was re-created");

  // The existing restore path still brings it back, and then it is simply reopened.
  await restoreRemovedChatSession("friend", sessionId, home);
  const reopened = await ensureChatSessionWithId({ chatHome: home, projectId: "friend" }, sessionId);
  assert.equal(reopened.created, false);
  assert.equal(reopened.session.manager.getSessionId(), sessionId);

  // Purge is terminal for creation too.
  await removeChatSession("friend", sessionId, home);
  await purgeRemovedChatSession("friend", sessionId, home);
  await assert.rejects(
    ensureChatSessionWithId({ chatHome: home, projectId: "friend" }, sessionId),
    (error) => error.code === "SESSION_PURGED",
  );
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

test("P2 creation: the four-step orchestration is replayable after an interruption", async (t) => {
  const home = fixture(t);
  await ensureAgentHomeProject("friend", "Friend", home);
  const topic = (await createTopic({ chatHome: home, longAgentId: "friend", title: "T", purpose: "P", requestId: "rq", expectedRevision: 0 })).topic;
  // The parent is rooted in its own settled round, so the child has a real anchor.
  const parentSession = await ensureChatSessionWithId({ chatHome: home, projectId: "friend" }, topic.rootSessionId, "根");
  const parentAnchor = appendChatUserMessage(parentSession.session.manager, "第一个问题");
  parentSession.session.manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "回答" }], timestamp: Date.now() });
  appendChatLongAgentTurn(parentSession.session.manager, {
    turnId: "turn-1", longAgentId: "friend", bindingId: "bind-1", source: "chat-web", channelType: null,
    inboundEventId: null, status: "completed", startedAt: "2026-09-24T00:00:00.000Z", completedAt: "2026-09-24T00:00:05.000Z", error: null,
    agentGroupContext: { contextRevision: `sha256:${"a".repeat(64)}`, agentGroupId: "group", agentGroupRevision: `sha256:${"b".repeat(64)}`,
      indexRevision: `sha256:${"c".repeat(64)}`, definitionRevision: `sha256:${"d".repeat(64)}`, stale: false, fetchedAt: "2026-09-24T00:00:00.000Z" },
  });
  parentSession.session.manager.flush();
  const root = await createTopicNode({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, title: "根节点", createdBy: "agent", requestId: "rq", expectedRevision: 1 });
  // A source addresses a SESSION MEMORY entry (smem-*), not a Pi transcript entry.
  const parentMemory = await writeSessionMemoryEntry({ chatHome: home, longAgentId: "friend", sessionId: topic.rootSessionId,
    operation: "write", purpose: "finding", author: "agent", content: "父会话结论：第一个问题已定位", expectedRevision: 0 });
  const source = { storageProjectId: "friend", sessionId: topic.rootSessionId, entryId: parentMemory.entries.at(-1).entryId };
  const request = {
    chatHome: home, longAgentId: "friend", topicId: topic.topicId, requestId: "rq-child", title: "子节点",
    createdBy: "agent", integrationSummary: "整合摘要：第一个问题已经定位", source,
    initialMemory: { content: "背景：第一个问题已定位", originEntryId: null },
    parents: [{ parentNodeId: root.node.nodeId, anchorEntryId: parentAnchor, anchorSequence: 1, memoryRefs: [source] }],
  };
  const first = await createTopicNodeWithSession(request);
  assert.equal(first.created, true);
  assert.equal(first.sessionId, topicNodeSessionIdOf(topic.topicId, "rq-child"));
  assert.equal(first.node.initialMemoryRefs.length, 1);
  assert.equal(first.node.initialMemoryRefs[0].source.entryId, source.entryId);
  assert.equal(first.summaryEntryId !== null, true);
  assert.equal(first.memoryEntryId, first.node.initialMemoryRefs[0].entryId, "the recorded ref IS the bootstrap entry");
  assert.equal(first.graph.edges.find((edge) => edge.childNodeId === first.node.nodeId).anchorSequence, 1);

  // Replaying the identical request changes nothing: no second node, no second summary, no second
  // memory entry, same session.
  const replay = await createTopicNodeWithSession(request);
  assert.equal(replay.created, false);
  assert.equal(replay.sessionId, first.sessionId);
  assert.equal(replay.node.nodeId, first.node.nodeId);
  const childSession = await openChatSession({ chatHome: home, projectId: "friend", sessionId: first.sessionId });
  const summaries = childSession.manager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === TOPIC_INTEGRATION_SUMMARY_CUSTOM_TYPE);
  assert.equal(summaries.length, 1, "one integration summary after a replay");
  const childMemory = await readSessionMemory(home, "friend", first.sessionId);
  assert.equal(childMemory.entries.filter((entry) => entry.purpose === "background").length, 1, "one bootstrap memory entry after a replay");

  // A different request for the same parent anchor is a separate child.
  const other = await createTopicNodeWithSession({ ...request, requestId: "rq-child-2", title: "另一个子节点" });
  assert.equal(other.created, true);
  assert.notEqual(other.sessionId, first.sessionId);

  // Interruption at the LAST step: the session, summary and memory are durable, the graph registration
  // is not (simulated by dropping the node from the graph file, keeping topic and revision).
  const interrupted = { ...request, requestId: "rq-child-4", title: "中断重试" };
  const interruptedSessionId = topicNodeSessionIdOf(topic.topicId, "rq-child-4");
  const firstInterrupted = await createTopicNodeWithSession(interrupted);
  assert.equal(firstInterrupted.created, true);
  const graphPath = topicGraphFile(home, "friend");
  const droppedState = JSON.parse(fs.readFileSync(graphPath, "utf8"));
  droppedState.nodes = droppedState.nodes.filter((node) => node.createdByRequestId !== "rq-child-4");
  droppedState.edges = droppedState.edges.filter((edge) => !firstInterrupted.graph.edges.some((candidate) => candidate.edgeId === edge.edgeId));
  fs.writeFileSync(graphPath, JSON.stringify(droppedState));
  const resumed = await createTopicNodeWithSession(interrupted);
  assert.equal(resumed.created, true, "the node itself was still missing, so it is registered now");
  assert.equal(resumed.sessionId, interruptedSessionId, "the retry reuses the same derived session");
  assert.equal(resumed.summaryEntryId, firstInterrupted.summaryEntryId, "the existing summary is adopted");
  assert.equal(resumed.memoryEntryId, firstInterrupted.memoryEntryId, "the existing bootstrap memory entry is adopted");
  assert.equal(resumed.node.initialMemoryRefs[0].entryId, firstInterrupted.memoryEntryId);
  const resumedSession = await openChatSession({ chatHome: home, projectId: "friend", sessionId: interruptedSessionId });
  assert.equal(resumedSession.manager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === TOPIC_INTEGRATION_SUMMARY_CUSTOM_TYPE).length, 1);
  assert.equal((await readSessionMemory(home, "friend", interruptedSessionId)).entries.length, 1, "no duplicate bootstrap entry");

  // With the node still missing, a changed summary/memory for the SAME request id is a conflict rather
  // than a second durable product (this is the branch the registered-node digest cannot cover).
  fs.writeFileSync(graphPath, JSON.stringify(droppedState));
  await assert.rejects(createTopicNodeWithSession({ ...interrupted, integrationSummary: "换了摘要" }), /已写入不同的整合摘要/);
  fs.writeFileSync(graphPath, JSON.stringify(droppedState));
  await assert.rejects(createTopicNodeWithSession({ ...interrupted, initialMemory: { content: "换了记忆", originEntryId: parentAnchor } }), /已写入不同的整合摘要|已写入不同的初始记忆/);

  // An anchor that is not a settled round is refused before anything is written.
  const running = appendChatUserMessage(parentSession.session.manager, "还在进行的问题");
  parentSession.session.manager.flush();
  await assert.rejects(
    createTopicNodeWithSession({ ...request, requestId: "rq-child-3", parents: [{ parentNodeId: root.node.nodeId, anchorEntryId: running, anchorSequence: 1 }] }),
    /锚点不是已完成的轮次/,
  );
  const afterFailure = await readTopicGraph(home, "friend");
  assert.equal(afterFailure.nodes.some((node) => node.createdByRequestId === "rq-child-3"), false, "a rejected anchor leaves no node");
});

test("P2 creation: review counter-examples for the orchestration contract", async (t) => {
  const home = fixture(t);
  await ensureAgentHomeProject("friend", "Friend", home);
  const topic = (await createTopic({ chatHome: home, longAgentId: "friend", title: "T", purpose: "P", requestId: "rq", expectedRevision: 0 })).topic;
  const root = await createTopicNode({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, title: "根节点", createdBy: "agent", requestId: "rq", expectedRevision: 1 });
  const rootSession = await ensureChatSessionWithId({ chatHome: home, projectId: "friend" }, topic.rootSessionId, "根");
  const anchor = appendChatUserMessage(rootSession.session.manager, "第一个问题");
  rootSession.session.manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "回答" }], timestamp: Date.now() });
  appendChatLongAgentTurn(rootSession.session.manager, {
    turnId: "turn-1", longAgentId: "friend", bindingId: "bind-1", source: "chat-web", channelType: null,
    inboundEntryId: null, inboundEventId: null, status: "completed", startedAt: "2026-09-24T00:00:00.000Z",
    completedAt: "2026-09-24T00:00:05.000Z", error: null,
    agentGroupContext: { contextRevision: `sha256:${"a".repeat(64)}`, agentGroupId: "group", agentGroupRevision: `sha256:${"b".repeat(64)}`,
      indexRevision: `sha256:${"c".repeat(64)}`, definitionRevision: `sha256:${"d".repeat(64)}`, stale: false, fetchedAt: "2026-09-24T00:00:00.000Z" },
  });
  rootSession.session.manager.flush();
  const sourceMemory = await writeSessionMemoryEntry({ chatHome: home, longAgentId: "friend", sessionId: topic.rootSessionId,
    operation: "write", purpose: "finding", author: "agent", content: "结论 A", expectedRevision: 0 });
  const source = { storageProjectId: "friend", sessionId: topic.rootSessionId, entryId: sourceMemory.entries.at(-1).entryId };
  const base = {
    chatHome: home, longAgentId: "friend", topicId: topic.topicId, requestId: "rq-fix", title: "Root",
    createdBy: "agent", integrationSummary: "摘要 A", source,
    initialMemory: { content: "背景 A", originEntryId: null },
    parents: [{ parentNodeId: root.node.nodeId, anchorEntryId: anchor, anchorSequence: 1, memoryRefs: [source] }],
  };
  assert.equal((await createTopicNodeWithSession(base)).created, true);

  // 1: a registered node is NOT returned for a changed request — the full creation identity is checked.
  // The creation digest covers title, anchors AND the orchestration fingerprint (summary text +
  // bootstrap memory), so all three changes are conflicts instead of silent successes.
  await assert.rejects(createTopicNodeWithSession({ ...base, title: "Changed title" }), /该 requestId 已用于不同的节点创建/);
  await assert.rejects(createTopicNodeWithSession({ ...base, integrationSummary: "摘要 B" }), /该 requestId 已用于不同的节点创建/);
  await assert.rejects(createTopicNodeWithSession({ ...base, initialMemory: { content: "背景 B", originEntryId: null } }), /该 requestId 已用于不同的节点创建/);
  const afterRejections = await readTopicGraph(home, "friend");
  assert.equal(afterRejections.nodes.find((node) => node.createdByRequestId === "rq-fix").title, "Root", "the frozen title is untouched");
  // The identical request still replays idempotently.
  assert.equal((await createTopicNodeWithSession(base)).created, false);

  // 4: a specific anchor must carry both the entry and its sequence.
  await assert.rejects(
    createTopicNodeWithSession({ ...base, requestId: "rq-anchor-null", parents: [{ parentNodeId: root.node.nodeId, anchorEntryId: anchor, anchorSequence: null }] }),
    /锚点必须同时提供 entry 与序号/,
  );

  // 2: an unrelated pre-existing background entry is NOT claimed by a new request.
  const otherRequest = { ...base, requestId: "rq-other", title: "另一个" };
  const childSessionId = topicNodeSessionIdOf(topic.topicId, "rq-other");
  const preexisting = await ensureChatSessionWithId({ chatHome: home, projectId: "friend" }, childSessionId, "另一个");
  preexisting.session.manager.flush();
  const emptyMemory = await readSessionMemory(home, "friend", childSessionId);
  await writeSessionMemoryEntry({ chatHome: home, longAgentId: "friend", sessionId: childSessionId, operation: "write",
    purpose: "background", author: "agent", content: "背景 A", expectedRevision: emptyMemory.revision });
  const createdOther = await createTopicNodeWithSession(otherRequest);
  const adopted = (await readSessionMemory(home, "friend", childSessionId)).entries;
  assert.equal(adopted.length, 2, "the unrelated entry is NOT claimed: this request writes its own");
  assert.equal(createdOther.memoryEntryId, adopted.at(-1).entryId);
  assert.notEqual(createdOther.memoryEntryId, adopted[0].entryId);
  assert.equal(adopted.at(-1).writeRequestId, "rq-other", "the retry link is the durable request marker");

  // 3: a source address that does not exist is refused before any write.
  await assert.rejects(
    createTopicNodeWithSession({ ...base, requestId: "rq-bad-source", source: { ...source, entryId: "smem-9999-unrelated" } }),
    /来源会话记忆条目不存在/,
  );
  await assert.rejects(
    createTopicNodeWithSession({ ...base, requestId: "rq-bad-session", source: { ...source, sessionId: "does-not-exist" } }),
    /来源会话记忆不存在或不可读/,
  );
  // A Pi transcript id is NOT a memory address: the namespaces are distinct.
  await assert.rejects(
    createTopicNodeWithSession({ ...base, requestId: "rq-pi-entry", source: { ...source, entryId: anchor } }),
    /来源会话记忆条目不存在/,
  );
  // A plain Project session is not a valid source: `applicable:false` is not an allow.
  const privateProjectDir = path.join(home, "private-project");
  fs.mkdirSync(privateProjectDir, { recursive: true });
  await openProject({ path: privateProjectDir, chatHome: home, id: "private-project", name: "private" });
  const privateSession = await ensureChatSessionWithId({ chatHome: home, projectId: "private-project" }, "sess-private-1", "private");
  privateSession.session.manager.flush();
  await assert.rejects(
    createTopicNodeWithSession({ ...base, requestId: "rq-private", source: { storageProjectId: "private-project", sessionId: "sess-private-1", entryId: anchor } }),
    /来源必须是 Long Agent 归属的会话记忆/,
  );
  const afterBadSource = await readTopicGraph(home, "friend");
  assert.equal(afterBadSource.nodes.some((node) => node.createdByRequestId === "rq-bad-source"), false);

  // 3b: once the node exists, an identical replay returns it even after the SOURCE session was removed:
  // the availability check belongs to the first registration only.
  const removableSource = await writeSessionMemoryEntry({ chatHome: home, longAgentId: "friend", sessionId: topic.rootSessionId,
    operation: "write", purpose: "finding", author: "agent", content: "将被移除的来源", expectedRevision: (await readSessionMemory(home, "friend", topic.rootSessionId)).revision });
  const beforeRemoval = { ...base, requestId: "rq-removed-source", title: "来源稍后移除",
    source: { storageProjectId: "friend", sessionId: topic.rootSessionId, entryId: removableSource.entries.at(-1).entryId } };
  assert.equal((await createTopicNodeWithSession(beforeRemoval)).created, true);
  await removeChatSession("friend", topic.rootSessionId, home);
  const replayAfterRemoval = await createTopicNodeWithSession(beforeRemoval);
  assert.equal(replayAfterRemoval.created, false, "the registered request is identified before source availability");
  assert.equal(replayAfterRemoval.node.title, "来源稍后移除");
  // A NEW request with the removed source is still refused.
  await assert.rejects(
    createTopicNodeWithSession({ ...beforeRemoval, requestId: "rq-removed-source-2" }),
    /来源会话已移除/,
  );

});

test("P2 creation: every recorded source is validated at the graph write entry", async (t) => {
  const home = fixture(t);
  await ensureAgentHomeProject("friend", "Friend", home);
  const topic = (await createTopic({ chatHome: home, longAgentId: "friend", title: "T", purpose: "P", requestId: "rs-topic", expectedRevision: 0 })).topic;
  const root = await createTopicNode({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, title: "根节点", createdBy: "agent", requestId: "rs-topic", expectedRevision: 1 });
  const sourceSession = await ensureChatSessionWithId({ chatHome: home, projectId: "friend" }, topic.rootSessionId, "根");
  const sourceMemory = await writeSessionMemoryEntry({ chatHome: home, longAgentId: "friend", sessionId: topic.rootSessionId,
    operation: "write", purpose: "finding", author: "agent", content: "真实来源", expectedRevision: 0 });
  const realSource = { storageProjectId: "friend", sessionId: topic.rootSessionId, entryId: sourceMemory.entries.at(-1).entryId };
  const bogusSource = { storageProjectId: "friend", sessionId: "missing-session", entryId: "smem-9999-missing" };

  // A parent edge's memoryRefs is validated: a fake reference never reaches the graph.
  await assert.rejects(
    createTopicNode({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, title: "假引用", createdBy: "agent", requestId: "rs-bad-edge",
      expectedRevision: 2, parents: [{ parentNodeId: root.node.nodeId, memoryRefs: [bogusSource] }] }),
    /来源会话记忆不存在或不可读/,
  );
  const afterBadEdge = await readTopicGraph(home, "friend");
  assert.equal(afterBadEdge.edges.some((edge) => edge.memoryRefs.some((ref) => ref.sessionId === "missing-session")), false);
  assert.equal(afterBadEdge.nodes.some((node) => node.createdByRequestId === "rs-bad-edge"), false);

  // The bootstrap ref's source is validated too.
  await assert.rejects(
    createTopicNode({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, title: "假初始来源", createdBy: "agent", requestId: "rs-bad-initial",
      expectedRevision: 2, initialMemoryRefs: [{ entryId: "smem-0001-x", source: bogusSource }],
      parents: [{ parentNodeId: root.node.nodeId }] }),
    /来源会话记忆不存在或不可读/,
  );

  // Supplementary integration validates its memoryRefs as well.
  const child = await createTopicNode({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, title: "子节点", createdBy: "agent", requestId: "rs-child",
    expectedRevision: 2, parents: [{ parentNodeId: root.node.nodeId, memoryRefs: [realSource] }] });
  assert.equal(child.graph.edges[0].memoryRefs.length, 1);
  const third = await createTopicNode({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, title: "第三个", createdBy: "agent", requestId: "rs-third",
    expectedRevision: child.graph.revision, parents: [{ parentNodeId: root.node.nodeId }] });
  // A supplementary edge validates its own memoryRefs (the existing-edge early return is skipped here
  // because these two nodes are not connected yet).
  await assert.rejects(
    addTopicNodeParent({ chatHome: home, longAgentId: "friend", childNodeId: child.node.nodeId, parentNodeId: third.node.nodeId, memoryRefs: [bogusSource], expectedRevision: third.graph.revision }),
    /来源会话记忆不存在或不可读/,
  );
  assert.equal(
    (await addTopicNodeParent({ chatHome: home, longAgentId: "friend", childNodeId: child.node.nodeId, parentNodeId: third.node.nodeId, memoryRefs: [realSource], expectedRevision: third.graph.revision })).created,
    true,
  );
  // An archived source node cannot feed new integration, but an already registered replay is unaffected.
  const archivedNode = await createTopicNode({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, title: "将归档", createdBy: "agent", requestId: "rs-archived",
    expectedRevision: (await readTopicGraph(home, "friend")).revision, parents: [{ parentNodeId: root.node.nodeId, memoryRefs: [realSource] }] });
  await ensureChatSessionWithId({ chatHome: home, projectId: "friend" }, archivedNode.node.sessionId, "将归档");
  const archivedMemory = await writeSessionMemoryEntry({ chatHome: home, longAgentId: "friend", sessionId: archivedNode.node.sessionId,
    operation: "write", purpose: "finding", author: "agent", content: "归档前的结论", expectedRevision: 0 });
  const archivedSource = { storageProjectId: "friend", sessionId: archivedNode.node.sessionId, entryId: archivedMemory.entries.at(-1).entryId };
  const usableRequest = {
    chatHome: home, longAgentId: "friend", topicId: topic.topicId, requestId: "rs-use-archived", title: "用到归档来源",
    createdBy: "agent", source: archivedSource, initialMemory: { content: "背景", originEntryId: null },
    parents: [{ parentNodeId: root.node.nodeId, memoryRefs: [archivedSource] }],
  };
  const usable = await createTopicNodeWithSession(usableRequest);
  assert.equal(usable.created, true);
  await updateTopicNodeStatus({ chatHome: home, longAgentId: "friend", nodeId: archivedNode.node.nodeId, status: "archived", expectedRevision: (await readTopicGraph(home, "friend")).revision });
  // An archived source node cannot feed NEW integration ...
  await assert.rejects(
    createTopicNodeWithSession({ ...usableRequest, requestId: "rs-new-from-archived" }),
    /来源主题节点已归档或移除/,
  );
  // ... but the already registered request still replays without re-checking its source.
  assert.equal((await createTopicNodeWithSession(usableRequest)).created, false);
});

test("P2 creation: a supplementary edge needs its own settled anchor and an exact spec", async (t) => {
  const home = fixture(t);
  await ensureAgentHomeProject("friend", "Friend", home);
  const topic = (await createTopic({ chatHome: home, longAgentId: "friend", title: "T", purpose: "P", requestId: "se-topic", expectedRevision: 0 })).topic;
  const root = await createTopicNode({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, title: "根节点", createdBy: "agent", requestId: "se-topic", expectedRevision: 1 });
  const rootSession = await ensureChatSessionWithId({ chatHome: home, projectId: "friend" }, root.node.sessionId, "根");
  rootSession.session.manager.flush();
  const sourceMemory = await writeSessionMemoryEntry({ chatHome: home, longAgentId: "friend", sessionId: root.node.sessionId,
    operation: "write", purpose: "finding", author: "agent", content: "来源", expectedRevision: 0 });
  const realSource = { storageProjectId: "friend", sessionId: root.node.sessionId, entryId: sourceMemory.entries.at(-1).entryId };
  const first = await createTopicNode({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, title: "A", createdBy: "agent", requestId: "se-a", expectedRevision: 2, parents: [{ parentNodeId: root.node.nodeId }] });
  const second = await createTopicNode({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, title: "B", createdBy: "agent", requestId: "se-b", expectedRevision: first.graph.revision, parents: [{ parentNodeId: root.node.nodeId }] });
  // The anchor belongs to the PARENT of the new edge (A), so it must be settled in A's own session.
  const firstSession = await ensureChatSessionWithId({ chatHome: home, projectId: "friend" }, first.node.sessionId, "A");
  const anchor = appendChatUserMessage(firstSession.session.manager, "A 的第一轮");
  firstSession.session.manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "答" }], timestamp: Date.now() });
  appendChatLongAgentTurn(firstSession.session.manager, {
    turnId: "turn-se", longAgentId: "friend", bindingId: "bind-se", source: "chat-web", channelType: null,
    inboundEventId: null, status: "completed", startedAt: "2026-09-24T00:00:00.000Z", completedAt: "2026-09-24T00:00:05.000Z", error: null,
    agentGroupContext: { contextRevision: `sha256:${"a".repeat(64)}`, agentGroupId: "group", agentGroupRevision: `sha256:${"b".repeat(64)}`,
      indexRevision: `sha256:${"c".repeat(64)}`, definitionRevision: `sha256:${"d".repeat(64)}`, stale: false, fetchedAt: "2026-09-24T00:00:00.000Z" },
  });
  firstSession.session.manager.flush();

  // An invented anchor must not become an edge.
  await assert.rejects(
    addTopicNodeParent({ chatHome: home, longAgentId: "friend", childNodeId: second.node.nodeId, parentNodeId: first.node.nodeId,
      anchorEntryId: "invented-anchor", anchorSequence: 99, memoryRefs: [realSource], expectedRevision: second.graph.revision }),
    /锚点不是已完成的轮次/,
  );
  const afterFakeAnchor = await readTopicGraph(home, "friend");
  assert.equal(afterFakeAnchor.edges.some((edge) => edge.anchorEntryId === "invented-anchor"), false);

  // A real settled anchor is accepted, and repeating THAT exact spec is the idempotent path.
  const added = await addTopicNodeParent({ chatHome: home, longAgentId: "friend", childNodeId: second.node.nodeId, parentNodeId: first.node.nodeId,
    anchorEntryId: anchor, anchorSequence: 1, memoryRefs: [realSource], expectedRevision: second.graph.revision });
  assert.equal(added.created, true);
  assert.equal(added.edge.anchorEntryId, anchor);
  const replay = await addTopicNodeParent({ chatHome: home, longAgentId: "friend", childNodeId: second.node.nodeId, parentNodeId: first.node.nodeId,
    anchorEntryId: anchor, anchorSequence: 1, memoryRefs: [realSource], expectedRevision: 999 });
  assert.equal(replay.created, false);
  assert.equal(replay.edge.edgeId, added.edge.edgeId);

  // A different spec for the SAME parent+child is a conflict, not a silent reuse of the old edge.
  await assert.rejects(
    addTopicNodeParent({ chatHome: home, longAgentId: "friend", childNodeId: second.node.nodeId, parentNodeId: first.node.nodeId,
      anchorEntryId: anchor, anchorSequence: 99, memoryRefs: [realSource], expectedRevision: 999 }),
    /该父边已存在且规格不同/,
  );
  await assert.rejects(
    addTopicNodeParent({ chatHome: home, longAgentId: "friend", childNodeId: second.node.nodeId, parentNodeId: first.node.nodeId,
      anchorEntryId: anchor, anchorSequence: 1, memoryRefs: [], expectedRevision: 999 }),
    /该父边已存在且规格不同/,
  );
});
