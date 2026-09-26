import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fixture } from "./daily-fixture.mjs";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { readLongAgentRegistry, writeLongAgentRegistry, readLongAgentState } from "../../src/long-agents/storage.ts";
import { createTopic, createTopicNodeWithSession, relayTopicNodeMessage } from "../../src/long-agents/topics.ts";
import { readTopicSettledAnchors } from "../../src/long-agents/topic-anchor.ts";
import { openChatSession } from "../../src/chat-session.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function enableTopicTool(home) {
  const registry = await readLongAgentRegistry(home);
  const friend = registry.agents.find((agent) => agent.id === "friend");
  friend.definition = { ...friend.definition, tools: { ...friend.definition.tools, addresses: ["system:tool/topic_manage"] } };
  await writeLongAgentRegistry(registry, home);
}

/** Accepts one queued turn in a SEPARATE process, then exits without executing it. */
function acceptInChildProcess(home, kind, payload) {
  const script = `
    const { acceptLongAgentTurn } = await import("./src/long-agents/turn-queue.js");
    await acceptLongAgentTurn(${JSON.stringify({
      chatHome: home, longAgentId: "friend", requireInteractionRevision: false, projectId: "friend",
      turnId: payload.turnId, text: payload.text, source: "chat-web",
      topicNode: { topicId: payload.topicId, nodeId: payload.nodeId },
      ...(payload.relayIntentEntryId === undefined ? {} : { relayIntentEntryId: payload.relayIntentEntryId }),
    })});
    console.log("ACCEPTED");
  `;
  const result = spawnSync(process.execPath, ["--import", "./scripts/typescript-test-loader.mjs", "--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: repo, env: { ...process.env, CHAT_HOME: home }, encoding: "utf8",
  });
  assert.equal(result.status, 0, `${kind} child process failed: ${result.stderr}`);
  assert.match(result.stdout, /ACCEPTED/);
}

test("cross-process recovery: a node turn and a relay accepted in another process both complete here", async (t) => {
  const base = await fixture(t);
  const previousHome = process.env.CHAT_HOME;
  process.env.CHAT_HOME = base.home;
  const faux = registerFauxProvider({ api: "chat-topic-restart-faux", provider: "chat-topic-restart-faux" });
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

  const topic = (await createTopic({ chatHome: base.home, longAgentId: "friend", title: "跨进程", purpose: "跨进程", requestId: "restart-topic", expectedRevision: 0 })).topic;
  const node = (await createTopicNodeWithSession({ chatHome: base.home, longAgentId: "friend", topicId: topic.topicId,
    requestId: "restart-topic", title: "根节点", createdBy: "agent", sessionMemory: "off" })).node;

  // Both turns are ACCEPTED (queued, durable) by a different process that then exits.
  acceptInChildProcess(base.home, "node turn", { turnId: "restart-node-1", text: "跨进程节点轮次", topicId: topic.topicId, nodeId: node.nodeId });
  const intent = await relayTopicNodeMessage({ chatHome: base.home, longAgentId: "friend", nodeId: node.nodeId, requestId: "restart-relay-1", text: "跨进程代传" });
  acceptInChildProcess(base.home, "relay turn", { turnId: "restart-relay-1", text: "跨进程代传", topicId: topic.topicId, nodeId: node.nodeId, relayIntentEntryId: intent.intentEntryId });

  // A fresh process (this one) drains solely from durable state.
  const queued = (await readLongAgentState(base.home)).turns.filter((turn) => turn.topicNode !== undefined);
  assert.equal(queued.filter((turn) => turn.status === "queued").length, 2, "both turns are durable before execution");
  faux.setResponses([fauxAssistantMessage("跨进程节点答案"), fauxAssistantMessage("跨进程代传答案")]);
  const { drainLongAgentTurns } = await import("../../src/long-agents/turn-queue.ts");
  await drainLongAgentTurns(base.home, "friend", node.sessionId);

  const settled = (await readLongAgentState(base.home)).turns.filter((turn) => turn.topicNode !== undefined);
  assert.equal(settled.every((turn) => turn.status === "completed"), true, JSON.stringify(settled.map((turn) => [turn.turnId, turn.status, turn.error])));
  const session = await openChatSession({ chatHome: base.home, projectId: "friend", sessionId: node.sessionId });
  const userMessages = session.manager.getEntries().filter((entry) => entry.type === "message" && entry.message?.role === "user");
  assert.equal(userMessages.length, 2, "the node turn prompted one message; the relay appended exactly one");
  assert.equal(userMessages.filter((entry) => entry.message?.chatTopicRelay?.requestId === "restart-relay-1").length, 1);
  const anchors = readTopicSettledAnchors(session.manager);
  assert.equal(anchors.length, 2, "both recovered rounds are forkable on the current branch");
});
