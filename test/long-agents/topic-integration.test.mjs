import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fixture } from "./daily-fixture.mjs";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { executeLongAgentTurn } from "../../src/long-agents/runtime.ts";
import { readLongAgentState, readLongAgentRegistry, writeLongAgentRegistry } from "../../src/long-agents/storage.ts";
import { topicIntegrationIds } from "../../src/long-agents/topic-integration.ts";
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
  return app;
}

/** The integration work is an ordinary Long Agent turn, so the agent needs the topic tool assembled. */
async function enableTopicTool(home) {
  const registry = await readLongAgentRegistry(home);
  const friend = registry.agents.find((agent) => agent.id === "friend");
  friend.definition = { ...friend.definition,
    tools: { ...friend.definition.tools, addresses: ["system:tool/topic_manage"] } };
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
  faux.setResponses([fauxAssistantMessage("ack")]);
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
