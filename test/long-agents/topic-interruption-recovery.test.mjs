import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixture } from "./daily-fixture.mjs";
import { readLongAgentRegistry, writeLongAgentRegistry, readLongAgentState } from "../../src/long-agents/storage.ts";
import { createTopic, createTopicNodeWithSession, relayTopicNodeMessage } from "../../src/long-agents/topics.ts";
import { readTopicSettledAnchors, collectTopicRoundMarkers } from "../../src/long-agents/topic-anchor.ts";
import { openChatSession } from "../../src/chat-session.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function enableTopicTool(home) {
  const registry = await readLongAgentRegistry(home);
  const friend = registry.agents.find((agent) => agent.id === "friend");
  friend.definition = { ...friend.definition, tools: { ...friend.definition.tools, addresses: ["system:tool/topic_manage"] } };
  await writeLongAgentRegistry(registry, home);
}

/**
 * A parent-controlled OpenAI-compatible model server. It can HANG on one phase so the test can SIGKILL a
 * worker mid-round: on the `work` phase, on the first `remember` call, or on the `remember` call AFTER
 * the writer's `session_memory` write has landed.
 */
function startModelServer(options = {}) {
  const requests = [];
  let hangMode = null;
  let hangResolve = null;
  const waitForHang = () => new Promise((resolve) => { hangResolve = resolve; });
  const frame = (delta, finish) => JSON.stringify({ id: "chatcmpl-recovery", object: "chat.completion.chunk", created: 0, model: "recovery-model",
    choices: [{ index: 0, delta, finish_reason: finish }], ...(finish === "stop" ? { usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } } : {}) });
  const writeText = (response, text) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`data: ${frame({ role: "assistant", content: text }, null)}\n\n`);
    response.write(`data: ${frame({}, "stop")}\n\n`);
    response.end("data: [DONE]\n\n");
  };
  const writeToolCall = (response, name, args) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "chatcmpl-recovery-tool", object: "chat.completion.chunk", created: 0, model: "recovery-model",
      choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call-${String(Math.random()).slice(2)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "chatcmpl-recovery-tool", object: "chat.completion.chunk", created: 0, model: "recovery-model",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  };
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const systemText = messages.filter((message) => message.role === "system").map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "")).join("\n");
    const phase = systemText.includes("只负责维护") ? "remember" : "work";
    const hang = () => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`data: ${frame({ role: "assistant", content: "HANGING" }, null)}\n\n`);
      hangResolve?.(phase);
    };
    // The writer's own context is projected to the CURRENT round, so counting its session_memory calls
    // tells us exactly which step it is on: 0 = list, 1 = write, 2 = reply.
    const writerOperations = messages.flatMap((message) => message.role === "assistant" && Array.isArray(message.tool_calls)
      ? message.tool_calls.filter((call) => call.function?.name === "session_memory").map((call) => JSON.parse(call.function.arguments ?? "{}").operation)
      : []);
    requests.push({ phase, operations: writerOperations });
    if (phase === "remember" && writerOperations.length === 0) await options.onRememberFirst?.();
    if (phase === "work") {
      if (hangMode === "work") { hang(); return; }
      writeText(response, "WORK_RESULT");
      return;
    }
    const toolTextOf = (message) => Array.isArray(message.content)
      ? message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")
      : String(message.content ?? "");
    const lastToolText = [...messages].reverse().find((message) => message.role === "tool");
    if (hangMode === "remember-first" && writerOperations.length === 0) { hang(); return; }
    if (hangMode === "remember-after-write" && writerOperations.length >= 2) { hang(); return; }
    if (writerOperations.length === 0) {
      writeToolCall(response, "session_memory", { operation: "list" });
      return;
    }
    if (writerOperations.length === 1) {
      const revision = /"revision":(\d+)/.exec(lastToolText === undefined ? "" : toolTextOf(lastToolText))?.[1] ?? "0";
      writeToolCall(response, "session_memory", { operation: "write", purpose: "finding", author: "agent", content: "RECOVERY_MEMORY", expectedRevision: Number(revision) });
      return;
    }
    writeText(response, "记忆已写入");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    resolve({
      url: `http://127.0.0.1:${address.port}/v1`, requests,
      setHang: (mode) => { hangMode = mode; },
      waitForHang,
      close: async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); },
    });
  }));
}

