import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
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
const realAgentDir = path.join(os.homedir(), ".chat", "agent");
const TOKEN = "test-channel-token-that-is-at-least-32-characters";
const AGENT_GROUP = "friend-joint-real";
const MESSAGING_GROUP = "mg-joint-real";
const PLATFORM_ID = "group-joint-real";
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
  await Promise.race([new Promise((resolve) => process.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (process.exitCode === null) process.kill("SIGKILL");
}
async function jsonFetch(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}
const until = async (label, read, accept, deadlineMs = 120_000) => {
  const deadline = Date.now() + deadlineMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.fail(`${label} timed out; last=${JSON.stringify(last)}`);
};

/**
 * Real-model Chat+Nano joint acceptance. Same full external channel chain as the isolated run, but the
 * group round runs through the **real configured model** (the existing `~/.chat/agent` config is
 * symlinked, never read or copied). The platform leg is a local adapter, so no real external message is
 * sent. Skipped when no real model config exists; insufficient credit surfaces as a real failure.
 */
test("LA6 Chat+Nano joint acceptance runs the chain through the real model", {
  timeout: 300_000,
  skip: fs.existsSync(path.join(realAgentDir, "models.json")) && fs.existsSync(tsxBin) ? false : "没有真实模型配置或 NanoClaw 依赖",
}, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chat-la6-joint-real-")));
  const home = path.join(root, "home");
  const nanoCwd = path.join(root, "nano");
  const buildDir = fs.mkdtempSync(path.join(projectRoot, "node_modules", ".nitro-la6-joint-real-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(nanoCwd, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(home, "agent"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "RULE_JOINT_REAL\n");
  for (const file of ["models.json", "settings.json", "auth.json"]) {
    const source = path.join(realAgentDir, file);
    if (fs.existsSync(source)) fs.symlinkSync(source, path.join(home, "agent", file));
  }
  await openProject({ path: workspace, chatHome: home, id: "a", name: "a" });

  const chatPort = await reservePort();
  const baseUrl = `http://127.0.0.1:${String(chatPort)}`;
  const nanoPort = await reservePort();
  await writeLongAgentRegistry({
    schemaVersion: 1,
    instances: [{ id: "local", name: "Local", gatewayBaseUrl: `http://127.0.0.1:${String(nanoPort)}/webhook/chat-backend` }],
    agents: [{
      id: "friend", name: "friend", description: "Joint Friend", enabled: true, timeZone: "Asia/Shanghai", instanceId: "local",
      nanoclawAgentGroupId: AGENT_GROUP, defaultProjectId: "friend",
      definition: {
        schemaVersion: 1, id: "friend", name: "friend", description: "Joint Friend",
        systemPrompt: { mode: "replace", text: "你是群里的研究员。只回答被问到的内容，保持简短。" }, customInstructions: [],
        tools: { mode: "explicit", names: [], exclude: [], addresses: [] },
        resources: { mode: "explicit", skillPaths: [], extensionPaths: [], pluginSources: [] },
      },
    }],
  }, home);

  let chatOutput = "";
  const chat = spawn(process.execPath, [nitroCli, "dev", "--host", "127.0.0.1", "--port", String(chatPort)], {
    cwd: projectRoot,
    env: {
      ...process.env, CHAT_HOME: home, CHAT_NITRO_BUILD_DIR: buildDir, CHAT_CHANNEL_GATEWAY_TOKEN: TOKEN,
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
    fs.rmSync(buildDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  const ready = async (url) => {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try { if ((await fetch(url)).ok) return true; } catch { /* not up yet */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  };
  assert.equal(await ready(`${baseUrl}/api/health`), true, chatOutput);
  assert.equal(await ready(`http://127.0.0.1:${String(nanoPort)}/test/state`), true, nanoOutput);
  const api = (suffix, init) => jsonFetch(`${baseUrl}/api/long-agents/friend/conversations${suffix}`, init);

  const created = await api("", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storageProjectId: "a", title: "真实联合群", requestId: "req-joint-real", memberLongAgentIds: ["friend"] }),
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
  assert.deepEqual(bound.body.pending, []);
  const bindingId = bound.body.binding.bindingId;
  await until("nano mirror", () => jsonFetch(`http://127.0.0.1:${String(nanoPort)}/test/binding?bindingId=${bindingId}`),
    (result) => result.body.binding?.status === "active");

  const inbound = await jsonFetch(`http://127.0.0.1:${String(nanoPort)}/test/inbound`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId: TOPIC, senderExternalId: "ext-real", senderDisplayName: "Ada", text: "请用一句话说明这个群可以做什么。", externalMessageId: "em-real-1" }),
  });
  assert.equal(inbound.body.routed, true, JSON.stringify(inbound.body) + nanoOutput);
  await until("chat external message", () => api(`/${conversationId}/messages`), (result) => result.body.messages?.some((message) => message.external === true));

  const started = await api(`/${conversationId}/discussions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ policy: "mention", targets: ["friend"] }),
  });
  assert.equal(started.status, 202, JSON.stringify(started.body) + chatOutput);
  const published = await until("real model discussion", async () => {
    const detail = await api(`/${conversationId}`);
    const messages = await api(`/${conversationId}/messages`);
    return { detail: detail.body, messages: messages.body };
  }, (result) => {
    const discussion = result.detail.discussions?.find((item) => item.discussionId === started.body.discussionId);
    const reply = result.messages.messages?.find((message) => message.publicationId !== null && message.text !== null);
    return discussion !== undefined && ["completed", "stopped"].includes(discussion.status) && reply !== undefined;
  }, 180_000);
  const reply = published.messages.messages.find((message) => message.publicationId !== null && message.text !== null);
  assert.equal(reply.authorLongAgentId, "friend");
  assert.ok(reply.text.trim().length > 0, "真实模型返回了非空公开回复");

  const delivered = await until("real model platform delivery", () => jsonFetch(`http://127.0.0.1:${String(nanoPort)}/test/state`),
    (result) => result.body.delivered?.some((message) => message.text.trim().length > 0));
  assert.equal(delivered.body.delivered.at(-1).text, reply.text, "平台适配器收到与公开回复一致的文本");
  assert.equal(delivered.body.delivered.at(-1).platformId, PLATFORM_ID);
  assert.equal(delivered.body.delivered.at(-1).threadId, TOPIC);

  const channels = await until("delivered receipt", () => api(`/${conversationId}/channels`),
    (result) => result.body.deliveries?.some((delivery) => delivery.status === "delivered"));
  const delivery = channels.body.deliveries.find((item) => item.status === "delivered");
  assert.equal(delivery.platformMessageId, "pm-1");
  assert.equal(channels.body.bindings.find((item) => item.bindingId === bindingId).syncedRevision, 1);
});
