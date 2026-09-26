import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fixture } from "./daily-fixture.mjs";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { executeLongAgentTurn } from "../../src/long-agents/runtime.ts";
import { readLongAgentState, readLongAgentRegistry, writeLongAgentRegistry } from "../../src/long-agents/storage.ts";
import { topicIntegrationIds, startTopicIntegration } from "../../src/long-agents/topic-integration.ts";
import { readSessionMemory, writeSessionMemoryEntry } from "../../src/long-agents/session-memory.ts";
import { readTopicSettledAnchors } from "../../src/long-agents/topic-anchor.ts";
import { ensureChatSessionWithId } from "../../src/chat-session.ts";

async function router() {
  const { createRouter } = await import("nitro/h3");
  const app = createRouter();
  app.post("/api/long-agents/:longAgentId/topics/integrations",
    (await import("../../src/routes/api/long-agents/[longAgentId]/topics/integrations.post.ts")).default);
  app.get("/api/long-agents/:longAgentId/topics/integrations/:requestId",
    (await import("../../src/routes/api/long-agents/[longAgentId]/topics/integrations/[requestId].get.ts")).default);
  app.post("/api/long-agents/:longAgentId/topics/:topicId/nodes/:nodeId/messages",
    (await import("../../src/routes/api/long-agents/[longAgentId]/topics/[topicId]/nodes/[nodeId]/messages.post.ts")).default);
  app.post("/api/long-agents/:longAgentId/topics/:topicId/nodes/:nodeId/supplements",
    (await import("../../src/routes/api/long-agents/[longAgentId]/topics/[topicId]/nodes/[nodeId]/supplements.post.ts")).default);
  app.get("/api/long-agents/:longAgentId/turns/:turnId",
    (await import("../../src/routes/api/long-agents/[longAgentId]/turns/[turnId].get.ts")).default);
  return app;
}

/** The integration work is an ordinary Long Agent turn, so the agent needs the topic tool assembled. */
async function enableTopicTool(home) {
  const registry = await readLongAgentRegistry(home);
  const friend = registry.agents.find((agent) => agent.id === "friend");
  friend.definition = { ...friend.definition,
    tools: { ...friend.definition.tools, addresses: ["system:tool/topic_manage", "system:tool/workflow_call"] } };
  await writeLongAgentRegistry(registry, home);
}