/** A child process that drains one node session, so it can be SIGKILLed in the middle of a round. */
function spawnWorker(home, sessionId) {
  const script = `
    const { drainLongAgentTurns } = await import("./src/long-agents/turn-queue.js");
    await drainLongAgentTurns(process.env.CHAT_HOME, "friend", process.env.TARGET_SESSION);
    console.log("DRAINED");
  `;
  const child = spawn(process.execPath, ["--import", "./scripts/typescript-test-loader.mjs", "--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: repo, env: { ...process.env, CHAT_HOME: home, TARGET_SESSION: sessionId }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  return { child, outputOf: () => output, exited: new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))) };
}

/** Point the isolated home at the test's model server, enable the topic tool, and create one topic. */
async function prepare(home, modelUrl, t) {
  const previous = process.env.CHAT_HOME;
  process.env.CHAT_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.CHAT_HOME; else process.env.CHAT_HOME = previous; });
  fs.writeFileSync(path.join(home, "agent/settings.json"), JSON.stringify({
    defaultProvider: "recovery-local", defaultModel: "recovery-model", defaultThinkingLevel: "off", retry: { enabled: false }, compaction: { enabled: false } }));
  fs.writeFileSync(path.join(home, "agent/models.json"), JSON.stringify({ providers: { "recovery-local": {
    baseUrl: modelUrl, api: "openai-completions", apiKey: "local-test",
    models: [{ id: "recovery-model", name: "Recovery Model", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 1_024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  await enableTopicTool(home);
  const topic = (await createTopic({ chatHome: home, longAgentId: "friend", title: "中断恢复", purpose: "中断恢复", requestId: "recovery-topic", expectedRevision: 0 })).topic;
  // A parentless node is the topic root and must share the topic's requestId.
  const node = (await createTopicNodeWithSession({ chatHome: home, longAgentId: "friend", topicId: topic.topicId,
    requestId: "recovery-topic", title: "根节点", createdBy: "agent" })).node;
  return { topic, node };
}

async function nodeFacts(home, node) {
  const session = await openChatSession({ chatHome: home, projectId: "friend", sessionId: node.sessionId });
  const { readSessionMemory } = await import("../../src/long-agents/session-memory.ts");
  return {
    anchors: readTopicSettledAnchors(session.manager).length,
    roundMarkers: collectTopicRoundMarkers(session.manager.getBranch()).map((marker) => marker.status),
    memory: (await readSessionMemory(home, "friend", node.sessionId)).entries.length,
    userMessages: session.manager.getBranch().filter((entry) => entry.type === "message" && entry.message?.role === "user").length,
  };
}

test("mid-work interruption: recovery marks the round interrupted, settles nothing, and duplicates nothing", async (t) => {
  const base = await fixture(t);
  const server = await startModelServer();
  t.after(() => server.close());
  const { topic, node } = await prepare(base.home, server.url, t);
  const before = await nodeFacts(base.home, node);
  server.setHang("work");
  const hang = server.waitForHang();
  const { acceptLongAgentTurn } = await import("../../src/long-agents/turn-queue.ts");
  await acceptLongAgentTurn({ chatHome: base.home, longAgentId: "friend", requireInteractionRevision: false, projectId: "friend",
    turnId: "recovery-work-turn", text: "先干一段活", source: "chat-web", topicNode: { topicId: topic.topicId, nodeId: node.nodeId } });
  const worker = spawnWorker(base.home, node.sessionId);
  await hang;
  const running = (await readLongAgentState(base.home)).turns.find((turn) => turn.requestId === "recovery-work-turn");
  assert.equal(running?.status, "running", "durably running, not settled");
  assert.deepEqual((await nodeFacts(base.home, node)).roundMarkers, ["running"], "the round is only RUNNING while work is in flight");
  assert.equal((await nodeFacts(base.home, node)).anchors, 0, "not settled while work is in flight");
  worker.child.kill("SIGKILL");
  assert.equal((await worker.exited).signal, "SIGKILL", worker.outputOf());
  server.setHang(null);

  // A NEW process (this one) recovers from durable state: the round is interrupted, never replayed.
  const { drainLongAgentTurns } = await import("../../src/long-agents/turn-queue.ts");
  await drainLongAgentTurns(base.home, "friend", node.sessionId);
  const turn = (await readLongAgentState(base.home)).turns.find((candidate) => candidate.requestId === "recovery-work-turn");
  assert.equal(turn?.status, "interrupted", "recovery marks the interrupted round interrupted (no auto-replay)");
  const recovered = await nodeFacts(base.home, node);
  assert.equal(recovered.anchors, 0, "no settled anchor from the interrupted round");
  assert.deepEqual(recovered.roundMarkers, ["running"], "the interrupted round never becomes completed");
  assert.equal(recovered.memory, before.memory, "no memory entry was produced or duplicated");
  assert.equal(recovered.userMessages, before.userMessages + 1, "only the accepted user message exists");

  // The node is still usable: a fresh round completes with its own anchor and memory entry.
  await acceptLongAgentTurn({ chatHome: base.home, longAgentId: "friend", requireInteractionRevision: false, projectId: "friend",
    turnId: "recovery-work-next", text: "重新发起一轮", source: "chat-web", topicNode: { topicId: topic.topicId, nodeId: node.nodeId } });
  await drainLongAgentTurns(base.home, "friend", node.sessionId);
  const after = await nodeFacts(base.home, node);
  assert.equal(after.anchors, 1, "the fresh round settles exactly one anchor");
  assert.equal(after.memory, before.memory + 1, "the fresh round writes exactly one memory entry");
});

test("mid-remember interruption (before the write): nothing settles and no memory is produced", async (t) => {
  const base = await fixture(t);
  const server = await startModelServer();
  t.after(() => server.close());
  const { topic, node } = await prepare(base.home, server.url, t);
  const before = await nodeFacts(base.home, node);
  server.setHang("remember-first");
  const hang = server.waitForHang();
  const { acceptLongAgentTurn, drainLongAgentTurns } = await import("../../src/long-agents/turn-queue.ts");
  await acceptLongAgentTurn({ chatHome: base.home, longAgentId: "friend", requireInteractionRevision: false, projectId: "friend",
    turnId: "recovery-remember-turn", text: "工作已完成，正在写记忆", source: "chat-web", topicNode: { topicId: topic.topicId, nodeId: node.nodeId } });
  const worker = spawnWorker(base.home, node.sessionId);
  await hang;
  const mid = await nodeFacts(base.home, node);
  assert.equal(mid.anchors, 0, "work finished but remember is still running: NOT settled");
  assert.equal(mid.memory, before.memory, "the writer had not written yet");
  worker.child.kill("SIGKILL");
  await worker.exited;
  server.setHang(null);
  await drainLongAgentTurns(base.home, "friend", node.sessionId);
  const turn = (await readLongAgentState(base.home)).turns.find((candidate) => candidate.requestId === "recovery-remember-turn");
  assert.equal(turn?.status, "interrupted");
  const recovered = await nodeFacts(base.home, node);
  assert.equal(recovered.anchors, 0, "nothing settled");
  assert.equal(recovered.memory, before.memory, "no memory written or duplicated");
});

test("mid-remember interruption (after the write): the written entry stays, recovery adds no duplicate", async (t) => {
  const base = await fixture(t);
  const server = await startModelServer();
  t.after(() => server.close());
  const { topic, node } = await prepare(base.home, server.url, t);
  server.setHang("remember-after-write");
  const hang = server.waitForHang();
  const { acceptLongAgentTurn, drainLongAgentTurns } = await import("../../src/long-agents/turn-queue.ts");
  await acceptLongAgentTurn({ chatHome: base.home, longAgentId: "friend", requireInteractionRevision: false, projectId: "friend",
    turnId: "recovery-remember2-turn", text: "写完记忆再中断", source: "chat-web", topicNode: { topicId: topic.topicId, nodeId: node.nodeId } });
  const worker = spawnWorker(base.home, node.sessionId);
  await hang;
  const mid = await nodeFacts(base.home, node);
  assert.equal(mid.anchors, 0, "the round is not settled even though remember already wrote");
  assert.equal(mid.memory, 1, "the writer's entry landed before the interruption");
  worker.child.kill("SIGKILL");
  await worker.exited;
  server.setHang(null);
  await drainLongAgentTurns(base.home, "friend", node.sessionId);
  const recovered = await nodeFacts(base.home, node);
  assert.equal(recovered.anchors, 0, "still not settled after recovery");
  assert.equal(recovered.memory, 1, "recovery does not replay, so the entry is neither duplicated nor lost");
  // A fresh round keeps the total consistent: one new entry, one settled anchor.
  await acceptLongAgentTurn({ chatHome: base.home, longAgentId: "friend", requireInteractionRevision: false, projectId: "friend",
    turnId: "recovery-remember2-next", text: "新的一轮", source: "chat-web", topicNode: { topicId: topic.topicId, nodeId: node.nodeId } });
  await drainLongAgentTurns(base.home, "friend", node.sessionId);
  const after = await nodeFacts(base.home, node);
  assert.equal(after.anchors, 1);
  assert.equal(after.memory, 2);
});

test("mid-work interruption of a RELAY round keeps exactly one intent, one native message and one turn", async (t) => {
  const base = await fixture(t);
  const server = await startModelServer();
  t.after(() => server.close());
  const { topic, node } = await prepare(base.home, server.url, t);
  const staged = await relayTopicNodeMessage({ chatHome: base.home, longAgentId: "friend", nodeId: node.nodeId, requestId: "recovery-relay-1", text: "代传内容" });
  server.setHang("work");
  const hang = server.waitForHang();
  const { acceptLongAgentTurn, drainLongAgentTurns } = await import("../../src/long-agents/turn-queue.ts");
  await acceptLongAgentTurn({ chatHome: base.home, longAgentId: "friend", requireInteractionRevision: false, projectId: "friend",
    turnId: "relay:recovery-relay-1", text: "代传内容", source: "chat-web",
    topicNode: { topicId: topic.topicId, nodeId: node.nodeId }, relayIntentEntryId: staged.intentEntryId });
  const worker = spawnWorker(base.home, node.sessionId);
  await hang;
  const countRelayFacts = async () => {
    const manager = (await openChatSession({ chatHome: base.home, projectId: "friend", sessionId: node.sessionId })).manager;
    return {
      intents: manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "chat.topic-relay-intent").length,
      native: manager.getEntries().filter((entry) => entry.type === "message" && entry.message?.role === "user" && entry.message?.chatTopicRelay?.requestId === "recovery-relay-1").length,
      nativeEntryId: manager.getEntries().find((entry) => entry.type === "message" && entry.message?.chatTopicRelay?.requestId === "recovery-relay-1")?.id,
    };
  };
  const mid = await countRelayFacts();
  assert.equal(mid.intents, 1, "exactly one durable intent");
  assert.equal(mid.native, 1, "exactly one native relayed message appended by the round");
  worker.child.kill("SIGKILL");
  await worker.exited;
  server.setHang(null);
  await drainLongAgentTurns(base.home, "friend", node.sessionId);
  const turn = (await readLongAgentState(base.home)).turns.find((candidate) => candidate.requestId === "relay:recovery-relay-1");
  assert.equal(turn?.status, "interrupted");
  const recovered = await countRelayFacts();
  assert.equal(recovered.intents, 1, "recovery adds no intent");
  assert.equal(recovered.native, 1, "recovery adds no native message");
  // Re-staging the SAME request adopts the existing intent and message: no duplicate artifacts.
  const restaged = await relayTopicNodeMessage({ chatHome: base.home, longAgentId: "friend", nodeId: node.nodeId, requestId: "recovery-relay-1", text: "代传内容" });
  assert.equal(restaged.created, false, "re-staging is not a new intent");
  assert.equal(restaged.intentEntryId, staged.intentEntryId);
  assert.equal(restaged.userEntryId, recovered.nativeEntryId, "re-staging adopts the ONE existing native message");
  const after = await countRelayFacts();
  assert.equal(after.intents, 1, "still exactly one intent");
  assert.equal(after.native, 1, "still exactly one native relayed message");
});

test("recovery converges a round whose completed marker landed but whose queue status did not", async (t) => {
  const base = await fixture(t);
  const server = await startModelServer();
  t.after(() => server.close());
  const { topic, node } = await prepare(base.home, server.url, t);
  const { acceptLongAgentTurn, drainLongAgentTurns } = await import("../../src/long-agents/turn-queue.ts");
  const { updateLongAgentState } = await import("../../src/long-agents/storage.ts");
  const accepted = await acceptLongAgentTurn({ chatHome: base.home, longAgentId: "friend", requireInteractionRevision: false, projectId: "friend",
    turnId: "recovery-window-turn", text: "完整跑完一轮", source: "chat-web", topicNode: { topicId: topic.topicId, nodeId: node.nodeId } });
  await drainLongAgentTurns(base.home, "friend", node.sessionId);
  const before = await nodeFacts(base.home, node);
  // The round keeps BOTH markers: the running opener and the completed closer.
  assert.deepEqual(before.roundMarkers, ["running", "completed"], "a completed round keeps both markers");
  assert.equal(before.anchors, 1);

  // Simulate the crash window: the round's completed marker is durable, but the queue completion write is
  // not. `updateTurnStatus(completed)` strips the frozen input, so a faithful window puts it back and sets
  // the turn to `running` while keeping the completed round marker on the branch.
  await updateLongAgentState(base.home, (state) => ({ state: { ...state, turns: state.turns.map((turn) => turn.turnId === accepted.turnId
    ? { ...turn, status: "running", settledAt: null, text: "完整跑完一轮", seed: [] } : turn) } }));
  await drainLongAgentTurns(base.home, "friend", node.sessionId);

  const turn = (await readLongAgentState(base.home)).turns.find((candidate) => candidate.turnId === accepted.turnId);
  assert.equal(turn?.status, "completed", "a fully completed round converges to completed, never interrupted");
  const after = await nodeFacts(base.home, node);
  assert.equal(after.anchors, 1, "the settled anchor is unchanged");
  assert.equal(after.memory, before.memory, "recovery adds no memory");
  assert.equal(after.userMessages, before.userMessages, "recovery adds no message");
  assert.deepEqual(after.roundMarkers, ["running", "completed"], "recovery adds no round marker");
});

test("a cancellation during remember is never rewritten as a completed round", async (t) => {
  const base = await fixture(t);
  const { drainLongAgentTurns } = await import("../../src/long-agents/turn-queue.ts");
  const { cancelFriendTurn } = await import("../../src/long-agents/turn-controls.ts");
  let cancelled = false;
  const server = await startModelServer({ onRememberFirst: async () => {
    if (cancelled) return;
    cancelled = true;
    // The REAL stop entry: it sets the durable cancel intent AND aborts the live Session, which at this
    // point is the writer's (the work segment handed the round over).
    await cancelFriendTurn(base.home, "friend", "chat-web:friend:recovery-cancel-turn");
  } });
  t.after(() => server.close());
  const { topic, node } = await prepare(base.home, server.url, t);
  const { acceptLongAgentTurn } = await import("../../src/long-agents/turn-queue.ts");
  await acceptLongAgentTurn({ chatHome: base.home, longAgentId: "friend", requireInteractionRevision: false, projectId: "friend",
    turnId: "recovery-cancel-turn", text: "这一轮会被取消", source: "chat-web", topicNode: { topicId: topic.topicId, nodeId: node.nodeId } });
  await drainLongAgentTurns(base.home, "friend", node.sessionId);
  const turn = (await readLongAgentState(base.home)).turns.find((candidate) => candidate.requestId === "recovery-cancel-turn");
  assert.equal(turn?.status, "cancelled", "a cancelled round stays cancelled");
  const facts = await nodeFacts(base.home, node);
  assert.equal(facts.anchors, 0, "a cancelled round is not a forkable anchor");
  assert.equal(facts.roundMarkers.includes("completed"), false, "a stopped round is never marked completed");
});
