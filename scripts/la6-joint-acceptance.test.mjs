import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { openProject } from "../src/projects/registry.ts";
import { writeLongAgentRegistry } from "../src/long-agents/storage.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const nitroCli = path.join(projectRoot, "node_modules", "nitro", "dist", "cli", "index.mjs");
const tsxBin = path.join(projectRoot, "nanoclaw", "node_modules", ".bin", "tsx");
const TOKEN = "test-channel-token-that-is-at-least-32-characters";
const AGENT_GROUP = "friend-joint";
const MESSAGING_GROUP = "mg-joint";
const PLATFORM_ID = "group-joint";
const TOPIC = "10";
const INSTANCE = "telegram-work";

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function stopProcess(process) {
  if (process === undefined || process.exitCode !== null) return;
  process.kill("SIGINT");
  await Promise.race([
    new Promise((resolve) => process.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (process.exitCode === null) process.kill("SIGKILL");
}

function startModelServer(replies) {
  let call = 0;
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    for await (const _chunk of request) { /* drain */ }
    const text = replies[Math.min(call, replies.length - 1)];
    call += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (delta, finish, usage) => JSON.stringify({
      id: `chatcmpl-joint-${String(call)}`, object: "chat.completion.chunk", created: 0, model: "joint-model",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage === undefined ? {} : { usage }),
    });
    response.write(`data: ${frame({ role: "assistant", content: text }, null)}\n\n`);
    response.write(`data: ${frame({}, "stop", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  return server;
}

async function jsonFetch(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

const until = async (label, read, accept, deadlineMs = 60_000) => {
  const deadline = Date.now() + deadlineMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.fail(`${label} timed out; last=${JSON.stringify(last)}`);
};

test("LA6 Chat+Nano joint acceptance runs the full external channel chain", {
  timeout: 240_000,
  // Requires the NanoClaw submodule's dependencies (tsx). It runs wherever the submodule is installed.
  skip: fs.existsSync(tsxBin) ? false : "NanoClaw dependencies are not installed (nanoclaw/node_modules/.bin/tsx)",
}, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chat-la6-joint-")));
  const home = path.join(root, "home");
  const nanoCwd = path.join(root, "nano");
  const buildDir = fs.mkdtempSync(path.join(projectRoot, "node_modules", ".nitro-la6-joint-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(nanoCwd, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "RULE_JOINT\n");
  await openProject({ path: workspace, chatHome: home, id: "a", name: "a" });

  const modelServer = startModelServer(["JOINT_EXTERNAL_REPLY"]);
  await new Promise((resolve, reject) => { modelServer.once("error", reject); modelServer.listen(0, "127.0.0.1", resolve); });
  const agentDir = path.join(home, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "joint-local", defaultModel: "joint-model", defaultThinkingLevel: "off" }));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "joint-local": {
    baseUrl: `http://127.0.0.1:${String(modelServer.address().port)}/v1`, api: "openai-completions", apiKey: "joint-key",
    models: [{ id: "joint-model", name: "Joint Model", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 4_096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));

  const chatPort = await reservePort();
  const baseUrl = `http://127.0.0.1:${String(chatPort)}`;
  const nanoPort = await reservePort();
  await writeLongAgentRegistry({
    schemaVersion: 1,
    instances: [{ id: "local", name: "Local", gatewayBaseUrl: `http://127.0.0.1:${String(nanoPort)}/webhook/chat-backend` }],
    agents: [{
      id: "friend", name: "friend", description: "Joint Friend", enabled: true, timeZone: "UTC", instanceId: "local",
      nanoclawAgentGroupId: AGENT_GROUP, defaultProjectId: "friend",
      definition: {
        schemaVersion: 1, id: "friend", name: "friend", description: "Joint Friend",
        systemPrompt: { mode: "replace", text: "Joint Friend" }, customInstructions: [],
        tools: { mode: "explicit", names: [], exclude: [], addresses: [] },
        resources: { mode: "explicit", skillPaths: [], extensionPaths: [], pluginSources: [] },
      },
    }],
  }, home);

  let chatOutput = "";
  const chat = spawn(process.execPath, [nitroCli, "dev", "--host", "127.0.0.1", "--port", String(chatPort)], {
    cwd: projectRoot,
    env: {
      ...process.env, CHAT_HOME: home, CHAT_NITRO_BUILD_DIR: buildDir,
      CHAT_CHANNEL_GATEWAY_TOKEN: TOKEN,
      WORKFLOW_TARGET_WORLD: "local", WORKFLOW_LOCAL_DATA_DIR: path.join(home, "runtime", "workflow-data"),
      WORKFLOW_LOCAL_BASE_URL: baseUrl, MEM0_TELEMETRY: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  chat.stdout.on("data", (chunk) => { chatOutput += chunk.toString(); });
  chat.stderr.on("data", (chunk) => { chatOutput += chunk.toString(); });

  let nanoOutput = "";
  const nano = spawn(tsxBin, [path.join(projectRoot, "nanoclaw", "scripts", "la6-joint-host.ts")], {
    cwd: nanoCwd,
    env: {
      ...process.env, CHAT_CHANNEL_GATEWAY_TOKEN: TOKEN, CHAT_INTEGRATION_INSTANCE_ID: "local", CHAT_BACKEND_URL: baseUrl,
      LA6_GATEWAY_PORT: String(nanoPort), LA6_AGENT_GROUP_ID: AGENT_GROUP, LA6_MESSAGING_GROUP_ID: MESSAGING_GROUP,
      LA6_CHANNEL_TYPE: "telegram", LA6_PLATFORM_ID: PLATFORM_ID, LA6_INSTANCE: INSTANCE,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  nano.stdout.on("data", (chunk) => { nanoOutput += chunk.toString(); });
  nano.stderr.on("data", (chunk) => { nanoOutput += chunk.toString(); });

  t.after(async () => {
    await stopProcess(nano);
    await stopProcess(chat);
    modelServer.closeAllConnections();
    await new Promise((resolve) => modelServer.close(resolve));
    fs.rmSync(buildDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  const ready = async (url) => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try { if ((await fetch(url)).ok) return true; } catch { /* not up yet */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  };
  assert.equal(await ready(`${baseUrl}/api/health`), true, chatOutput);
  assert.equal(await ready(`http://127.0.0.1:${String(nanoPort)}/test/state`), true, nanoOutput);

  const nanoState = () => jsonFetch(`http://127.0.0.1:${String(nanoPort)}/test/state`);
  const nanoInbound = (body) => jsonFetch(`http://127.0.0.1:${String(nanoPort)}/test/inbound`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const api = (suffix, init) => jsonFetch(`${baseUrl}/api/long-agents/friend/conversations${suffix}`, init);

  // 1. Owner binds the external conversation channel; Chat mirrors it to NanoClaw over real HTTP.
  const created = await api("", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storageProjectId: "a", title: "Joint group", requestId: "req-joint", memberLongAgentIds: ["friend"] }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body) + chatOutput);
  const conversationId = created.body.id;
  const bound = await api(`/${conversationId}/channels`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "bind", longAgentId: "friend", instanceId: "local", expectedRevision: 0, botPlatformId: "bot-joint",
      destination: { channelType: "telegram", instance: INSTANCE, platformId: PLATFORM_ID, threadId: TOPIC, messagingGroupId: MESSAGING_GROUP },
    }),
  });
  assert.equal(bound.status, 200, JSON.stringify(bound.body) + chatOutput);
  const bindingId = bound.body.binding.bindingId;
  assert.deepEqual(bound.body.pending, [], JSON.stringify(bound.body));
  const mirrored = await until("nano mirror", () => jsonFetch(`http://127.0.0.1:${String(nanoPort)}/test/binding?bindingId=${bindingId}`),
    (result) => result.body.binding?.status === "active");
  assert.equal(mirrored.body.binding.instance, INSTANCE);
  assert.equal(mirrored.body.binding.thread_id, TOPIC);

  // 2. A platform message in the bound topic routes through NanoClaw into the Chat group public root.
  const inbound = await nanoInbound({ threadId: TOPIC, senderExternalId: "ext-1", senderDisplayName: "Ada", text: "外部问题", externalMessageId: "em-1" });
  assert.equal(inbound.body.routed, true, JSON.stringify(inbound.body) + nanoOutput);
  const withExternal = await until("chat external message", () => api(`/${conversationId}/messages`),
    (result) => result.body.messages?.some((message) => message.external === true));
  const externalMessage = withExternal.body.messages.find((message) => message.external === true);
  assert.equal(externalMessage.text, "外部问题");
  assert.equal(externalMessage.authorDisplayName, "Ada");

  // A message in another topic of the same group must not match this binding.
  const otherTopic = await nanoInbound({ threadId: "20", senderExternalId: "ext-2", text: "另一个话题", externalMessageId: "em-2" });
  assert.equal(otherTopic.body.routed, false, "a different topic must not route to this binding");

  // 3. The group round publishes a reply, delivers it through NanoClaw to the platform adapter, and the
  //    platform receipt returns to Chat so the delivery becomes `delivered`.
  const started = await api(`/${conversationId}/discussions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ policy: "mention", targets: ["friend"] }),
  });
  assert.equal(started.status, 202, JSON.stringify(started.body) + chatOutput);
  await until("discussion completed", () => api(`/${conversationId}`), (result) => {
    const discussion = result.body.discussions?.find((item) => item.discussionId === started.body.discussionId);
    return discussion !== undefined && ["completed", "failed", "stopped", "interrupted"].includes(discussion.status);
  });
  const delivered = await until("platform delivery", nanoState, (result) => result.body.delivered?.some((message) => message.text === "JOINT_EXTERNAL_REPLY"));
  assert.equal(delivered.body.delivered.at(-1).platformId, PLATFORM_ID);
  assert.equal(delivered.body.delivered.at(-1).threadId, TOPIC);

  const channels = await until("delivered receipt", () => api(`/${conversationId}/channels`),
    (result) => result.body.deliveries?.some((delivery) => delivery.status === "delivered"));
  const delivery = channels.body.deliveries.find((item) => item.status === "delivered");
  assert.equal(delivery.platformMessageId, "pm-1");
  assert.equal(channels.body.bindings.find((item) => item.bindingId === bindingId).syncedRevision, 1);
});