test("topic integration: a daily 建题 request drives the background integration to an entryable root node", async (t) => {
  const base = await fixture(t);
  const previousHome = process.env.CHAT_HOME;
  process.env.CHAT_HOME = base.home;
  const faux = registerFauxProvider({ api: "chat-topic-integration-faux", provider: "chat-topic-integration-faux" });
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
  await enableTopicTool(base.home);

  // A real daily session is the only accepted integration origin.
  faux.setResponses([fauxAssistantMessage("ack"), fauxAssistantMessage("本轮无需写入")]);
  await executeLongAgentTurn(base.input("daily-1"));
  const daily = (await readLongAgentState(base.home)).dailySessions.find((day) => day.longAgentId === "friend");
  assert.notEqual(daily, undefined, "the daily source session exists");
  // The integration provenance must address a real session-memory entry of the source session.
  const sourceMemory = (await writeSessionMemoryEntry({ chatHome: base.home, longAgentId: "friend", sessionId: daily.sessionId,
    operation: "write", purpose: "finding", author: "agent", content: "今日排查：空指针候选", expectedRevision: 0 })).entries.at(-1);

  const app = await router();
  const call = (requestPath, init) => app.fetch(new Request(`http://chat.test${requestPath}`, init));
  const requestId = "topic-int-1";
  const ids = topicIntegrationIds("friend", requestId);

  // The integration work is scripted to submit the product through the REAL topic_manage tool.
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("topic_manage", { operation: "create_topic", requestId, title: "空指针定位", purpose: "定位线上空指针并沉淀结论" })),
    fauxAssistantMessage(fauxToolCall("topic_manage", { operation: "create_node", topicId: ids.topicId, requestId, title: "空指针定位",
      integrationSummary: "整合摘要：空指针来自 userId 未校验，来源为今日排查。",
      sources: [{ storageProjectId: "friend", sessionId: daily.sessionId, entryId: sourceMemory.entryId, content: "空指针根因：userId 未校验；来源：今日排查。" }] })),
    fauxAssistantMessage("已建主题「空指针定位」"),
  ]);

  // Seed a legacy work to verify compatibility replay. New HTTP requests are covered by the
  // review Workflow Runtime test and must no longer start this old background-work path.
  await startTopicIntegration({ chatHome: base.home, longAgentId: "friend", requestId,
    title: "空指针定位", purpose: "定位线上空指针并沉淀结论" });
  const created = await call("/api/long-agents/friend/topics/integrations", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, requestId, title: "空指针定位", purpose: "定位线上空指针并沉淀结论" }),
  });
  assert.equal(created.status, 202);
  const started = await created.json();
  assert.equal(started.topicId, ids.topicId);
  assert.equal(started.nodeId, ids.nodeId, "the entryable node id is a pure function of the request");
  assert.equal(started.sessionId, ids.sessionId);
  assert.equal(started.sourceSessionId, daily.sessionId, "the server resolved the daily source, not the client");
  assert.notEqual(started.work, null);
  assert.equal(started.work.originSessionId, daily.sessionId);
  assert.equal(started.work.title, "整合：空指针定位");
  assert.equal(started.status === "queued" || started.status === "running" || started.status === "completed", true);

  // A replay of the SAME request is the same work, not a second integration.
  const replay = await (await call("/api/long-agents/friend/topics/integrations", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, requestId, title: "空指针定位", purpose: "定位线上空指针并沉淀结论" }),
  })).json();
  assert.equal(replay.work.id, started.work.id, "the request id owns exactly one integration work");
  // A changed payload under the same id is a conflict.
  assert.equal((await call("/api/long-agents/friend/topics/integrations", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, requestId, title: "换了标题", purpose: "定位线上空指针并沉淀结论" }),
  })).status, 400);

  const { drainLongAgentTurns } = await import("../../src/long-agents/turn-queue.ts");
  await drainLongAgentTurns(base.home, "friend", started.work.sessionId);

  const done = await (await call(`/api/long-agents/friend/topics/integrations/${requestId}`)).json();
  assert.equal(done.status, "completed", "the graph node is the product fact");
  assert.equal(done.node.nodeId, ids.nodeId);
  assert.equal(done.node.sessionId, ids.sessionId);
  assert.equal(done.topic.topicId, ids.topicId);
  assert.equal(done.node.createdByRequestId, requestId);
  const memory = await readSessionMemory(base.home, "friend", ids.sessionId);
  assert.equal(memory.entries.some((entry) => entry.purpose === "background" && entry.content.includes("空指针根因")), true,
    "the root node carries its integrated initial memory");
  // After the node exists, the request identity is still enforced against the persisted work: a same
  // payload replay is still that one work, while any changed field is a conflict — not a silent success.
  const postReplay = await (await call("/api/long-agents/friend/topics/integrations", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, requestId, title: "空指针定位", purpose: "定位线上空指针并沉淀结论" }),
  })).json();
  assert.equal(postReplay.work.id, started.work.id);
  assert.equal(postReplay.node.nodeId, ids.nodeId);
  for (const changed of [
    { title: "换了标题", purpose: "定位线上空指针并沉淀结论" },
    { title: "空指针定位", purpose: "换了目的" },
    { title: "空指针定位", purpose: "定位线上空指针并沉淀结论", sourceSessionId: "sess-some-other-daily" },
  ]) {
    assert.equal((await call("/api/long-agents/friend/topics/integrations", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, requestId, ...changed }),
    })).status, 400, `a post-creation change must conflict: ${JSON.stringify(changed)}`);
  }
  // Unknown requests are a 404, never an empty success.
  assert.equal((await call("/api/long-agents/friend/topics/integrations/no-such-request")).status, 404);

  // The produced node is a normal node session: one work+remember round, then it is forkable.
  faux.setResponses([
    fauxAssistantMessage("work：已确认 userId 未校验"),
    fauxAssistantMessage(fauxToolCall("session_memory", { operation: "write", purpose: "finding", author: "agent", content: "已确认 userId 未校验", expectedRevision: 1 })),
    (context) => fauxAssistantMessage(`已写入 ${/"entryId":"([^"]+)"/.exec(context.messages.filter((message) => message.role === "toolResult").map((message) => JSON.stringify(message)).join("\n"))?.[1] ?? "missing"}`),
  ]);
  const sent = await call(`/api/long-agents/friend/topics/${ids.topicId}/nodes/${ids.nodeId}/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, requestId: "int-turn-1", text: "继续定位" }),
  });
  assert.equal(sent.status, 202);
  await drainLongAgentTurns(base.home, "friend", ids.sessionId);
  const turn = (await readLongAgentState(base.home)).turns.find((candidate) => candidate.turnId === "chat-web:friend:int-turn-1");
  assert.equal(turn.status, "completed");
  const manager = (await ensureChatSessionWithId({ chatHome: base.home, projectId: "friend" }, ids.sessionId)).session.manager;
  const anchors = readTopicSettledAnchors(manager);
  assert.equal(anchors.length, 1, "the integrated node round is forkable");
  assert.equal(anchors[0].turnId, "chat-web:friend:int-turn-1");
});

const requestIdForTurn = (turnId, parents = []) =>
  `topic-req:${createHash("sha256").update(JSON.stringify([turnId, parents])).digest("hex").slice(0, 32)}`;

test("topic integration: request_topic takes its source and request identity from the trusted turn, and forks", async (t) => {
  const base = await fixture(t);
  const previousHome = process.env.CHAT_HOME;
  process.env.CHAT_HOME = base.home;
  const faux = registerFauxProvider({ api: "chat-topic-request-faux", provider: "chat-topic-request-faux" });
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
  await enableTopicTool(base.home);

  faux.setResponses([fauxAssistantMessage("ack"), fauxAssistantMessage("本轮无需写入")]);
  await executeLongAgentTurn(base.input("rt-daily-1"));
  const daily = (await readLongAgentState(base.home)).dailySessions.find((day) => day.longAgentId === "friend");
  const sourceMemory = (await writeSessionMemoryEntry({ chatHome: base.home, longAgentId: "friend", sessionId: daily.sessionId,
    operation: "write", purpose: "finding", author: "user", content: "来源事实：空指针候选", expectedRevision: 0 })).entries.at(-1);

  const { TOPIC_MANAGE_TOOL_PROVIDER } = await import("../../src/tools/builtins/topic-manage/index.ts");
  const { readTopicIntegration, startTopicIntegration } = await import("../../src/long-agents/topic-integration.ts");
  const { topicCreationRequestForTurn } = await import("../../src/workflows/topic-session-create/start.ts");
  const { drainLongAgentTurns } = await import("../../src/long-agents/turn-queue.ts");
  const tool = (turnId) => TOPIC_MANAGE_TOOL_PROVIDER.create({ purpose: "execution", projectId: "friend", chatHome: base.home, cwd: base.home,
    sessionManager: { getSessionId: () => daily.sessionId }, sessionId: daily.sessionId, agentId: "friend", longAgentId: "friend", longAgentTurnId: turnId });
  const call = async (turnId, params) => (await tool(turnId).execute("call-1", params)).details;
  const workSessionOf = async (workId) => (await readLongAgentState(base.home)).works.find((work) => work.id === workId).sessionId;

  // --- Root: the model only names title/purpose; there is no sourceSessionId in the parameters. ---
  const rootTurn = "chat-web:friend:rt-daily-1";
  const rootRequestId = requestIdForTurn(rootTurn);
  const rootIds = topicIntegrationIds("friend", rootRequestId);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("topic_manage", { operation: "create_topic", requestId: rootRequestId, title: "可信来源建题", purpose: "验证来源与请求身份来自当前 turn" })),
    fauxAssistantMessage(fauxToolCall("topic_manage", { operation: "create_node", topicId: rootIds.topicId, requestId: rootRequestId, title: "可信来源建题",
      integrationSummary: "整合摘要", sources: [{ storageProjectId: "friend", sessionId: daily.sessionId, entryId: sourceMemory.entryId, content: "整合后的初始记忆" }] })),
    fauxAssistantMessage("已建节点「可信来源建题」"),
  ]);
  // The tool's trusted derivation is pure and model-independent; the explicit entry still drives the
  // legacy integration chain (the tool now starts the review-gated Workflow instead).
  assert.equal(topicCreationRequestForTurn(rootTurn, []), rootRequestId, "the request id is derived from the trusted turn");
  await assert.rejects(async () => topicCreationRequestForTurn("", []), /可信轮次/);
  const root = await startTopicIntegration({ chatHome: base.home, longAgentId: "friend", requestId: rootRequestId,
    title: "可信来源建题", purpose: "验证来源与请求身份来自当前 turn", sourceSessionId: daily.sessionId });
  assert.equal(root.topicId, rootIds.topicId);
  assert.equal(root.nodeId, rootIds.nodeId);
  assert.equal(root.sessionId, rootIds.sessionId);
  await drainLongAgentTurns(base.home, "friend", await workSessionOf(root.work.id));
  const rootDone = await readTopicIntegration({ chatHome: base.home, longAgentId: "friend", requestId: rootRequestId });
  assert.equal(rootDone.status, "completed");
  assert.equal(rootDone.node.nodeId, rootIds.nodeId);
  assert.equal(rootDone.sourceSessionId, daily.sessionId, "the source is the caller's own daily session");

  // A daily conversation cannot open a bare topic shell; create_topic is reserved for the integration work.
  await assert.rejects(call(rootTurn, { operation: "create_topic", requestId: "shell", title: "壳", purpose: "壳" }),
    /request_topic/, "the daily entry must be request_topic, not create_topic");

  // --- A real node round produces a real settled anchor. ---
  faux.setResponses([
    fauxAssistantMessage("work：继续排查"),
    fauxAssistantMessage(fauxToolCall("session_memory", { operation: "write", purpose: "finding", author: "agent", content: "排查结论", expectedRevision: 1 })),
    (context) => fauxAssistantMessage(`已写入 ${/"entryId":"([^"]+)"/.exec(context.messages.filter((message) => message.role === "toolResult").map((message) => JSON.stringify(message)).join("\n"))?.[1] ?? "missing"}`),
  ]);
  const { acceptLongAgentTurn } = await import("../../src/long-agents/turn-queue.ts");
  await acceptLongAgentTurn({ chatHome: base.home, longAgentId: "friend", requireInteractionRevision: false, projectId: "friend",
    turnId: "rt-node-1", text: "继续排查", source: "chat-web", topicNode: { topicId: rootIds.topicId, nodeId: rootIds.nodeId } });
  await drainLongAgentTurns(base.home, "friend", rootIds.sessionId);
  const manager = (await ensureChatSessionWithId({ chatHome: base.home, projectId: "friend" }, rootIds.sessionId)).session.manager;
  const anchor = readTopicSettledAnchors(manager).at(-1);
  assert.notEqual(anchor, undefined, "the node round settled an anchor");

  // --- Fork: the same integration chain, now integrating the parent node at its settled anchor. ---
  const parents = [{ nodeId: rootIds.nodeId, anchorEntryId: anchor.anchorEntryId, anchorSequence: anchor.anchorSequence }];
  const forkTurn = "chat-web:friend:rt-daily-2";
  const forkRequestId = requestIdForTurn(forkTurn, parents);
  const forkIds = topicIntegrationIds("friend", forkRequestId, rootIds.topicId);
  const rootMemory = await readSessionMemory(base.home, "friend", rootIds.sessionId);
  const parentMemoryEntry = rootMemory.entries.at(-1);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("topic_manage", { operation: "create_node", topicId: forkIds.topicId, requestId: forkRequestId, title: "子节点",
      integrationSummary: "从父节点锚点分叉的整合摘要", parents,
      sources: [{ storageProjectId: "friend", sessionId: rootIds.sessionId, entryId: parentMemoryEntry.entryId, content: "子节点初始记忆" }] })),
    fauxAssistantMessage("已建节点「子节点」"),
  ]);
  assert.equal(topicCreationRequestForTurn(forkTurn, parents), forkRequestId);
  const fork = await startTopicIntegration({ chatHome: base.home, longAgentId: "friend", requestId: forkRequestId,
    title: "子节点", purpose: "从真实锚点 fork", sourceSessionId: daily.sessionId, parents });
  assert.equal(fork.topicId, rootIds.topicId, "a fork reuses the parent's topic");
  assert.equal(fork.nodeId, forkIds.nodeId);
  // Before the work produces the node, a status read must return the SAME frozen target (a fork's ids
  // are parent-topic based and cannot be re-derived as a new root).
  const forkPending = await readTopicIntegration({ chatHome: base.home, longAgentId: "friend", requestId: forkRequestId });
  assert.equal(forkPending.node, null, "the node does not exist yet");
  assert.equal(forkPending.topicId, rootIds.topicId);
  assert.equal(forkPending.sessionId, forkIds.sessionId);
  assert.equal(forkPending.nodeId, forkIds.nodeId);
  assert.equal(forkPending.status !== "completed", true, "an in-progress work is not success");
  await drainLongAgentTurns(base.home, "friend", await workSessionOf(fork.work.id));
  const forkDone = await readTopicIntegration({ chatHome: base.home, longAgentId: "friend", requestId: forkRequestId });
  assert.equal(forkDone.status, "completed");
  assert.deepEqual(forkDone.node.createdByRequestId, forkRequestId);
  const edge = forkDone.node.parents ?? undefined;
  const { readTopicGraph } = await import("../../src/long-agents/topics.ts");
  const graph = await readTopicGraph(base.home, "friend");
  const parentEdge = graph.edges.find((candidate) => candidate.childNodeId === forkIds.nodeId);
  assert.notEqual(parentEdge, undefined, "the child carries its parent edge");
  assert.equal(parentEdge.parentNodeId, rootIds.nodeId);
  assert.equal(parentEdge.anchorEntryId, anchor.anchorEntryId);
  assert.equal(parentEdge.anchorSequence, anchor.anchorSequence);
  void edge;

  // --- A work that finishes without a node is a FAILURE, never a reported success (no bare shell). ---
  const failTurn = "chat-web:friend:rt-daily-3";
  const failRequestId = requestIdForTurn(failTurn);
  faux.setResponses([fauxAssistantMessage("我不建节点了")]);
  const failed = await startTopicIntegration({ chatHome: base.home, longAgentId: "friend", requestId: failRequestId,
    title: "没有节点", purpose: "失败不得报成功", sourceSessionId: daily.sessionId });
  await drainLongAgentTurns(base.home, "friend", await workSessionOf(failed.work.id));
  const failedDone = await readTopicIntegration({ chatHome: base.home, longAgentId: "friend", requestId: failRequestId });
  assert.equal(failedDone.node, null);
  assert.equal(failedDone.status, "failed", "a finished work without a node is not success");
});

