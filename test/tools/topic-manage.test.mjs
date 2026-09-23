import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TOPIC_MANAGE_TOOL_PROVIDER } from "../../src/tools/builtins/topic-manage/index.ts";
import { ensureChatSessionWithId } from "../../src/chat-session.ts";
import { ensureAgentHomeProject } from "../../src/projects/registry.ts";
import { writeSessionMemoryEntry } from "../../src/long-agents/session-memory.ts";
import { appendChatLongAgentTurn } from "../../src/long-agents/session-turn.ts";
import { appendChatUserMessage } from "../../src/workflows/session-conversation.ts";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-agent-core";
import { createTopic, createTopicNode } from "../../src/long-agents/topics.ts";

const turnContext = {
  contextRevision: `sha256:${"a".repeat(64)}`, agentGroupId: "group", agentGroupRevision: `sha256:${"b".repeat(64)}`,
  indexRevision: `sha256:${"c".repeat(64)}`, definitionRevision: `sha256:${"d".repeat(64)}`, stale: false, fetchedAt: "2026-09-24T00:00:00.000Z",
};

async function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chat-topic-tool-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, "long-agents", "friend"), { recursive: true });
  await ensureAgentHomeProject("friend", "Friend", home);
  await ensureAgentHomeProject("other", "Other", home);
  return home;
}

function tool(home, longAgentId = "friend") {
  const definition = TOPIC_MANAGE_TOOL_PROVIDER.create({
    purpose: "execution", projectId: longAgentId, chatHome: home, cwd: home,
    sessionManager: { getSessionId: () => "sess-check" }, sessionId: "sess-check", agentId: longAgentId, longAgentId,
  });
  return async (params) => {
    const outcome = await definition.execute("call-1", params);
    return outcome.details;
  };
}

test("topic_manage: graph, node and cross-tree memory reads use the shared decision", async (t) => {
  const home = await fixture(t);
  const call = tool(home);
  const topic = (await createTopic({ chatHome: home, longAgentId: "friend", title: "定位", purpose: "定位线上问题", requestId: "tm-topic", expectedRevision: 0 })).topic;
  const root = await createTopicNode({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, title: "根节点", createdBy: "agent", requestId: "tm-topic", expectedRevision: 1 });
  const rootSession = await ensureChatSessionWithId({ chatHome: home, projectId: "friend" }, root.node.sessionId, "根");
  rootSession.session.manager.flush();
  const memory = await writeSessionMemoryEntry({ chatHome: home, longAgentId: "friend", sessionId: root.node.sessionId,
    operation: "write", purpose: "finding", author: "agent", content: "根因是空指针", expectedRevision: 0 });
  const memoryEntryId = memory.entries.at(-1).entryId;

  const graph = await call({ operation: "read_graph" });
  assert.equal(graph.topics.length, 1);
  assert.equal(graph.topics[0].nodes[0].nodeId, root.node.nodeId);
  const node = await call({ operation: "read_node", nodeId: root.node.nodeId });
  assert.equal(node.node.sessionId, root.node.sessionId);
  assert.deepEqual(node.parents, []);

  const ownMemory = await call({ operation: "read_memory", sourceSessionId: root.node.sessionId });
  assert.equal(ownMemory.entries[0].entryId, memoryEntryId);
  assert.deepEqual(ownMemory.entries[0].source, { storageProjectId: "friend", sessionId: root.node.sessionId, entryId: memoryEntryId });

  // Another Long Agent reads the same tree read-only (cross-tree read is part of the contract).
  const stranger = tool(home, "other");
  const crossRead = await stranger({ operation: "read_memory", sourceProjectId: "friend", sourceSessionId: root.node.sessionId });
  assert.equal(crossRead.entries.length, 1);
  const fulltext = await stranger({ operation: "read_fulltext", sourceProjectId: "friend", sourceSessionId: root.node.sessionId, limit: 5 });
  assert.equal(fulltext.entries.length <= 5, true);
  // A plain Project session is not a session-memory source.
  const privateDir = path.join(home, "private");
  fs.mkdirSync(privateDir, { recursive: true });
  const { openProject } = await import("../../src/projects/registry.ts");
  await openProject({ path: privateDir, chatHome: home, id: "private", name: "private" });
  await assert.rejects(stranger({ operation: "read_memory", sourceProjectId: "private", sourceSessionId: "sess-x" }), /Long Agent 归属/);
});

