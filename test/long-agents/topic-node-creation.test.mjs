import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureChatSessionWithId, openChatSession } from "../../src/chat-session.ts";
import { appendChatUserMessage } from "../../src/workflows/session-conversation.ts";
import { appendChatLongAgentTurn } from "../../src/long-agents/session-turn.ts";
import { readSessionMemory, writeSessionMemoryEntry } from "../../src/long-agents/session-memory.ts";
import { ensureAgentHomeProject } from "../../src/projects/registry.ts";
import { purgeRemovedChatSession, removeChatSession, restoreRemovedChatSession } from "../../src/session-removal.ts";
import {
  createTopic,
  createTopicNode,
  readTopicGraph,
  topicGraphFile,
  topicNodeSessionIdOf,
  topicRootSessionIdOf,
  topicIdOf,
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
  const source = { storageProjectId: "friend", sessionId: topic.rootSessionId, entryId: parentAnchor };
  const request = {
    chatHome: home, longAgentId: "friend", topicId: topic.topicId, requestId: "rq-child", title: "子节点",
    createdBy: "agent", integrationSummary: "整合摘要：第一个问题已经定位", source,
    initialMemory: { content: "背景：第一个问题已定位", originEntryId: parentAnchor },
    parents: [{ parentNodeId: root.node.nodeId, anchorEntryId: parentAnchor, anchorSequence: 1, memoryRefs: [source] }],
  };
  const first = await createTopicNodeWithSession(request);
  assert.equal(first.created, true);
  assert.equal(first.sessionId, topicNodeSessionIdOf(topic.topicId, "rq-child"));
  assert.equal(first.node.initialMemoryRefs.length, 1);
  assert.equal(first.node.initialMemoryRefs[0].source.entryId, parentAnchor);
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

  // Interruption between the durable writes and the graph registration: the retry adopts what already
  // exists instead of writing a second summary or a second bootstrap memory entry.
  const interrupted = { ...request, requestId: "rq-child-4", title: "中断重试" };
  const interruptedSessionId = topicNodeSessionIdOf(topic.topicId, "rq-child-4");
  const partial = await ensureChatSessionWithId({ chatHome: home, projectId: "friend" }, interruptedSessionId, "中断重试");
  const partialSummaryId = partial.session.manager.appendCustomMessageEntry(TOPIC_INTEGRATION_SUMMARY_CUSTOM_TYPE, interrupted.integrationSummary, false, { requestId: "rq-child-4", topicId: topic.topicId, sessionId: interruptedSessionId });
  partial.session.manager.flush();
  const beforeMemory = await readSessionMemory(home, "friend", interruptedSessionId);
  const partialMemory = await writeSessionMemoryEntry({ chatHome: home, longAgentId: "friend", sessionId: interruptedSessionId, operation: "write",
    purpose: "background", author: "agent", content: interrupted.initialMemory.content, originEntryId: parentAnchor, expectedRevision: beforeMemory.revision });
  const partialMemoryId = partialMemory.entries.at(-1).entryId;
  const resumed = await createTopicNodeWithSession(interrupted);
  assert.equal(resumed.created, true, "the node itself was still missing, so it is registered now");
  assert.equal(resumed.sessionId, interruptedSessionId, "the retry reuses the same derived session");
  assert.equal(resumed.summaryEntryId, partialSummaryId, "the existing summary is adopted");
  assert.equal(resumed.memoryEntryId, partialMemoryId, "the existing bootstrap memory entry is adopted");
  assert.equal(resumed.node.initialMemoryRefs[0].entryId, partialMemoryId);
  const resumedSession = await openChatSession({ chatHome: home, projectId: "friend", sessionId: interruptedSessionId });
  assert.equal(resumedSession.manager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === TOPIC_INTEGRATION_SUMMARY_CUSTOM_TYPE).length, 1);
  assert.equal((await readSessionMemory(home, "friend", interruptedSessionId)).entries.length, 1, "no duplicate bootstrap entry");

  // An anchor that is not a settled round is refused before anything is written.
  const running = appendChatUserMessage(parentSession.session.manager, "还在进行的问题");
  parentSession.session.manager.flush();
  await assert.rejects(
    createTopicNodeWithSession({ ...request, requestId: "rq-child-3", parents: [{ parentNodeId: root.node.nodeId, anchorEntryId: running, anchorSequence: null }] }),
    /锚点不是已完成的轮次/,
  );
  const afterFailure = await readTopicGraph(home, "friend");
  assert.equal(afterFailure.nodes.some((node) => node.createdByRequestId === "rq-child-3"), false, "a rejected anchor leaves no node");
});