test("topic integration: a relay round resumes the relayed message and never writes a second copy", async (t) => {
  const base = await fixture(t);
  const previousHome = process.env.CHAT_HOME;
  process.env.CHAT_HOME = base.home;
  const faux = registerFauxProvider({ api: "chat-topic-relay-faux", provider: "chat-topic-relay-faux" });
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
  await enableTopicTool(base.home);

  const { createTopic, createTopicNodeWithSession } = await import("../../src/long-agents/topics.ts");
  const { TOPIC_MANAGE_TOOL_PROVIDER } = await import("../../src/tools/builtins/topic-manage/index.ts");
  const { drainLongAgentTurns } = await import("../../src/long-agents/turn-queue.ts");
  const { openChatSession } = await import("../../src/chat-session.ts");
  const topic = (await createTopic({ chatHome: base.home, longAgentId: "friend", title: "代传链", purpose: "代传链", requestId: "relay-topic", expectedRevision: 0 })).topic;
  const root = (await createTopicNodeWithSession({ chatHome: base.home, longAgentId: "friend", topicId: topic.topicId,
    requestId: "relay-topic", title: "根节点", createdBy: "agent" })).node;

  // The relay is invoked from a REAL Long Agent turn (longAgentTurnId present), so it also runs the round.
  const definition = TOPIC_MANAGE_TOOL_PROVIDER.create({ purpose: "execution", projectId: "friend", chatHome: base.home, cwd: base.home,
    sessionManager: { getSessionId: () => "sess-relay-caller" }, sessionId: "sess-relay-caller", agentId: "friend", longAgentId: "friend",
    longAgentTurnId: "chat-web:friend:relay-caller" });
  faux.setResponses([
    fauxAssistantMessage("work：已按代传内容继续排查"),
    fauxAssistantMessage(fauxToolCall("session_memory", { operation: "write", purpose: "finding", author: "agent", content: "代传轮次结论", expectedRevision: 0 })),
    (context) => fauxAssistantMessage(`已写入 ${/"entryId":"([^"]+)"/.exec(context.messages.filter((message) => message.role === "toolResult").map((message) => JSON.stringify(message)).join("\n"))?.[1] ?? "missing"}`),
  ]);
  const relayed = (await definition.execute("call-1", { operation: "relay", targetNodeId: root.nodeId, requestId: "relay-1", text: "请继续排查这个分支" })).details;
  assert.equal(relayed.created, true);
  assert.notEqual(relayed.intentEntryId, "", "the relay persists a durable intent");
  assert.equal(relayed.userEntryId, null, "no native message exists before the round runs");
  await drainLongAgentTurns(base.home, "friend", root.sessionId);

  const session = await openChatSession({ chatHome: base.home, projectId: "friend", sessionId: root.sessionId });
  const userMessages = session.manager.getEntries().filter((entry) => entry.type === "message" && entry.message?.role === "user");
  assert.equal(userMessages.length, 1, "exactly one native relayed message was appended by the round");
  assert.equal(userMessages[0].message.chatTopicRelay.requestId, "relay-1");
  const turn = (await readLongAgentState(base.home)).turns.find((candidate) => candidate.turnId === "chat-web:friend:relay:relay-1");
  assert.equal(turn.status, "completed");
  assert.equal(turn.relayIntentEntryId, relayed.intentEntryId, "the accepted turn froze the relay intent");
  // Replaying the request after completion adopts the ONE native message; no duplicate is written.
  const replay = (await definition.execute("call-1b", { operation: "relay", targetNodeId: root.nodeId, requestId: "relay-1", text: "请继续排查这个分支" })).details;
  assert.equal(replay.created, false);
  assert.equal(replay.userEntryId, userMessages[0].id);
  const memory = await readSessionMemory(base.home, "friend", root.sessionId);
  assert.equal(memory.entries.some((entry) => entry.content === "代传轮次结论"), true, "the whole work+remember round finished");

  // The settled anchor is forkable.
  const anchors = readTopicSettledAnchors(session.manager);
  assert.equal(anchors.length, 1);
  const child = await createTopicNodeWithSession({ chatHome: base.home, longAgentId: "friend", topicId: topic.topicId,
    requestId: "relay-child", title: "子节点", createdBy: "agent", integrationSummary: "从代传轮次分叉",
    parents: [{ parentNodeId: root.nodeId, anchorEntryId: anchors[0].anchorEntryId, anchorSequence: anchors[0].anchorSequence }] });
  assert.equal(child.created, true);
  assert.equal(child.graph.edges.find((edge) => edge.childNodeId === child.node.nodeId).anchorEntryId, anchors[0].anchorEntryId);
});