test("topic_manage: create, supplement, archive and relay go through the domain services", async (t) => {
  const home = await fixture(t);
  const call = tool(home);
  const created = await call({ operation: "create_topic", requestId: "tm-new", title: "新主题", purpose: "目的" });
  assert.equal(created.created, true);
  const replayTopic = await call({ operation: "create_topic", requestId: "tm-new", title: "新主题", purpose: "目的" });
  assert.equal(replayTopic.created, false, "the same request id is idempotent");
  // ... but the same request id with different content is a conflict, not a silent success.
  await assert.rejects(call({ operation: "create_topic", requestId: "tm-new", title: "改了标题", purpose: "目的" }), /已用于不同的主题内容/);
  await assert.rejects(call({ operation: "create_topic", requestId: "tm-new", title: "新主题", purpose: "改了目的" }), /已用于不同的主题内容/);

  // Root node + its settled round, then a child node created from that anchor through the tool.
  const rootNode = await call({ operation: "create_node", topicId: created.topic.topicId, requestId: "tm-new", title: "根节点" });
  assert.equal(rootNode.created, true);
  const rootSession = await ensureChatSessionWithId({ chatHome: home, projectId: "friend" }, rootNode.node.sessionId, "根");
  const anchor = appendChatUserMessage(rootSession.session.manager, "第一轮");
  rootSession.session.manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "答" }], timestamp: Date.now() });
  appendChatLongAgentTurn(rootSession.session.manager, {
    turnId: "tm-turn", longAgentId: "friend", bindingId: "bind", source: "chat-web", channelType: null,
    inboundEventId: null, status: "completed", startedAt: "2026-09-24T00:00:00.000Z", completedAt: "2026-09-24T00:00:05.000Z", error: null,
    agentGroupContext: turnContext,
  });
  rootSession.session.manager.flush();
  const sourceMemory = await writeSessionMemoryEntry({ chatHome: home, longAgentId: "friend", sessionId: rootNode.node.sessionId,
    operation: "write", purpose: "finding", author: "agent", content: "结论", expectedRevision: 0 });
  const source = { storageProjectId: "friend", sessionId: rootNode.node.sessionId, entryId: sourceMemory.entries.at(-1).entryId };

  const child = await call({ operation: "create_node", topicId: created.topic.topicId, requestId: "tm-child", title: "子节点",
    integrationSummary: "整合摘要", memoryContent: "背景", source,
    parents: [{ nodeId: rootNode.node.nodeId, anchorEntryId: anchor, anchorSequence: 1 }] });
  assert.equal(child.created, true);
  assert.equal(child.node.initialMemoryRefs[0].source.entryId, source.entryId);
  const replayChild = await call({ operation: "create_node", topicId: created.topic.topicId, requestId: "tm-child", title: "子节点",
    integrationSummary: "整合摘要", memoryContent: "背景", source,
    parents: [{ nodeId: rootNode.node.nodeId, anchorEntryId: anchor, anchorSequence: 1 }] });
  assert.equal(replayChild.created, false, "the node creation is replay-safe through the tool too");

  const supplementalParent = await call({ operation: "create_node", topicId: created.topic.topicId, requestId: "tm-branch", title: "另一支",
    parents: [{ nodeId: rootNode.node.nodeId }] });
  // A NEW supplementary edge needs a settled anchor; an invented one is refused and no edge is written.
  await assert.rejects(
    call({ operation: "add_parent", nodeId: child.node.nodeId, parentNodeId: supplementalParent.node.nodeId, anchorEntryId: "invented", anchorSequence: 9 }),
    /锚点不是已完成的轮次/,
  );
  // Re-using the existing (root -> child) edge with a different spec is a conflict, not a silent reuse.
  await assert.rejects(
    call({ operation: "add_parent", nodeId: child.node.nodeId, parentNodeId: rootNode.node.nodeId, anchorEntryId: "invented", anchorSequence: 9 }),
    /该父边已存在且规格不同/,
  );
  // A positive supplement: the edge is new AND its parent session (root) has the settled anchor.
  const thirdBranch = await call({ operation: "create_node", topicId: created.topic.topicId, requestId: "tm-branch-2", title: "第三条分支",
    parents: [{ nodeId: supplementalParent.node.nodeId }] });
  const added = await call({ operation: "add_parent", nodeId: thirdBranch.node.nodeId, parentNodeId: rootNode.node.nodeId,
    anchorEntryId: anchor, anchorSequence: 1, source });
  assert.equal(added.created, true);
  assert.equal(added.edge.anchorEntryId, anchor);

  const archived = await call({ operation: "update_node_status", nodeId: supplementalParent.node.nodeId, status: "archived" });
  assert.equal(archived.node.status, "archived");

  // Relay: ONE atomic custom_message append that enters the model context as a user message.
  const relayed = await call({ operation: "relay", targetNodeId: child.node.nodeId, requestId: "tm-relay", text: "请继续定位这个分支" });
  assert.equal(relayed.created, true);
  const childSession = await ensureChatSessionWithId({ chatHome: home, projectId: "friend" }, child.node.sessionId, "子节点");
  const branch = childSession.session.manager.getBranch();
  const relayEntries = branch.filter((entry) => entry.type === "custom_message" && entry.customType === "chat.topic-relay");
  assert.equal(relayEntries.length, 1, "relay is a single entry: there is no message/marker interruption window");
  assert.equal(relayEntries[0].display, true);
  assert.equal(relayEntries[0].content, "请继续定位这个分支");
  // It becomes a real user message for the model (role custom -> role user).
  assert.equal(sessionEntryToContextMessages(relayEntries[0])[0].role, "custom");
  assert.equal(convertToLlm(sessionEntryToContextMessages(relayEntries[0]))[0].role, "user");
  const replayRelay = await call({ operation: "relay", targetNodeId: child.node.nodeId, requestId: "tm-relay", text: "请继续定位这个分支" });
  assert.equal(replayRelay.created, false);
  assert.equal(replayRelay.userEntryId, relayed.userEntryId);
  // Same request id, different relayed text: a conflict, not a silent success.
  await assert.rejects(call({ operation: "relay", targetNodeId: child.node.nodeId, requestId: "tm-relay", text: "换了内容" }), /已用于不同的代传内容/);
  const afterConflicts = (await ensureChatSessionWithId({ chatHome: home, projectId: "friend" }, child.node.sessionId, "子节点")).session.manager.getBranch()
    .filter((entry) => entry.type === "custom_message" && entry.customType === "chat.topic-relay");
  assert.equal(afterConflicts.length, 1, "no extra relay entry was written");
  // A node that does not exist in this agent's own tree cannot be relayed to.
  await assert.rejects(call({ operation: "relay", targetNodeId: "node-00000000000000000000000000000000", requestId: "tm-relay-2", text: "x" }), /找不到主题节点/);
});