test("topic integration: a node turn delegates the diagnosis workflow into its frozen project", async (t) => {
  const base = await fixture(t);
  const previousHome = process.env.CHAT_HOME;
  process.env.CHAT_HOME = base.home;
  const faux = registerFauxProvider({ api: "chat-topic-diagnosis-faux", provider: "chat-topic-diagnosis-faux" });
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
  await enableTopicTool(base.home);

  // The child Workflow SDK runtime is not present in a unit process; record the dispatch the node turn
  // actually makes through the same boundary production uses.
  const calls = [];
  const { registerChatWorkflowCallRuntime } = await import("../../src/workflows/workflow-call-runtime.ts");
  registerChatWorkflowCallRuntime({
    describe: async () => { throw new Error("describe 未使用"); },
    start: async (input) => {
      calls.push(input);
      const at = new Date().toISOString();
      return { status: "completed", callId: "call-1", workflowId: input.targetWorkflowId, runId: "run-1",
        workflowInvocationId: "inv-1", sessionId: "sess-child-1", startedAt: at, completedAt: at, durationMs: 1,
        text: "诊断结果：假设A userId 未注入；假设B 按 orderId 取空未判空。", model: null };
    },
    wait: async () => { throw new Error("wait 未使用"); },
    cancel: async () => { throw new Error("cancel 未使用"); },
  });

  const { createTopic, createTopicNodeWithSession } = await import("../../src/long-agents/topics.ts");
  const { acceptLongAgentTurn, drainLongAgentTurns } = await import("../../src/long-agents/turn-queue.ts");
  const frozenProject = base.projects[0].projectId;
  const topic = (await createTopic({ chatHome: base.home, longAgentId: "friend", title: "诊断", purpose: "诊断", requestId: "pd-topic", expectedRevision: 0 })).topic;
  const node = (await createTopicNodeWithSession({ chatHome: base.home, longAgentId: "friend", topicId: topic.topicId,
    requestId: "pd-topic", title: "定位节点", createdBy: "agent", frozenProjectContext: frozenProject, sessionMemory: "off" })).node;

  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("workflow_call", { action: "start", workflowId: "problem-diagnosis",
      prompt: "定位：订单页偶发空指针，日志 userId 为 null，订单主键 orderId。",
      agents: [{ agentId: "problem-diagnoser", tools: [], skills: [] }], waitTimeoutMs: 20_000 })),
    (context) => {
      const result = context.messages.filter((message) => message.role === "toolResult").map((message) => JSON.stringify(message.content)).join("\n");
      return fauxAssistantMessage(`work：${result.includes("诊断结果") ? "已拿到问题定位结果" : "未拿到结果"}`);
    },
  ]);
  await acceptLongAgentTurn({ chatHome: base.home, longAgentId: "friend", requireInteractionRevision: false, projectId: "friend",
    turnId: "pd-turn-1", text: "请定位这个空指针", source: "chat-web", topicNode: { topicId: topic.topicId, nodeId: node.nodeId } });
  await drainLongAgentTurns(base.home, "friend", node.sessionId);

  const turn = (await readLongAgentState(base.home)).turns.find((candidate) => candidate.turnId === "chat-web:friend:pd-turn-1");
  assert.equal(turn.status, "completed");
  assert.equal(turn.contextProjectId, frozenProject, "the node turn froze the node's project context");
  assert.equal(calls.length, 1, "the node turn delegated exactly once");
  assert.equal(calls[0].targetWorkflowId, "problem-diagnosis");
  assert.equal(calls[0].projectId, frozenProject, "the child Workflow runs in the node's frozen collaboration project");
  assert.equal(calls[0].parentProjectId, "friend", "the parent storage project stays the Long Agent home");
  assert.equal(calls[0].parentWorkflowId, "long-agent:friend");
});

test("topic integration: two queued relays each execute their own frozen message", async (t) => {
  const base = await fixture(t);
  const previousHome = process.env.CHAT_HOME;
  process.env.CHAT_HOME = base.home;
  const faux = registerFauxProvider({ api: "chat-topic-two-relay-faux", provider: "chat-topic-two-relay-faux" });
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
  await enableTopicTool(base.home);

  const { createTopic, createTopicNodeWithSession } = await import("../../src/long-agents/topics.ts");
  const { TOPIC_MANAGE_TOOL_PROVIDER } = await import("../../src/tools/builtins/topic-manage/index.ts");
  const { acceptLongAgentTurn, drainLongAgentTurns } = await import("../../src/long-agents/turn-queue.ts");
  const { openChatSession } = await import("../../src/chat-session.ts");
  const { collectTopicRoundMarkers } = await import("../../src/long-agents/topic-anchor.ts");
  const topic = (await createTopic({ chatHome: base.home, longAgentId: "friend", title: "双代传", purpose: "双代传", requestId: "two-relay-topic", expectedRevision: 0 })).topic;
  const node = (await createTopicNodeWithSession({ chatHome: base.home, longAgentId: "friend", topicId: topic.topicId,
    requestId: "two-relay-topic", title: "根节点", createdBy: "agent", sessionMemory: "off" })).node;

  // Write-only relay staging (no longAgentTurnId): both requests persist as durable INTENTS before any
  // round runs; no native message exists yet.
  const writer = TOPIC_MANAGE_TOOL_PROVIDER.create({ purpose: "execution", projectId: "friend", chatHome: base.home, cwd: base.home,
    sessionManager: { getSessionId: () => "sess-relay-caller" }, sessionId: "sess-relay-caller", agentId: "friend", longAgentId: "friend" });
  const first = (await writer.execute("c1", { operation: "relay", targetNodeId: node.nodeId, requestId: "relay-a", text: "第一条代传" })).details;
  const second = (await writer.execute("c2", { operation: "relay", targetNodeId: node.nodeId, requestId: "relay-b", text: "第二条代传" })).details;
  assert.equal(first.created, true);
  assert.equal(second.created, true);
  const staged = await openChatSession({ chatHome: base.home, projectId: "friend", sessionId: node.sessionId });
  assert.equal(staged.manager.getEntries().filter((entry) => entry.message?.chatTopicRelay).length, 0,
    "no native message is written before its round runs");
  // Both rounds are accepted BEFORE either executes.
  await acceptLongAgentTurn({ chatHome: base.home, longAgentId: "friend", requireInteractionRevision: false, projectId: "friend",
    turnId: "relay-a", text: "第一条代传", source: "chat-web", topicNode: { topicId: topic.topicId, nodeId: node.nodeId }, relayIntentEntryId: first.intentEntryId });
  await acceptLongAgentTurn({ chatHome: base.home, longAgentId: "friend", requireInteractionRevision: false, projectId: "friend",
    turnId: "relay-b", text: "第二条代传", source: "chat-web", topicNode: { topicId: topic.topicId, nodeId: node.nodeId }, relayIntentEntryId: second.intentEntryId });
  faux.setResponses([fauxAssistantMessage("答第一条"), fauxAssistantMessage("答第二条")]);
  await drainLongAgentTurns(base.home, "friend", node.sessionId);

  const session = await openChatSession({ chatHome: base.home, projectId: "friend", sessionId: node.sessionId });
  // Exactly ONE authoritative native message per request (whole file), both on the active branch.
  const relayMessages = session.manager.getEntries().filter((entry) => entry.type === "message" && entry.message?.chatTopicRelay);
  assert.equal(relayMessages.length, 2, "the whole session file holds exactly two relayed messages");
  // Forkability only reads the CURRENT branch: both queued relays must be complete rounds there.
  const branch = session.manager.getBranch();
  const textOf = (entry) => JSON.stringify(entry.message?.content ?? "");
  const branchUsers = branch.filter((entry) => entry.type === "message" && entry.message?.role === "user");
  const branchAssistants = branch.filter((entry) => entry.type === "message" && entry.message?.role === "assistant");
  assert.equal(branchUsers.length, 2, "both relayed messages are on the ACTIVE branch");
  assert.equal(branchAssistants.length >= 2, true, "both rounds produced an answer on the active branch");
  assert.equal(branchUsers.some((entry) => textOf(entry).includes("第一条代传")), true);
  assert.equal(branchUsers.some((entry) => textOf(entry).includes("第二条代传")), true);
  const anchors = readTopicSettledAnchors(session.manager);
  assert.equal(anchors.length, 2, "readTopicSettledAnchors returns BOTH queued relays on the current branch");
  const anchorTexts = anchors.map((anchor) => textOf(branch.find((entry) => entry.id === anchor.anchorEntryId)));
  assert.equal(anchorTexts.some((text) => text.includes("第一条代传")), true, "round A is forkable");
  assert.equal(anchorTexts.some((text) => text.includes("第二条代传")), true, "round B is forkable");
  const turnA = (await readLongAgentState(base.home)).turns.find((candidate) => candidate.turnId === "chat-web:friend:relay-a");
  assert.equal(turnA.status, "completed");
  // Both requests replay after completion with created:false against their one native message.
  const replayA = (await writer.execute("c1b", { operation: "relay", targetNodeId: node.nodeId, requestId: "relay-a", text: "第一条代传" })).details;
  const replayB = (await writer.execute("c2b", { operation: "relay", targetNodeId: node.nodeId, requestId: "relay-b", text: "第二条代传" })).details;
  assert.equal(replayA.created, false);
  assert.equal(replayB.created, false);
  assert.equal([replayA.userEntryId, replayB.userEntryId].sort().join(","), relayMessages.map((entry) => entry.id).sort().join(","));
  assert.equal(session.manager.getEntries().filter((entry) => entry.type === "message" && entry.message?.chatTopicRelay).length, 2,
    "replaying never appends a third relayed message");
});

test("topic integration: a node POST with a frozen project replays instead of conflicting", async (t) => {
  const base = await fixture(t);
  const previousHome = process.env.CHAT_HOME;
  process.env.CHAT_HOME = base.home;
  const faux = registerFauxProvider({ api: "chat-topic-frozen-replay-faux", provider: "chat-topic-frozen-replay-faux" });
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
  await enableTopicTool(base.home);

  const { createTopic, createTopicNodeWithSession } = await import("../../src/long-agents/topics.ts");
  const { drainLongAgentTurns } = await import("../../src/long-agents/turn-queue.ts");
  const frozenProject = base.projects[0].projectId;
  const topic = (await createTopic({ chatHome: base.home, longAgentId: "friend", title: "冻结项目", purpose: "冻结项目", requestId: "frozen-topic", expectedRevision: 0 })).topic;
  const node = (await createTopicNodeWithSession({ chatHome: base.home, longAgentId: "friend", topicId: topic.topicId,
    requestId: "frozen-topic", title: "根节点", createdBy: "agent", frozenProjectContext: frozenProject, sessionMemory: "off" })).node;

  const app = await router();
  const call = (requestPath, init) => app.fetch(new Request(`http://chat.test${requestPath}`, init));
  const messagePath = `/api/long-agents/friend/topics/${topic.topicId}/nodes/${node.nodeId}/messages`;
  const body = JSON.stringify({ schemaVersion: 1, requestId: "frozen-replay-1", text: "开始定位" });
  faux.setResponses([fauxAssistantMessage("work：已定位")]);
  const first = await call(messagePath, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  assert.equal(first.status, 202, await first.clone().text());
  // The SAME node POST must be a replay even though the node carries a non-null frozen project: the
  // first acceptance records the frozen project, so the retry must compare the same value.
  const second = await call(messagePath, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  assert.equal(second.status, 202, `expected replay, got ${String(second.status)}: ${await second.clone().text()}`);
  const turns = (await readLongAgentState(base.home)).turns.filter((candidate) => candidate.requestId === "frozen-replay-1");
  assert.equal(turns.length, 1, "the replay did not create a second turn");
  assert.equal(turns[0].contextProjectId, frozenProject, "the frozen project was recorded at acceptance");
  await drainLongAgentTurns(base.home, "friend", node.sessionId);
});

test("R4 supplemental integration: one confirmed action writes the product and the parent edge, idempotently", async (t) => {
  const base = await fixture(t);
  const previousHome = process.env.CHAT_HOME;
  process.env.CHAT_HOME = base.home;
  const faux = registerFauxProvider({ api: "chat-topic-r4-faux", provider: "chat-topic-r4-faux" });
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
  await enableTopicTool(base.home);

  const { createTopic, createTopicNodeWithSession, readTopicGraph, supplementTopicChildIntegration } = await import("../../src/long-agents/topics.ts");
  const { acceptLongAgentTurn, drainLongAgentTurns } = await import("../../src/long-agents/turn-queue.ts");
  const { openChatSession } = await import("../../src/chat-session.ts");
  const topic = (await createTopic({ chatHome: base.home, longAgentId: "friend", title: "补充整合", purpose: "补充整合", requestId: "r4-topic", expectedRevision: 0 })).topic;
  const root = (await createTopicNodeWithSession({ chatHome: base.home, longAgentId: "friend", topicId: topic.topicId,
    requestId: "r4-topic", title: "根节点", createdBy: "agent", sessionMemory: "off" })).node;
  const parent = (await createTopicNodeWithSession({ chatHome: base.home, longAgentId: "friend", topicId: topic.topicId,
    requestId: "r4-parent", title: "父节点", createdBy: "agent", sessionMemory: "off", parents: [{ parentNodeId: root.nodeId }] })).node;
  const child = (await createTopicNodeWithSession({ chatHome: base.home, longAgentId: "friend", topicId: topic.topicId,
    requestId: "r4-child", title: "子节点", createdBy: "agent", sessionMemory: "off", parents: [{ parentNodeId: root.nodeId }] })).node;

  // A real settled anchor on the parent.
  faux.setResponses([fauxAssistantMessage("父节点第一轮")]);
  await acceptLongAgentTurn({ chatHome: base.home, longAgentId: "friend", requireInteractionRevision: false, projectId: "friend",
    turnId: "r4-parent-turn", text: "父节点问题", source: "chat-web", topicNode: { topicId: topic.topicId, nodeId: parent.nodeId } });
  await drainLongAgentTurns(base.home, "friend", parent.sessionId);
  const parentSession = await openChatSession({ chatHome: base.home, projectId: "friend", sessionId: parent.sessionId });
  const anchor = readTopicSettledAnchors(parentSession.manager).at(-1);
  assert.notEqual(anchor, undefined);

  // The action refuses anything that is not a trusted user confirmation.
  await assert.rejects(supplementTopicChildIntegration({ chatHome: base.home, longAgentId: "friend", childNodeId: child.nodeId,
    parentNodeId: parent.nodeId, anchorEntryId: anchor.anchorEntryId, anchorSequence: anchor.anchorSequence,
    requestId: "r4-supp-1", product: { kind: "memory", content: "补充结论" }, confirmedBy: "agent" }), /用户确认/);

  const input = { chatHome: base.home, longAgentId: "friend", childNodeId: child.nodeId, parentNodeId: parent.nodeId,
    anchorEntryId: anchor.anchorEntryId, anchorSequence: anchor.anchorSequence, requestId: "r4-supp-1",
    product: { kind: "memory", content: "补充整合结论" }, confirmedBy: "user" };
  const first = await supplementTopicChildIntegration(input);
  assert.equal(first.created, true);
  assert.equal(first.product.kind, "memory");
  assert.equal(first.edge.parentNodeId, parent.nodeId);
  assert.equal(first.edge.anchorEntryId, anchor.anchorEntryId);
  // The child session carries the confirmation record and the memory entry with the request identity.
  const childSession = await openChatSession({ chatHome: base.home, projectId: "friend", sessionId: child.sessionId });
  assert.equal(childSession.manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "chat.topic-supplement.v1"), true);
  const memory = await readSessionMemory(base.home, "friend", child.sessionId);
  assert.equal(memory.entries.filter((entry) => entry.writeRequestId === "r4-supp-1").length, 1);
  assert.equal(memory.entries.find((entry) => entry.writeRequestId === "r4-supp-1").content, "补充整合结论");

  // A retry of the SAME request identity completes without duplicating memory, confirmation or edge.
  const retry = await supplementTopicChildIntegration(input);
  assert.equal(retry.created, false, "the edge replay is not a new edge");
  // The request id freezes the WHOLE action: changing the parent, the anchor or the product conflicts.
  await assert.rejects(supplementTopicChildIntegration({ ...input, parentNodeId: root.nodeId }), /补充整合动作/);
  await assert.rejects(supplementTopicChildIntegration({ ...input, anchorSequence: anchor.anchorSequence + 1 }), /补充整合动作/);
  await assert.rejects(supplementTopicChildIntegration({ ...input, source: { storageProjectId: "friend", sessionId: "sess-other", entryId: "entry-other" } }), /补充整合动作/);
  await assert.rejects(supplementTopicChildIntegration({ ...input, product: { kind: "memory", content: "换了内容" } }), /补充整合动作/);
  await assert.rejects(supplementTopicChildIntegration({ ...input, product: { kind: "relay", text: "补充整合结论" } }), /补充整合动作/);
  const retryMemory = await readSessionMemory(base.home, "friend", child.sessionId);
  assert.equal(retryMemory.entries.filter((entry) => entry.writeRequestId === "r4-supp-1").length, 1, "no second memory entry");
  // The conflicting replays must not have produced a second edge or a second confirmation.
  const graph = await readTopicGraph(base.home, "friend");
  assert.equal(graph.edges.filter((edge) => edge.parentNodeId === parent.nodeId && edge.childNodeId === child.nodeId).length, 1, "one R4 edge");
  assert.equal(graph.edges.filter((edge) => edge.childNodeId === child.nodeId).length, 2, "only the creation edge and the R4 edge exist");
  assert.equal(childSession.manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "chat.topic-supplement.v1").length, 1, "one confirmation record");

  // A relay product on a different child is also idempotent (durable intent).
  const relayChild = (await createTopicNodeWithSession({ chatHome: base.home, longAgentId: "friend", topicId: topic.topicId,
    requestId: "r4-child-2", title: "子节点2", createdBy: "agent", sessionMemory: "off", parents: [{ parentNodeId: root.nodeId }] })).node;
  const relayed = await supplementTopicChildIntegration({ chatHome: base.home, longAgentId: "friend", childNodeId: relayChild.nodeId,
    parentNodeId: parent.nodeId, anchorEntryId: anchor.anchorEntryId, anchorSequence: anchor.anchorSequence,
    requestId: "r4-supp-2", product: { kind: "relay", text: "补充代传" }, confirmedBy: "user" });
  assert.equal(relayed.product.kind, "relay");
  const relayedAgain = await supplementTopicChildIntegration({ chatHome: base.home, longAgentId: "friend", childNodeId: relayChild.nodeId,
    parentNodeId: parent.nodeId, anchorEntryId: anchor.anchorEntryId, anchorSequence: anchor.anchorSequence,
    requestId: "r4-supp-2", product: { kind: "relay", text: "补充代传" }, confirmedBy: "user" });
  assert.equal(relayedAgain.product.intentEntryId, relayed.product.intentEntryId);
});