test("topic_manage: a node records every source it was built from, with the frozen project context", async (t) => {
  const home = await fixture(t);
  const call = tool(home);
  const topic = await call({ operation: "create_topic", requestId: "ms-topic", title: "多来源", purpose: "整合两个会话" });
  const root = await call({ operation: "create_node", topicId: topic.topic.topicId, requestId: "ms-topic", title: "根节点" });
  const firstSession = await ensureChatSessionWithId({ chatHome: home, projectId: "friend" }, root.node.sessionId, "根");
  firstSession.session.manager.flush();
  const secondSession = await ensureChatSessionWithId({ chatHome: home, projectId: "friend" }, "sess-second-source", "第二来源");
  secondSession.session.manager.flush();
  const firstEntry = (await writeSessionMemoryEntry({ chatHome: home, longAgentId: "friend", sessionId: root.node.sessionId,
    operation: "write", purpose: "finding", author: "agent", content: "来源一", expectedRevision: 0 })).entries.at(-1);
  const secondEntry = (await writeSessionMemoryEntry({ chatHome: home, longAgentId: "friend", sessionId: "sess-second-source",
    operation: "write", purpose: "finding", author: "agent", content: "来源二", expectedRevision: 0 })).entries.at(-1);
  const sources = [
    { storageProjectId: "friend", sessionId: root.node.sessionId, entryId: firstEntry.entryId },
    { storageProjectId: "friend", sessionId: "sess-second-source", entryId: secondEntry.entryId },
  ];
  const child = await call({ operation: "create_node", topicId: topic.topic.topicId, requestId: "ms-child", title: "整合节点",
    integrationSummary: "两个会话的整合", memoryContent: "共同背景", sources, frozenProjectContext: "child-project",
    parents: [{ nodeId: root.node.nodeId }] });
  assert.equal(child.created, true);
  assert.equal(child.node.frozenProjectContext, "child-project", "the frozen project context is passed through");
  assert.deepEqual(child.node.initialMemoryRefs.map((ref) => ref.source.sessionId).sort(),
    [root.node.sessionId, "sess-second-source"].sort(), "both source sessions are traceable");
  // Both refs still address a real, linked bootstrap entry.
  const memory = (await call({ operation: "read_memory", sourceSessionId: child.node.sessionId })).entries;
  assert.equal(memory.length, 1, "the shared content is written once");
  assert.equal(child.node.initialMemoryRefs.every((ref) => ref.entryId === memory[0].entryId), true);
  const graph = await call({ operation: "read_graph", topicId: topic.topic.topicId });
  const readBack = graph.topics[0].nodes.find((node) => node.nodeId === child.node.nodeId);
  assert.equal(readBack.initialMemoryRefs.length, 2);
});