test("R4 relay: the confirmed action RUNS the node round, settles an anchor, and resumes both interruptions", async (t) => {
  const base = await fixture(t);
  const previousHome = process.env.CHAT_HOME;
  process.env.CHAT_HOME = base.home;
  const faux = registerFauxProvider({ api: "chat-topic-r4-relay-faux", provider: "chat-topic-r4-relay-faux" });
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
  await enableTopicTool(base.home);

  const { createTopic, createTopicNodeWithSession, readTopicGraph, relayTopicNodeMessage } = await import("../../src/long-agents/topics.ts");
  const { acceptLongAgentTurn, drainLongAgentTurns } = await import("../../src/long-agents/turn-queue.ts");
  const { openChatSession } = await import("../../src/chat-session.ts");
  const { readSessionMemory } = await import("../../src/long-agents/session-memory.ts");
  const { readTopicSettledAnchors } = await import("../../src/long-agents/topic-anchor.ts");
  const { readLongAgentState } = await import("../../src/long-agents/storage.ts");

  const topic = (await createTopic({ chatHome: base.home, longAgentId: "friend", title: "R4代传", purpose: "R4代传", requestId: "r4r-topic", expectedRevision: 0 })).topic;
  const root = (await createTopicNodeWithSession({ chatHome: base.home, longAgentId: "friend", topicId: topic.topicId,
    requestId: "r4r-topic", title: "根节点", createdBy: "agent", sessionMemory: "off" })).node;
  const parent = (await createTopicNodeWithSession({ chatHome: base.home, longAgentId: "friend", topicId: topic.topicId,
    requestId: "r4r-parent", title: "父节点", createdBy: "agent", sessionMemory: "off", parents: [{ parentNodeId: root.nodeId }] })).node;
  const childA = (await createTopicNodeWithSession({ chatHome: base.home, longAgentId: "friend", topicId: topic.topicId,
    requestId: "r4r-a", title: "子节点A", createdBy: "agent", sessionMemory: "on", parents: [{ parentNodeId: root.nodeId }] })).node;
  const childB = (await createTopicNodeWithSession({ chatHome: base.home, longAgentId: "friend", topicId: topic.topicId,
    requestId: "r4r-b", title: "子节点B", createdBy: "agent", sessionMemory: "on", parents: [{ parentNodeId: root.nodeId }] })).node;
  const childC = (await createTopicNodeWithSession({ chatHome: base.home, longAgentId: "friend", topicId: topic.topicId,
    requestId: "r4r-c", title: "子节点C", createdBy: "agent", sessionMemory: "on", parents: [{ parentNodeId: root.nodeId }] })).node;

  // One real settled anchor on the parent (its own round), then one work+remember round per child.
  faux.setResponses([
    fauxAssistantMessage("父节点第一轮"),
    fauxAssistantMessage("work：已按补充代传 A 继续"), fauxAssistantMessage(fauxToolCall("session_memory", { operation: "write", purpose: "finding", author: "agent", content: "R4代传结论A", expectedRevision: 0 })), fauxAssistantMessage("已记住"),
    fauxAssistantMessage("work：已按补充代传 B 继续"), fauxAssistantMessage(fauxToolCall("session_memory", { operation: "write", purpose: "finding", author: "agent", content: "R4代传结论B", expectedRevision: 0 })), fauxAssistantMessage("已记住"),
    fauxAssistantMessage("work：已按补充代传 C 继续"), fauxAssistantMessage(fauxToolCall("session_memory", { operation: "write", purpose: "finding", author: "agent", content: "R4代传结论C", expectedRevision: 0 })), fauxAssistantMessage("已记住"),
  ]);
  await acceptLongAgentTurn({ chatHome: base.home, longAgentId: "friend", requireInteractionRevision: false, projectId: "friend",
    turnId: "r4r-parent-turn", text: "父节点问题", source: "chat-web", topicNode: { topicId: topic.topicId, nodeId: parent.nodeId } });
  await drainLongAgentTurns(base.home, "friend", parent.sessionId);
  const parentSession = await openChatSession({ chatHome: base.home, projectId: "friend", sessionId: parent.sessionId });
  const anchor = readTopicSettledAnchors(parentSession.manager).at(-1);
  assert.notEqual(anchor, undefined, "the parent has a settled anchor");

  const app = await router();
  const call = (requestPath, init) => app.fetch(new Request(`http://chat.test${requestPath}`, init));
  const supplement = (childNodeId, requestId, text, extra = {}) => call(
    `/api/long-agents/friend/topics/${topic.topicId}/nodes/${childNodeId}/supplements`,
    { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, requestId, parentNodeId: parent.nodeId, anchorEntryId: anchor.anchorEntryId,
        anchorSequence: anchor.anchorSequence, product: { kind: "relay", text }, ...extra }) });
  const countFacts = async (childNodeId, requestId, sessionId) => {
    const session = await openChatSession({ chatHome: base.home, projectId: "friend", sessionId });
    const relayMessages = session.manager.getEntries().filter((entry) => entry.type === "message"
      && entry.message?.role === "user" && entry.message?.chatTopicRelay?.requestId === requestId);
    const intents = session.manager.getEntries().filter((entry) => entry.type === "custom"
      && entry.customType === "chat.topic-relay-intent" && entry.data?.requestId === requestId);
    const confirmations = session.manager.getEntries().filter((entry) => entry.type === "custom"
      && entry.customType === "chat.topic-supplement.v1" && entry.data?.requestId === requestId);
    const turns = (await readLongAgentState(base.home)).turns.filter((candidate) => candidate.requestId === `relay:${requestId}`);
    const graph = await readTopicGraph(base.home, "friend");
    const edges = graph.edges.filter((edge) => edge.parentNodeId === parent.nodeId && edge.childNodeId === childNodeId);
    return { session, relayMessages, intents, confirmations, turns, edges };
  };

  // (1) Happy path: the owner-confirmed relay is accepted (queryable turn id + status) and RUNS.
  const responseA = await supplement(childA.nodeId, "r4r-relay-a", "补充代传给A");
  assert.equal(responseA.status, 201);
  const bodyA = await responseA.json();
  assert.equal(bodyA.product.kind, "relay");
  assert.equal(typeof bodyA.product.turnId, "string", "the response exposes a queryable turn id");
  assert.equal(["queued", "running", "completed"].includes(bodyA.product.turnStatus), true, `accepted: ${bodyA.product.turnStatus}`);
  await drainLongAgentTurns(base.home, "friend", childA.sessionId);
  const turnA = await (await call(`/api/long-agents/friend/turns/${bodyA.product.turnId}`)).json();
  assert.equal(turnA.execution.status, "completed");
  const factsA = await countFacts(childA.nodeId, "r4r-relay-a", childA.sessionId);
  assert.equal(factsA.relayMessages.length, 1, "the relayed round appended exactly one native user message");
  assert.equal(factsA.intents.length, 1);
  assert.equal(factsA.confirmations.length, 1);
  assert.equal(factsA.turns.length, 1, "exactly one turn for the request id");
  assert.equal(factsA.turns[0].status, "completed");
  assert.equal(factsA.edges.length, 1, "one R4 edge");
  assert.equal((await readSessionMemory(base.home, "friend", childA.sessionId)).entries.some((entry) => entry.content === "R4代传结论A"), true,
    "the relay round's work+remember reached a terminal state");
  assert.equal(readTopicSettledAnchors(factsA.session.manager).length, 1, "the relay round settled an anchor");

  // (2) Retry the same identity: it completes the missing steps and adds NOTHING new.
  const retryA = await supplement(childA.nodeId, "r4r-relay-a", "补充代传给A");
  assert.equal(retryA.status, 201);
  const retryBodyA = await retryA.json();
  assert.equal(retryBodyA.created, false, "the edge replay is not a new edge");
  assert.equal(retryBodyA.product.intentEntryId, bodyA.product.intentEntryId);
  assert.equal(retryBodyA.product.turnId, bodyA.product.turnId);
  await drainLongAgentTurns(base.home, "friend", childA.sessionId);
  const afterRetryA = await countFacts(childA.nodeId, "r4r-relay-a", childA.sessionId);
  assert.equal(afterRetryA.relayMessages.length, 1);
  assert.equal(afterRetryA.intents.length, 1);
  assert.equal(afterRetryA.confirmations.length, 1);
  assert.equal(afterRetryA.turns.length, 1);
  assert.equal(afterRetryA.edges.length, 1);
  assert.equal(readTopicSettledAnchors(afterRetryA.session.manager).length, 1, "no extra round ran");

  // (3) Changing the source, the body or the product kind under the same id is a conflict.
  assert.equal((await supplement(childA.nodeId, "r4r-relay-a", "补充代传给A",
    { source: { storageProjectId: "friend", sessionId: "sess-x", entryId: "entry-x" } })).status, 409);
  assert.equal((await supplement(childA.nodeId, "r4r-relay-a", "换了正文")).status, 409);
  assert.equal((await supplement(childA.nodeId, "r4r-relay-a", "补充代传给A", { product: { kind: "memory", content: "换产物" } })).status, 409);

  // (4) Interruption AFTER the intent write but BEFORE acceptance: the retry resumes the SAME intent and runs.
  const stagedB = await relayTopicNodeMessage({ chatHome: base.home, longAgentId: "friend", nodeId: childB.nodeId, requestId: "r4r-relay-b", text: "补充代传给B" });
  assert.equal(stagedB.created, true);
  assert.equal((await readLongAgentState(base.home)).turns.some((candidate) => candidate.requestId === "relay:r4r-relay-b"), false, "no turn exists after the intent write");
  const responseB = await supplement(childB.nodeId, "r4r-relay-b", "补充代传给B");
  assert.equal(responseB.status, 201);
  assert.equal((await responseB.json()).product.intentEntryId, stagedB.intentEntryId, "the retry reuses the durable intent");
  await drainLongAgentTurns(base.home, "friend", childB.sessionId);
  const factsB = await countFacts(childB.nodeId, "r4r-relay-b", childB.sessionId);
  assert.equal(factsB.relayMessages.length, 1);
  assert.equal(factsB.intents.length, 1);
  assert.equal(factsB.turns.length, 1);
  assert.equal(factsB.turns[0].status, "completed");
  assert.equal(factsB.edges.length, 1);
  assert.equal((await readSessionMemory(base.home, "friend", childB.sessionId)).entries.some((entry) => entry.content === "R4代传结论B"), true);

  // (5) Interruption AFTER acceptance but BEFORE execution: the retry must not create a second turn.
  const stagedC = await relayTopicNodeMessage({ chatHome: base.home, longAgentId: "friend", nodeId: childC.nodeId, requestId: "r4r-relay-c", text: "补充代传给C" });
  await acceptLongAgentTurn({ chatHome: base.home, longAgentId: "friend", requireInteractionRevision: false, projectId: "friend",
    turnId: "relay:r4r-relay-c", text: "补充代传给C", source: "chat-web",
    topicNode: { topicId: topic.topicId, nodeId: childC.nodeId }, relayIntentEntryId: stagedC.intentEntryId });
  const responseC = await supplement(childC.nodeId, "r4r-relay-c", "补充代传给C");
  assert.equal(responseC.status, 201);
  assert.equal((await readLongAgentState(base.home)).turns.filter((candidate) => candidate.requestId === "relay:r4r-relay-c").length, 1,
    "acceptance deduped: no second turn");
  await drainLongAgentTurns(base.home, "friend", childC.sessionId);
  const factsC = await countFacts(childC.nodeId, "r4r-relay-c", childC.sessionId);
  assert.equal(factsC.relayMessages.length, 1);
  assert.equal(factsC.intents.length, 1);
  assert.equal(factsC.confirmations.length, 1);
  assert.equal(factsC.turns.length, 1);
  assert.equal(factsC.turns[0].status, "completed");
  assert.equal(factsC.edges.length, 1);
  assert.equal((await readSessionMemory(base.home, "friend", childC.sessionId)).entries.some((entry) => entry.content === "R4代传结论C"), true);
});

test("steering a topic node turn keeps the node binding and the server-frozen project", async (t) => {
  const base = await fixture(t);
  const previousHome = process.env.CHAT_HOME;
  process.env.CHAT_HOME = base.home;
  t.after(() => { if (previousHome === undefined) delete process.env.CHAT_HOME; else process.env.CHAT_HOME = previousHome; });
  const { createTopic, createTopicNodeWithSession } = await import("../../src/long-agents/topics.ts");
  const { acceptLongAgentTurn } = await import("../../src/long-agents/turn-queue.ts");
  const { steerFriendTurn } = await import("../../src/long-agents/turn-controls.ts");
  const { readLongAgentState } = await import("../../src/long-agents/storage.ts");
  const topic = (await createTopic({ chatHome: base.home, longAgentId: "friend", title: "引导", purpose: "引导", requestId: "steer-topic", expectedRevision: 0 })).topic;
  const node = (await createTopicNodeWithSession({ chatHome: base.home, longAgentId: "friend", topicId: topic.topicId, requestId: "steer-topic",
    title: "根节点", createdBy: "agent", sessionMemory: "off", frozenProjectContext: "a" })).node;
  const accepted = await acceptLongAgentTurn({ chatHome: base.home, longAgentId: "friend", requireInteractionRevision: false, projectId: "friend",
    turnId: "steer-target-1", text: "第一轮", source: "chat-web", topicNode: { topicId: topic.topicId, nodeId: node.nodeId } });
  // The client claims the WRONG project; the server must derive it from the durable node turn instead.
  await steerFriendTurn(base.home, "friend", accepted.turnId, { requestId: "steer-follow-1", text: "引导一下", contextProjectId: "b" });
  const steered = (await readLongAgentState(base.home)).turns.find((turn) => turn.turnId === "chat-web:friend:steer-follow-1");
  assert.notEqual(steered, undefined, "the steering turn was accepted");
  assert.deepEqual(steered.topicNode, { topicId: topic.topicId, nodeId: node.nodeId }, "the steering turn keeps the node binding");
  assert.equal(steered.contextProjectId, "a", "the steering turn uses the node's frozen project, not the client claim");
  // A non-node turn still refuses a mismatched project claim.
  const plain = await acceptLongAgentTurn({ chatHome: base.home, longAgentId: "friend", requireInteractionRevision: false, projectId: "friend",
    turnId: "steer-plain-1", text: "普通轮", source: "chat-web", contextProjectId: "a" });
  await assert.rejects(steerFriendTurn(base.home, "friend", plain.turnId, { requestId: "steer-plain-2", text: "x", contextProjectId: "b" }), /同一项目/);
});