test("topic_manage: read_fulltext returns custom-message text and pages back through history", async (t) => {
  const home = await fixture(t);
  const call = tool(home);
  const topic = await call({ operation: "create_topic", requestId: "ft-topic", title: "全文", purpose: "读取" });
  const root = await call({ operation: "create_node", topicId: topic.topic.topicId, requestId: "ft-topic", title: "根节点",
    integrationSummary: "重要的整合摘要", memoryContent: null });
  assert.equal(root.summaryEntryId !== null, true);
  const sessionId = root.node.sessionId;
  const session = await ensureChatSessionWithId({ chatHome: home, projectId: "friend" }, sessionId, "根");
  appendChatUserMessage(session.session.manager, "长消息：" + "x".repeat(5_000));
  for (let index = 0; index < 60; index += 1) appendChatUserMessage(session.session.manager, `第 ${index} 条历史`);
  session.session.manager.flush();

  const recent = await call({ operation: "read_fulltext", sourceSessionId: sessionId, limit: 20 });
  assert.equal(recent.entries.length, 20);
  assert.equal(typeof recent.nextCursor, "string", "a cursor lets the caller keep reading older entries");
  assert.equal(recent.total > 60, true);
  // The integration summary is readable (not an empty text) and still carries its request id.
  const foundSummary = recent.entries.find((entry) => entry.customType === "chat.topic-integration-summary")
    ?? (await (async () => {
      // The summary is the very first entry, so it appears only when paging reaches it.
      let cursor = recent.nextCursor;
      for (let page = 0; page < 10; page += 1) {
        const older = await call({ operation: "read_fulltext", sourceSessionId: sessionId, limit: 50, beforeEntryId: cursor });
        const hit = older.entries.find((entry) => entry.customType === "chat.topic-integration-summary");
        if (hit !== undefined) return hit;
        if (older.nextCursor === null || older.entries.length === 0) return undefined;
        cursor = older.nextCursor;
      }
      return undefined;
    })());
  assert.notEqual(foundSummary, undefined, "the integration summary is reachable through paging");
  assert.equal(foundSummary.text, "重要的整合摘要");
  assert.equal(foundSummary.truncated, false);
  assert.equal(foundSummary.requestId, "ft-topic");

  // A long entry is returned with an explicit truncation flag instead of silently losing text.
  let cursor = recent.nextCursor;
  let longEntry = null;
  for (let page = 0; page < 10 && longEntry === null; page += 1) {
    const older = await call({ operation: "read_fulltext", sourceSessionId: sessionId, limit: 50, beforeEntryId: cursor });
    longEntry = older.entries.find((entry) => entry.text.startsWith("长消息：")) ?? null;
    if (older.nextCursor === null) break;
    cursor = older.nextCursor;
  }
  assert.notEqual(longEntry, null, "the long message is reachable");
  assert.equal(longEntry.truncated, true);
  assert.equal(longEntry.text.length, 4_000);
});