test("a second message queued mid-round stays in the same node session and reads the first round", async (t) => {
  const base = await fixture(t);
  const previousHome = process.env.CHAT_HOME;
  process.env.CHAT_HOME = base.home;
  const faux = registerFauxProvider({ api: "chat-topic-append-faux", provider: "chat-topic-append-faux" });
  t.after(() => { faux.unregister(); if (previousHome === undefined) delete process.env.CHAT_HOME; else process.env.CHAT_HOME = previousHome; });
  const model = faux.getModel();
  fs.writeFileSync(path.join(base.home, "agent/settings.json"), JSON.stringify({
    defaultProvider: model.provider, defaultModel: model.id, defaultThinkingLevel: "off", compaction: { enabled: false } }));
  fs.writeFileSync(path.join(base.home, "agent/models.json"), JSON.stringify({ providers: { [model.provider]: {
    baseUrl: model.baseUrl, api: model.api, apiKey: "faux-key", models: [{ id: model.id, name: model.name,
      reasoning: model.reasoning, input: model.input, cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens }] } } }));
  await enableTopicTool(base.home);
  const { createTopic, createTopicNodeWithSession } = await import("../../src/long-agents/topics.ts");
  const { acceptLongAgentTurn, drainLongAgentTurns } = await import("../../src/long-agents/turn-queue.ts");
  const { openChatSession } = await import("../../src/chat-session.ts");
  const { readLongAgentState } = await import("../../src/long-agents/storage.ts");
  const topic = (await createTopic({ chatHome: base.home, longAgentId: "friend", title: "追加", purpose: "追加", requestId: "append-topic", expectedRevision: 0 })).topic;
  const node = (await createTopicNodeWithSession({ chatHome: base.home, longAgentId: "friend", topicId: topic.topicId, requestId: "append-topic",
    title: "根节点", createdBy: "agent" })).node;
  const contexts = [];
  faux.setResponses([
    fauxAssistantMessage("第一轮答案"),
    fauxAssistantMessage(fauxToolCall("session_memory", { operation: "write", purpose: "finding", author: "agent", content: "append-m1", expectedRevision: 0 })),
    fauxAssistantMessage("m1-done"),
    (context) => { contexts.push(JSON.stringify(context.messages)); return fauxAssistantMessage("第二轮答案"); },
    fauxAssistantMessage(fauxToolCall("session_memory", { operation: "write", purpose: "finding", author: "agent", content: "append-m2", expectedRevision: 1 })),
    fauxAssistantMessage("m2-done"),
  ]);
  // Both messages are accepted while the first round is still queued/running: the second must keep the
  // node target, share the session, and never drift into the daily conversation.
  await acceptLongAgentTurn({ chatHome: base.home, longAgentId: "friend", requireInteractionRevision: false, projectId: "friend",
    turnId: "append-1", text: "第一轮问题", source: "chat-web", topicNode: { topicId: topic.topicId, nodeId: node.nodeId } });
  await acceptLongAgentTurn({ chatHome: base.home, longAgentId: "friend", requireInteractionRevision: false, projectId: "friend",
    turnId: "append-2", text: "第二轮追问", source: "chat-web", topicNode: { topicId: topic.topicId, nodeId: node.nodeId } });
  await drainLongAgentTurns(base.home, "friend", node.sessionId);
  const turns = (await readLongAgentState(base.home)).turns.filter((turn) => turn.turnId === "chat-web:friend:append-1" || turn.turnId === "chat-web:friend:append-2");
  assert.equal(turns.length, 2);
  assert.equal(turns.every((turn) => turn.status === "completed"), true, JSON.stringify(turns.map((turn) => [turn.turnId, turn.status])));
  assert.equal(turns.every((turn) => turn.topicNode?.nodeId === node.nodeId), true, "both turns keep the node target");
  assert.equal(turns.every((turn) => turn.sessionId === node.sessionId), true, "both turns run in the node session");
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].includes("第一轮答案"), true, "the second round sees the first round's answer");
  const session = await openChatSession({ chatHome: base.home, projectId: "friend", sessionId: node.sessionId });
  const userMessages = session.manager.getBranch().filter((entry) => entry.type === "message" && entry.message?.role === "user");
  const userTexts = userMessages.map((entry) => Array.isArray(entry.message.content)
    ? entry.message.content.filter((block) => block.type === "text").map((block) => block.text).join("") : entry.message.content);
  assert.deepEqual(userTexts, ["第一轮问题", "第二轮追问"], "exactly the two user messages, no duplicates");
  const dailyTurns = (await readLongAgentState(base.home)).turns.filter((turn) => turn.topicNode === undefined);
  assert.equal(dailyTurns.some((turn) => turn.text === "第二轮追问"), false, "the follow-up never reaches the daily conversation");
});
