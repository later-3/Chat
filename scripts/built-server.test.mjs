import { checkChatWeb } from "./chat-web-health.mjs";
import { respondPlannerConversation, exercisePlannerConversation } from "./planner-conversation-fixture.mjs";
import { respondProjectManagement, exerciseProjectManagementRun } from "./project-management-runtime-fixture.mjs";
import { exerciseWorkflowTui } from "./workflow-tui-runtime-fixture.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendChatWorkflowStage } from "../src/workflows/workflow-stage.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const serverEntry = path.join(projectRoot, ".output/server/index.mjs");
let runtimeRoot;
let chatHome;
let workspace;
let sessionId;
let longAgentSessionId;
let server;
let embeddingServer;
let baseUrl;
let serverOutput = "";
let promptResourceId;
let projectSkillPath;
const embeddingDimension = 64;
const projectId = "built-project";

function textEmbedding(text) {
  const vector = Array.from({ length: embeddingDimension }, () => 0);
  const symbols = Array.from(text.toLowerCase());
  for (let index = 0; index < symbols.length; index += 1) {
    const current = symbols[index]?.codePointAt(0) ?? 0;
    const next = symbols[index + 1]?.codePointAt(0) ?? 0;
    vector[(current * 31 + next * 17 + index) % vector.length] += 1;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function startEmbeddingServer() {
  const localServer = http.createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      const modelRequest = await readJson(request);
      if (respondPlannerConversation(modelRequest, response)) return;
      if (respondProjectManagement(modelRequest, response, chatHome, "built-runtime-model")) return;
      const requestText = JSON.stringify(modelRequest);
      const responseText = !requestText.includes("workflow_execution_task_brief")
        && requestText.includes("chat-planner-output")
        ? '<!-- chat-planner-output {"schemaVersion":1,"readiness":"ready_for_review","blockingQuestions":[]} -->\n# Execution plan\nRun the deterministic smoke test.'
        : "Workflow runtime smoke completed.";
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl-built-runtime",
        object: "chat.completion.chunk",
        created: 0,
        model: "built-runtime-model",
        choices: [{
          index: 0,
          delta: { role: "assistant", content: responseText },
          finish_reason: null,
        }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl-built-runtime",
        object: "chat.completion.chunk",
        created: 0,
        model: "built-runtime-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/embeddings") {
      response.writeHead(404).end();
      return;
    }
    const body = await readJson(request);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      object: "list",
      model: body.model,
      data: inputs.map((input, index) => ({
        object: "embedding",
        index,
        embedding: textEmbedding(String(input)),
      })),
      usage: { prompt_tokens: 0, total_tokens: 0 },
    }));
  });
  await new Promise((resolve, reject) => {
    localServer.once("error", reject);
    localServer.listen(0, "127.0.0.1", resolve);
  });
  const address = localServer.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  embeddingServer = localServer;
  return `http://127.0.0.1:${address.port}/v1`;
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : null;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function encodeFilePath(filePath) {
  return filePath.replace(/\\/g, "/").split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

async function serverFetch(pathname, init = {}) {
  return fetch(`${baseUrl}${pathname}`, init);
}

before(async () => {
  assert.equal(fs.existsSync(serverEntry), true, "run pnpm build before pnpm test:built");
  runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chat-built-server-"));
  chatHome = path.join(runtimeRoot, "chat-home");
  workspace = path.join(runtimeRoot, "workspace");
  const sessionDir = path.join(chatHome, "projects", projectId, "sessions");
  const agentDir = path.join(chatHome, "agent");
  const skillDir = path.join(agentDir, "skills", "built-review");
  const extensionDir = path.join(agentDir, "extensions");
  const projectSkillDir = path.join(workspace, ".chat", "skills", "chat-architecture");
  const projectExtensionDir = path.join(workspace, ".chat", "extensions");
  fs.mkdirSync(workspace, { recursive: true });
  workspace = fs.realpathSync(workspace);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(extensionDir, { recursive: true });
  fs.mkdirSync(projectSkillDir, { recursive: true });
  fs.mkdirSync(projectExtensionDir, { recursive: true });
  fs.writeFileSync(path.join(workspace, ".chat", "project.json"), JSON.stringify({
    schemaVersion: 1,
    id: projectId,
    name: "Built Project",
    description: "Production integration test",
  }));
  fs.writeFileSync(path.join(workspace, "fixture.md"), "# Built server fixture\n");
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
    "---", "name: built-review", "description: Built server review", "---", "Review built output.",
  ].join("\n"));
  projectSkillPath = path.join(projectSkillDir, "SKILL.md");
  fs.writeFileSync(projectSkillPath, [
    "---", "name: chat-architecture", "description: Navigate Chat architecture", "---", "Read the architecture index.",
  ].join("\n"));
  fs.writeFileSync(path.join(extensionDir, "built-extension.ts"), "export default function register() {}\n");
  fs.writeFileSync(path.join(projectExtensionDir, "built-project-tool.ts"), [
    "export default function register(pi) {",
    "  pi.registerTool({",
    "    name: 'built_project_lookup',",
    "    label: 'Built project lookup',",
    "    description: 'Production Project Tool fixture.',",
    "    parameters: { type: 'object', properties: {}, additionalProperties: false },",
    "    async execute() { return { content: [{ type: 'text', text: 'ok' }], details: {} }; },",
    "  });",
    "}",
  ].join("\n"));

  const manager = SessionManager.create(workspace, sessionDir);
  appendChatWorkflowStage(manager, {
    invocationId: "built-history-invocation",
    workflowId: "minimal-pi-coding-agent",
    stageId: "execute",
    agentId: "pi-coding-agent",
  });
  manager.appendMessage({ role: "user", content: "fixture prompt", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    provider: "test",
    model: "test-model",
    content: [{ type: "text", text: "fixture response" }],
    timestamp: Date.now(),
  });
  sessionId = manager.getSessionId();

  const longAgentManager = SessionManager.create(workspace, sessionDir);
  longAgentManager.appendMessage({ role: "user", content: "long agent fixture", timestamp: Date.now() });
  longAgentManager.flush();
  longAgentSessionId = longAgentManager.getSessionId();
  const longAgentStateDir = path.join(chatHome, "runtime");
  fs.mkdirSync(longAgentStateDir, { recursive: true });
  const longAgentCreatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(longAgentStateDir, "long-agent-state.json"), JSON.stringify({
    schemaVersion: 2,
    cursors: {},
    projectAgents: [{
      id: `project-long-agent:${projectId}:nexus`,
      projectId,
      longAgentId: "nexus",
      primarySessionId: longAgentSessionId,
      status: "active",
      createdAt: longAgentCreatedAt,
      updatedAt: longAgentCreatedAt,
    }],
    bindings: [],
  }));

  promptResourceId = "built-production-rule";
  const promptResourceDir = path.join(chatHome, "projects", projectId, "prompt-resources", "resources");
  fs.mkdirSync(promptResourceDir, { recursive: true });
  const createdAt = new Date().toISOString();
  fs.writeFileSync(path.join(promptResourceDir, `${promptResourceId}.json`), JSON.stringify({
    schemaVersion: 1,
    id: promptResourceId,
    revisions: [{
      schemaVersion: 1,
      id: promptResourceId,
      revision: 1,
      kind: "rule",
      title: "Production API rule",
      purpose: "Verify the built Prompt resource routes",
      content: "Keep production API behavior covered by a built-server test.",
      tags: ["production-test"],
      status: "active",
      sources: [{
        type: "manual",
        entryIds: [],
        context: "Created by the built-server test.",
        capturedAt: createdAt,
      }],
      author: { type: "user" },
      createdAt,
    }],
  }, null, 2));

  const embeddingBaseUrl = await startEmbeddingServer();
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "built-runtime",
    defaultModel: "built-runtime-model",
    defaultThinkingLevel: "off",
  }));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "built-runtime": {
        baseUrl: embeddingBaseUrl,
        api: "openai-completions",
        apiKey: "built-runtime-key",
        models: [{
          id: "built-runtime-model",
          name: "Built Runtime Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 8_192,
        }],
      },
    },
  }));
  fs.writeFileSync(path.join(chatHome, "devices.json"), JSON.stringify({
    version: 1,
    devices: [
      { id: "built-runtime", name: "Built Runtime", url: "https://chat.example.test" },
      { id: "remote", name: "Remote Chat", url: "https://remote.example.test" },
    ],
  }));
  const port = await reservePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [serverEntry], {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      WORKFLOW_TARGET_WORLD: "local",
      WORKFLOW_LOCAL_DATA_DIR: path.join(chatHome, "runtime", "workflow-data"),
      CHAT_HOME: chatHome,
      CHAT_PUBLIC_URL: "https://chat.example.test",
      CHAT_CHANNEL_GATEWAY_TOKEN: "built-server-channel-token-at-least-32-characters",
      CHAT_MEMORY_EMBEDDER_PROVIDER: "openai",
      CHAT_MEMORY_EMBEDDER_BASE_URL: embeddingBaseUrl,
      CHAT_MEMORY_EMBEDDER_API_KEY: "built-server-test",
      CHAT_MEMORY_EMBEDDING_MODEL: "deterministic-test-embedding",
      CHAT_MEMORY_EMBEDDING_DIMENSION: String(embeddingDimension),
      MEM0_TELEMETRY: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Chat server did not start:\n${serverOutput}`)), 15_000);
    const collect = (chunk) => {
      serverOutput += chunk.toString();
      if (serverOutput.includes(`http://127.0.0.1:${port}/`)) {
        clearTimeout(timeout);
        resolve();
      }
    };
    server.stdout.on("data", collect);
    server.stderr.on("data", collect);
    server.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.once("exit", (code) => {
      if (!serverOutput.includes(`http://127.0.0.1:${port}/`)) {
        clearTimeout(timeout);
        reject(new Error(`Chat server exited with ${code}:\n${serverOutput}`));
      }
    });
  });
  const opened = await serverFetch("/api/projects/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: workspace }),
  });
  assert.equal(opened.status, 200, await opened.text());
});

after(async () => {
  if (server && server.exitCode === null) {
    server.kill("SIGINT");
    await Promise.race([
      new Promise((resolve) => server.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 6_000)),
    ]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  if (embeddingServer?.listening) {
    await new Promise((resolve) => embeddingServer.close(resolve));
  }
  if (runtimeRoot) fs.rmSync(runtimeRoot, { recursive: true, force: true });
});

test("the production server serves the embedded frontend", async () => {
  await checkChatWeb(baseUrl);
  const response = await serverFetch("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  const html = await response.text();
  assert.match(html, /<div id="root"><\/div>/);
  const assetPath = html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(assetPath);
  assert.equal((await fetch(`${baseUrl}${assetPath}`)).status, 200);

  const manifestResponse = await fetch(`${baseUrl}/manifest.webmanifest`);
  assert.equal(manifestResponse.status, 200);
  assert.equal((await manifestResponse.json()).name, "Chat");
  assert.equal((await fetch(`${baseUrl}/sw.js`)).status, 200);
});

test("product entry is direct and removed login routes return 404", async () => {
  assert.equal((await serverFetch("/api/health")).status, 200);
  assert.equal((await serverFetch(`/api/sessions?projectId=${projectId}`)).status, 200);
  for (const pathname of ["/login", "/api/auth/session"]) {
    const response = await serverFetch(pathname, { redirect: "manual" });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("location"), null);
  }
});

test("Channel ingress uses machine authentication instead of the browser session", async () => {
  const payload = {
    schemaVersion: 1,
    instanceId: "unknown-instance",
    events: [{
      seq: 1,
      eventId: "unknown:event",
      instanceId: "unknown-instance",
      direction: "in",
      messageId: "message-1",
      nanoSessionId: "nano-session-1",
      agentGroupId: "agent-group-1",
      messagingGroupId: null,
      isGroup: false,
      senderId: "user-1",
      senderName: "Later",
      text: "hello",
      kind: "chat",
      timestamp: new Date().toISOString(),
      source: null,
      delivery: null,
      chatSessionId: null,
    }],
  };
  const unauthenticated = await fetch(`${baseUrl}/api/internal/channel/v1/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(unauthenticated.status, 401);

  const browserOnly = await serverFetch("/api/internal/channel/v1/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(browserOnly.status, 401);

  const service = await fetch(`${baseUrl}/api/internal/channel/v1/events`, {
    method: "POST",
    headers: {
      Authorization: "Bearer built-server-channel-token-at-least-32-characters",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  assert.equal(service.status, 400);
  assert.match(await service.text(), /未知NanoClaw instance/);
});

test("memory management API persists, searches, updates, rebuilds, and deletes", async () => {
  const createResponse = await serverFetch("/api/memories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: "Later 选择 MEMORY_HTTP_ALPHA 作为 Chat 的长期记忆方案。",
      kind: "decision",
      metadata: { source: "built-server-test" },
      source: { sessionId, entryIds: ["fixture-entry"] },
    }),
  });
  const createBody = await createResponse.json();
  assert.equal(createResponse.status, 201, JSON.stringify(createBody));
  const created = createBody.memory;
  assert.equal(created.indexStatus, "indexed");
  assert.ok(created.mem0Id);

  const listResponse = await serverFetch("/api/memories?kind=decision");
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.equal(list.total, 1);
  assert.equal(list.items[0].id, created.id);

  const detailResponse = await serverFetch(`/api/memories/${created.id}`);
  assert.equal(detailResponse.status, 200);
  assert.equal((await detailResponse.json()).memory.text, created.text);

  const searchResponse = await serverFetch("/api/memories/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "MEMORY_HTTP_ALPHA", topK: 1 }),
  });
  assert.equal(searchResponse.status, 200);
  assert.equal((await searchResponse.json()).results[0].memory.id, created.id);

  const updatedText = "Later 选择 MEMORY_HTTP_BETA 作为 Chat 的长期记忆方案。";
  const updateResponse = await serverFetch(`/api/memories/${created.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target: { type: "personal" }, text: updatedText }),
  });
  assert.equal(updateResponse.status, 200);
  const updated = (await updateResponse.json()).memory;
  assert.equal(updated.text, updatedText);
  assert.equal(updated.version, 2);
  assert.equal(updated.indexStatus, "indexed");

  const rebuildResponse = await serverFetch("/api/memories/rebuild", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target: { type: "personal" } }),
  });
  assert.equal(rebuildResponse.status, 200);
  assert.deepEqual(await rebuildResponse.json(), {
    total: 1,
    indexed: 1,
    failed: 0,
    failures: [],
  });

  const rebuiltSearchResponse = await serverFetch("/api/memories/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "MEMORY_HTTP_BETA", topK: 1 }),
  });
  assert.equal(rebuiltSearchResponse.status, 200);
  assert.equal((await rebuiltSearchResponse.json()).results[0].memory.id, created.id);

  const healthResponse = await serverFetch("/api/memories/health");
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), {
    records: 1,
    indexed: 1,
    pending: 0,
    failed: 0,
    pendingDeletions: 0,
  });

  const deleteResponse = await serverFetch(`/api/memories/${created.id}`, { method: "DELETE" });
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), {
    id: created.id,
    deleted: true,
    indexCleanup: "completed",
  });
  assert.equal((await (await serverFetch("/api/memories")).json()).total, 0);
  assert.equal(fs.existsSync(path.join(chatHome, "memory", "personal", "catalog.db")), true);
  assert.equal(fs.existsSync(path.join(chatHome, "memory", "personal", "vector-store.db")), true);
});

test("device directory is available without a product login", async () => {
  const devicesResponse = await serverFetch("/api/devices");
  assert.equal(devicesResponse.status, 200);
  assert.deepEqual(await devicesResponse.json(), {
    version: 1,
    currentDeviceId: "built-runtime",
    devices: [
      { id: "built-runtime", name: "Built Runtime", url: "https://chat.example.test" },
      { id: "remote", name: "Remote Chat", url: "https://remote.example.test" },
    ],
    diagnostics: [],
    selectionMode: "direct",
    gatewayUrl: null,
  });
});

test("the production Project API treats each explicitly opened nested directory as an independent root", async () => {
  const parent = path.join(runtimeRoot, "parent-project");
  const child = path.join(parent, "nested", "child-project");
  fs.mkdirSync(child, { recursive: true });

  const open = async (directory) => {
    const response = await serverFetch("/api/projects/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: directory }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const openedParent = await open(parent);
  const openedChild = await open(child);

  assert.equal(openedParent.projectRoot, fs.realpathSync(parent));
  assert.equal(openedChild.projectRoot, fs.realpathSync(child));
  assert.notEqual(openedParent.projectId, openedChild.projectId);
  assert.equal(fs.existsSync(path.join(parent, ".chat", "project.json")), true);
  assert.equal(fs.existsSync(path.join(child, ".chat", "project.json")), true);

  const homeResponse = await serverFetch("/api/home");
  assert.equal(homeResponse.status, 200);
  const home = await homeResponse.json();
  assert.deepEqual(Object.keys(home), ["home"]);

  const forgedIdentity = await serverFetch("/api/projects/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: child, id: "chat" }),
  });
  assert.equal(forgedIdentity.status, 400);
});

test("session list and detail come from the isolated Chat session directory", async () => {
  const listResponse = await serverFetch(`/api/sessions?projectId=${projectId}`);
  assert.equal(listResponse.status, 200);
  assert.match(listResponse.headers.get("cache-control") ?? "", /no-store/);
  const list = await listResponse.json();
  assert.deepEqual(new Set(list.sessions.map((session) => session.id)), new Set([sessionId, longAgentSessionId]));
  assert.deepEqual(list.sessions.find((session) => session.id === sessionId).owner, { type: "ordinary" });
  const longAgentOwner = {
    type: "long-agent",
    longAgentId: "nexus",
    projectLongAgentId: `project-long-agent:${projectId}:nexus`,
  };
  assert.deepEqual(list.sessions.find((session) => session.id === longAgentSessionId).owner, longAgentOwner);

  const detailResponse = await serverFetch(`/api/sessions/${encodeURIComponent(sessionId)}?projectId=${projectId}&deferThinking=1&deferMedia=1`);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.deepEqual(detail.context.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(detail.context.messages.length, detail.context.entryIds.length);
  assert.deepEqual(detail.workflowCallTree, []);
  assert.deepEqual(detail.workflowCallStatistics.capacity, { active: 0, limit: 8 });
  assert.deepEqual(detail.session.owner, { type: "ordinary" });

  const longAgentDetailResponse = await serverFetch(
    `/api/sessions/${encodeURIComponent(longAgentSessionId)}?projectId=${projectId}`,
  );
  assert.equal(longAgentDetailResponse.status, 200);
  const longAgentDetail = await longAgentDetailResponse.json();
  assert.deepEqual(longAgentDetail.session.owner, longAgentOwner);

  const workflowCallsResponse = await serverFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/workflow-calls?projectId=${projectId}`,
  );
  assert.equal(workflowCallsResponse.status, 200, await workflowCallsResponse.clone().text());
  assert.match(workflowCallsResponse.headers.get("cache-control") ?? "", /no-store/);
  const workflowCalls = await workflowCallsResponse.json();
  assert.deepEqual(workflowCalls.workflowCallTree, []);
  assert.deepEqual(workflowCalls.workflowCallStatistics, detail.workflowCallStatistics);

  const unknownCallResponse = await serverFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/workflow-calls/missing-call?projectId=${projectId}`,
    { method: "DELETE" },
  );
  assert.equal(unknownCallResponse.status, 409);
  assert.match(await unknownCallResponse.text(), /不存在Workflow调用/);

  const renameResponse = await serverFetch(`/api/sessions/${encodeURIComponent(sessionId)}?projectId=${projectId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Built Session" }),
  });
  assert.equal(renameResponse.status, 200, await renameResponse.clone().text());
  assert.deepEqual(await renameResponse.json(), { sessionId, name: "Built Session" });
});

test("session APIs fail ownership resolution closed without exposing runtime paths", async () => {
  const statePath = path.join(chatHome, "runtime", "long-agent-state.json");
  const validState = fs.readFileSync(statePath, "utf8");
  fs.writeFileSync(statePath, "not-json\n");
  try {
    for (const requestPath of [
      `/api/sessions?projectId=${projectId}`,
      `/api/sessions/${encodeURIComponent(sessionId)}?projectId=${projectId}`,
    ]) {
      const response = await serverFetch(requestPath);
      const body = await response.text();
      assert.equal(response.status, 500, body);
      assert.match(body, /无法读取Session归属状态/);
      assert.doesNotMatch(body, new RegExp(runtimeRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(body, /long-agent-state\.json/);
    }
  } finally {
    fs.writeFileSync(statePath, validState);
  }
});

test("historical tool-result images are deferred and served from the same Project Session", async () => {
  const sessionDir = path.join(chatHome, "projects", projectId, "sessions");
  const manager = SessionManager.create(workspace, sessionDir);
  manager.appendMessage({ role: "user", content: "capture the built fixture", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    api: "test",
    provider: "test",
    model: "test-model",
    content: [{ type: "toolCall", id: "built-image-call", name: "screenshot", arguments: {} }],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "built-image-call",
    toolName: "screenshot",
    content: [
      { type: "text", text: "captured" },
      { type: "image", data: "QUJDRA==", mimeType: "image/png" },
    ],
    isError: false,
    timestamp: Date.now(),
  });
  manager.flush();

  const detailResponse = await serverFetch(
    `/api/sessions/${encodeURIComponent(manager.getSessionId())}?projectId=${projectId}&deferMedia=1`,
  );
  assert.equal(detailResponse.status, 200, await detailResponse.clone().text());
  const detail = await detailResponse.json();
  const toolResult = detail.context.messages.find((message) => message.role === "toolResult");
  const image = toolResult?.content.find((block) => block.type === "image");
  assert.match(image?.source?.url ?? "", /tool-result-image\?blockIndex=1&projectId=built-project$/);

  const imageResponse = await serverFetch(image.source.url);
  assert.equal(imageResponse.status, 200, await imageResponse.clone().text());
  assert.equal(imageResponse.headers.get("content-type"), "image/png");
  assert.equal(imageResponse.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual([...new Uint8Array(await imageResponse.arrayBuffer())], [65, 66, 67, 68]);
});

test("the bounded file index supports client preload and server-ranked search", async () => {
  const indexResponse = await serverFetch(`/api/file-index?cwd=${encodeURIComponent(workspace)}`);
  assert.equal(indexResponse.status, 200, await indexResponse.clone().text());
  const index = await indexResponse.json();
  assert.equal(index.files.includes("fixture.md"), true);
  assert.equal(index.truncated, false);

  const searchResponse = await serverFetch(
    `/api/file-index?cwd=${encodeURIComponent(workspace)}&q=fixture`,
  );
  assert.equal(searchResponse.status, 200, await searchResponse.clone().text());
  assert.equal((await searchResponse.json()).matches[0].path, "fixture.md");

  const outsideResponse = await serverFetch(
    `/api/file-index?cwd=${encodeURIComponent(runtimeRoot)}&q=fixture`,
  );
  assert.equal(outsideResponse.status, 403);
});

test("Session removal API moves, lists, restores, configures, and permanently deletes one Pi Session", async () => {
  const sessionDir = path.join(chatHome, "projects", projectId, "sessions");
  const manager = SessionManager.create(workspace, sessionDir);
  manager.appendMessage({ role: "user", content: "removal API fixture", timestamp: Date.now() });
  manager.flush();
  const removableSessionId = manager.getSessionId();
  const originalFile = manager.getSessionFile();

  const removeResponse = await serverFetch(
    `/api/sessions/${encodeURIComponent(removableSessionId)}/remove?projectId=${projectId}`,
    { method: "POST" },
  );
  assert.equal(removeResponse.status, 200, await removeResponse.clone().text());
  const removed = await removeResponse.json();
  assert.equal(removed.state, "removed");
  assert.equal(removed.session.id, removableSessionId);
  assert.equal(fs.existsSync(originalFile), false);
  assert.equal(fs.existsSync(path.join(sessionDir, "removed", path.basename(originalFile))), true);

  const removedDetail = await serverFetch(
    `/api/sessions/${encodeURIComponent(removableSessionId)}?projectId=${projectId}`,
  );
  assert.equal(removedDetail.status, 410, await removedDetail.clone().text());

  const activeAfterRemove = await (await serverFetch(`/api/sessions?projectId=${projectId}`)).json();
  assert.equal(activeAfterRemove.sessions.some((session) => session.id === removableSessionId), false);
  const removedList = await (await serverFetch(`/api/sessions/removed?projectId=${projectId}`)).json();
  assert.equal(removedList.sessions.some((session) => session.id === removableSessionId), true);
  assert.equal(removedList.retentionDays, 30);

  const settingsResponse = await serverFetch(`/api/sessions/removed/settings?projectId=${projectId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ removedRetentionDays: 14 }),
  });
  assert.equal(settingsResponse.status, 200, await settingsResponse.clone().text());
  assert.deepEqual(await settingsResponse.json(), { removedRetentionDays: 14 });

  const restoreResponse = await serverFetch(
    `/api/sessions/removed/${encodeURIComponent(removableSessionId)}/restore?projectId=${projectId}`,
    { method: "POST" },
  );
  assert.equal(restoreResponse.status, 200, await restoreResponse.clone().text());
  assert.equal(fs.existsSync(originalFile), true);

  assert.equal((await serverFetch(
    `/api/sessions/${encodeURIComponent(removableSessionId)}/remove?projectId=${projectId}`,
    { method: "POST" },
  )).status, 200);
  const purgeResponse = await serverFetch(
    `/api/sessions/removed/${encodeURIComponent(removableSessionId)}?projectId=${projectId}`,
    { method: "DELETE" },
  );
  assert.equal(purgeResponse.status, 200, await purgeResponse.clone().text());
  assert.equal((await purgeResponse.json()).state, "purged");
  assert.equal(fs.existsSync(path.join(sessionDir, "removed", path.basename(originalFile))), false);
  const purgedDetail = await serverFetch(
    `/api/sessions/${encodeURIComponent(removableSessionId)}?projectId=${projectId}`,
  );
  assert.equal(purgedDetail.status, 410, await purgedDetail.clone().text());
});

test("the frontend and backend share one validated .chat root configuration", async () => {
  const initialResponse = await serverFetch("/api/chat-config");
  assert.equal(initialResponse.status, 200);
  assert.equal((await initialResponse.json()).defaultWorkflowId, "minimal-pi-coding-agent");

  const updateResponse = await serverFetch("/api/chat-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schemaVersion: 1,
      defaultWorkflowId: "memory",
      workflows: { memory: { agents: { "memory-agent": {} } } },
    }),
  });
  assert.equal(updateResponse.status, 200);
  assert.equal((await updateResponse.json()).defaultWorkflowId, "memory");
  assert.equal(fs.existsSync(path.join(chatHome, "config.json")), true);
});

test("the model editor reads and writes only Chat Home's models configuration", async () => {
  const readResponse = await serverFetch("/api/models-config");
  const initial = await readResponse.json();
  assert.equal(readResponse.status, 200, JSON.stringify(initial));
  assert.deepEqual(initial.source, {
    kind: "chat-home",
    path: path.join(chatHome, "agent", "models.json"),
  });
  assert.equal(initial.config.providers["built-runtime"].models[0].id, "built-runtime-model");

  const writeResponse = await serverFetch("/api/models-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(initial.config),
  });
  const saved = await writeResponse.json();
  assert.equal(writeResponse.status, 200, JSON.stringify(saved));
  assert.deepEqual(saved, initial);
  assert.equal(fs.existsSync(path.join(chatHome, "agent", "models.json")), true);
});

test("Workflow containers and their Agents come from the backend registry", async () => {
  const response = await serverFetch("/api/workflows");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.workflows.map((workflow) => workflow.id), [
    "minimal-pi-coding-agent",
    "planning-execution",
    "planner-orchestrator",
    "memory",
    "rule-management",
    "session-memory",
    "problem-diagnosis",
    "topic-session-create",
  ]);
  assert.deepEqual(body.workflows.map((workflow) => workflow.agents.map((agent) => agent.id)), [
    ["pi-coding-agent", "session-memory-writer"],
    ["planner", "pi-coding-agent", "session-memory-writer"],
    ["planner", "coordinator", "session-memory-writer"],
    ["memory-agent", "session-memory-writer"],
    ["rule-curator-agent", "session-memory-writer"],
    ["session-memory-worker", "session-memory-writer"],
    ["problem-diagnoser", "session-memory-writer"],
    ["topic-collector", "topic-creator", "session-memory-writer"],
  ]);
  assert.deepEqual(body.workflows.map((workflow) => workflow.nodes.map((node) => node.agentId)), [
    ["pi-coding-agent", "session-memory-writer"],
    ["planner", undefined, "pi-coding-agent", "session-memory-writer"],
    ["planner", undefined, "coordinator", "session-memory-writer"],
    ["memory-agent", "session-memory-writer"],
    ["rule-curator-agent", "session-memory-writer"],
    ["session-memory-worker", "session-memory-writer"],
    ["problem-diagnoser", "session-memory-writer"],
    ["topic-collector", undefined, "topic-creator", "session-memory-writer"],
  ]);
  assert.equal(body.workflows[0].agentCallable, true);
  assert.equal(body.workflows[1].planReview, true);
  assert.equal(body.workflows[1].agentCallable, true);
  assert.equal(body.workflows[2].planReview, true);
  assert.equal(body.workflows[2].agentCallable, true);
  assert.equal(body.workflows[3].agentCallable, true);
  assert.equal(body.workflows[3].agents[0].configPath, "./agents/memory-agent/agent.json");
  assert.equal(body.workflows[4].agents[0].configPath, "./agents/rule-curator-agent/agent.json");
});

test("Tool catalog and Project Agent Tool policy use the production Pi assembly path", async () => {
  const catalogResponse = await serverFetch(`/api/tools?projectId=${projectId}`);
  const catalog = await catalogResponse.json();
  assert.equal(catalogResponse.status, 200, JSON.stringify(catalog));
  assert.deepEqual(
    catalog.tools.filter((tool) => tool.sourceInfo.scope === "system").map((tool) => tool.address),
    [
      "system:tool/friend_work",
      "system:tool/memory_search",
      "system:tool/memory_record",
      "system:tool/workflow_call",
      "system:tool/agent_memory_search",
      "system:tool/agent_memory_read",
      "system:tool/agent_memory_write",
    "system:tool/project_search",
    "system:tool/project_read",
    "system:tool/project_create",
    "system:tool/project_open",
    "system:tool/project_update",
    "system:tool/project_configure",
    "system:tool/long_agent_manage",
    "system:tool/channel_send",
    "system:tool/task_manage",
    "system:tool/duty_manage",
    "system:tool/artifact_manage",
    "system:tool/summary_manage",
    "system:tool/social_manage",
    "system:tool/conversation_manage",
    "system:tool/session_memory",
    "system:tool/topic_manage",
    "system:tool/collaboration_project",
    ],
  );
  const projectTool = catalog.tools.find((tool) => tool.name === "built_project_lookup");
  assert.ok(projectTool, JSON.stringify(catalog));
  assert.equal(projectTool.sourceInfo.scope, "project");
  assert.equal(projectTool.address, `project/${projectId}:tool/built_project_lookup`);
  assert.equal(typeof projectTool.version.contentHash, "string");
  const plannerSearch = catalog.tools.find((tool) => tool.address === "system:tool/memory_search");
  assert.equal(plannerSearch.consumers.some((consumer) => (
    consumer.workflowId === "planning-execution"
      && consumer.agentId === "planner"
      && consumer.source === "workflow-default"
      && consumer.enabled
  )), true);

  const saveResponse = await serverFetch(
    "/api/workflows/planning-execution/agents/planner/tool-config",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        tools: {
          mode: "explicit",
          names: ["built_project_lookup"],
          exclude: [],
          addresses: ["system:tool/memory_search"],
        },
      }),
    },
  );
  const saved = await saveResponse.json();
  assert.equal(saveResponse.status, 200, JSON.stringify(saved));
  assert.deepEqual(saved.tools, {
    mode: "explicit",
    names: ["built_project_lookup"],
    exclude: [],
    addresses: ["system:tool/memory_search"],
  });

  const inspectionResponse = await serverFetch(
    "/api/workflows/planning-execution/agents/planner/resolve",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, cwd: workspace }),
    },
  );
  const inspection = await inspectionResponse.json();
  assert.equal(inspectionResponse.status, 200, JSON.stringify(inspection));
  assert.deepEqual(
    inspection.tools.filter((tool) => tool.active).map((tool) => tool.name).sort(),
    ["built_project_lookup", "memory_search"],
  );
  assert.equal(inspection.agent.durableConfig.tools.mode, "explicit");

  const clearResponse = await serverFetch(
    `/api/workflows/planning-execution/agents/planner/tool-config?projectId=${projectId}`,
    { method: "DELETE" },
  );
  assert.equal(clearResponse.status, 200);
  assert.deepEqual(await clearResponse.json(), { schemaVersion: 1, removed: true });
});

test("the built server executes a real local Workflow Run through transformed modules", async () => {
  const startResponse = await serverFetch("/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      cwd: workspace,
      prompt: "Run the deterministic Workflow Runtime smoke test.",
      workflow: "minimal-pi-coding-agent",
      agentConfigs: {
        "pi-coding-agent": {
          resources: {
            mode: "explicit",
            skillPaths: [projectSkillPath],
            extensionPaths: [],
            pluginSources: [],
          },
        },
      },
    }),
  });
  const started = await startResponse.json();
  assert.equal(startResponse.status, 202, JSON.stringify(started));
  assert.equal(typeof started.runId, "string");
  assert.equal(typeof started.sessionId, "string");
  assert.equal(started.isNewSession, true);
  const acceptedSessionsResponse = await serverFetch(`/api/sessions?projectId=${projectId}`);
  const acceptedSessions = await acceptedSessionsResponse.json();
  assert.equal(acceptedSessionsResponse.status, 200, JSON.stringify(acceptedSessions));
  assert.ok(acceptedSessions.sessions.some((session) => session.id === started.sessionId));

  const deadline = Date.now() + 10_000;
  let status;
  do {
    const response = await serverFetch(`/runs/${encodeURIComponent(started.runId)}`);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    status = body;
    if (status.status === "completed" || status.status === "failed" || status.status === "cancelled") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);

  assert.equal(status?.status, "completed", JSON.stringify(status));
  assert.equal(status.result.sessionId, started.sessionId);
  assert.equal(status.result.text, "Workflow runtime smoke completed.");
});

test("the built planning Workflow survives review and resumes the same Session", async () => {
  const blockingResponse = await serverFetch("/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      cwd: workspace,
      prompt: "A blocking endpoint cannot review this plan.",
      workflow: "planning-execution",
    }),
  });
  assert.equal(blockingResponse.status, 400);
  assert.match(await blockingResponse.text(), /POST \/runs/);

  const startResponse = await serverFetch("/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      cwd: workspace,
      prompt: "Plan, wait for approval, and then run the built smoke test.",
      workflow: "planning-execution",
    }),
  });
  const started = await startResponse.json();
  assert.equal(startResponse.status, 202, JSON.stringify(started));
  assert.equal(typeof started.workflowInvocationId, "string");
  assert.equal(typeof started.sessionId, "string");
  assert.equal(started.isNewSession, true);
  const query = new URLSearchParams({
    projectId,
    workflowInvocationId: started.workflowInvocationId,
  });
  const statusPath = `/runs/${encodeURIComponent(started.runId)}?${query.toString()}`;

  const reviewDeadline = Date.now() + 10_000;
  let reviewStatus;
  do {
    const response = await serverFetch(statusPath);
    reviewStatus = await response.json();
    assert.equal(response.status, 200, JSON.stringify(reviewStatus));
    if (reviewStatus.phase === "waiting_review") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < reviewDeadline);
  assert.equal(reviewStatus?.phase, "waiting_review", JSON.stringify(reviewStatus));
  assert.equal(reviewStatus.review.sessionId, started.sessionId);
  assert.equal(reviewStatus.review.planRevision, 1);
  assert.equal(reviewStatus.review.readiness, "ready_for_review");
  assert.deepEqual(reviewStatus.review.blockingQuestions, []);

  const waitingSessionResponse = await serverFetch(
    `/api/sessions/${encodeURIComponent(reviewStatus.review.sessionId)}?projectId=${projectId}`,
  );
  const waitingSession = await waitingSessionResponse.json();
  assert.equal(waitingSessionResponse.status, 200, JSON.stringify(waitingSession));
  assert.equal(waitingSession.activePlanningExecution.runId, started.runId);
  assert.equal(waitingSession.activePlanningExecution.review.reviewId, reviewStatus.review.reviewId);
  assert.deepEqual(waitingSession.context.messages.map((message) => message.role), ["user", "assistant"]);

  const staleApproval = await serverFetch(`/runs/${encodeURIComponent(started.runId)}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      decision: {
        kind: "approve",
        reviewId: reviewStatus.review.reviewId,
        workflowInvocationId: started.workflowInvocationId,
        planRevision: 99,
        planSha256: reviewStatus.review.planSha256,
      },
    }),
  });
  assert.equal(staleApproval.status, 409);

  const approval = await serverFetch(`/runs/${encodeURIComponent(started.runId)}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      decision: {
        kind: "approve",
        reviewId: reviewStatus.review.reviewId,
        workflowInvocationId: started.workflowInvocationId,
        planRevision: reviewStatus.review.planRevision,
        planSha256: reviewStatus.review.planSha256,
      },
    }),
  });
  assert.equal(approval.status, 202, await approval.text());

  const completionDeadline = Date.now() + 10_000;
  let completed;
  do {
    const response = await serverFetch(statusPath);
    completed = await response.json();
    assert.equal(response.status, 200, JSON.stringify(completed));
    if (["completed", "failed", "cancelled"].includes(completed.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < completionDeadline);
  assert.equal(completed?.status, "completed", JSON.stringify(completed));
  assert.equal(completed.result.sessionId, reviewStatus.review.sessionId);
  assert.equal(completed.result.text, "Workflow runtime smoke completed.");

  const completedSessionResponse = await serverFetch(
    `/api/sessions/${encodeURIComponent(reviewStatus.review.sessionId)}?projectId=${projectId}`,
  );
  const completedSession = await completedSessionResponse.json();
  assert.equal(completedSessionResponse.status, 200, JSON.stringify(completedSession));
  assert.deepEqual(
    // work answer + the session-memory writer's own reply (the Workflow's LAST node).
    completedSession.context.messages.map((message) => message.role),
    ["user", "assistant", "user", "assistant", "assistant"],
  );
  assert.deepEqual(completedSession.context.messages[2].content, [
    { type: "text", text: "已通过执行计划 v1，开始执行。" },
  ]);

  const replayedApproval = await serverFetch(`/runs/${encodeURIComponent(started.runId)}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      decision: {
        kind: "approve",
        reviewId: reviewStatus.review.reviewId,
        workflowInvocationId: started.workflowInvocationId,
        planRevision: reviewStatus.review.planRevision,
        planSha256: reviewStatus.review.planSha256,
      },
    }),
  });
  const replayedApprovalBody = await replayedApproval.json();
  assert.equal(replayedApproval.status, 202, JSON.stringify(replayedApprovalBody));
  assert.equal(replayedApprovalBody.replayed, true);
});

test("Memory Agent inspection exposes its Workflow-owned tools and Skill", async () => {
  const response = await serverFetch(
    "/api/workflows/memory/agents/memory-agent/resolve",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, cwd: workspace }),
    },
  );
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(
    body.tools.filter((tool) => tool.active).map((tool) => tool.name).sort(),
    [
      "memory_delete",
      "memory_get",
      "memory_list",
      "memory_record",
      "memory_search",
      "memory_update",
    ].sort(),
  );
  assert.deepEqual(body.skills.map((skill) => skill.name), ["memory"]);
  const memorySearch = body.tools.find((tool) => tool.name === "memory_search");
  assert.equal(memorySearch.sourceInfo.source, "chat-system");
  assert.equal(memorySearch.address, "system:tool/memory_search");
  assert.equal(memorySearch.risk, "read-only");

  const catalogResponse = await serverFetch(
    `/api/workflows/memory/agents/memory-agent/catalog?projectId=${projectId}&cwd=${encodeURIComponent(workspace)}`,
  );
  const catalog = await catalogResponse.json();
  assert.equal(catalogResponse.status, 200, JSON.stringify(catalog));
  assert.equal(catalog.skills.some((skill) => skill.name === "chat-architecture"), true);
  assert.equal(catalog.skills.some((skill) => skill.name === "memory"), false);
  assert.equal(
    catalog.skills.find((skill) => skill.name === "chat-architecture").filePath,
    fs.realpathSync(projectSkillPath),
  );
  assert.equal(
    catalog.extensions.some((extension) => extension.resolvedPath.endsWith("built-extension.ts")),
    true,
    JSON.stringify(catalog.extensions),
  );
});

test("Rule Curator inspection uses the unified Agent path with its Skill and Tools", async () => {
  const response = await serverFetch(
    "/api/workflows/rule-management/agents/rule-curator-agent/resolve",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, cwd: workspace }),
    },
  );
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(
    body.tools.filter((tool) => tool.active).map((tool) => tool.name),
    [
      "session_context_read",
      "prompt_resource_search",
      "prompt_resource_get",
      "prompt_resource_list_drafts",
      "prompt_resource_create_draft",
      "prompt_resource_update_draft",
      "prompt_resource_commit_draft",
      "prompt_resource_propose_for_agent",
      "prompt_resource_apply_proposal",
      "prompt_resource_dismiss_proposal",
    ],
  );
  assert.deepEqual(body.skills.map((skill) => skill.name), ["rule-library"]);
  assert.match(
    body.skills.find((skill) => skill.name === "rule-library").content,
    /when it applies.*what the target Agent must obey/s,
  );
  assert.match(body.skills.find((skill) => skill.name === "rule-library").content, /stable Project document/);
  assert.equal(body.tools.find((tool) => tool.name === "prompt_resource_search").sourceInfo.source, "sdk");
});

test("Workflow Coordinator inspection exposes only its private delegation Skill and Tool", async () => {
  const response = await serverFetch(
    "/api/workflows/planner-orchestrator/agents/coordinator/resolve",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, cwd: workspace }),
    },
  );
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body.tools.filter((tool) => tool.active).map((tool) => tool.name), ["workflow_call"]);
  assert.deepEqual(body.skills.map((skill) => skill.name), ["workflow-delegation"]);
  assert.match(
    body.skills.find((skill) => skill.name === "workflow-delegation").content,
    /Use `workflow_call` with `action=start` exactly once for each work package/,
  );
  assert.equal(body.tools.find((tool) => tool.name === "workflow_call").sourceInfo.source, "chat-system");
});

test("Direct Agent keeps Pi defaults and receives workflow_call from the system Tool registry", async () => {
  const response = await serverFetch(
    "/api/workflows/minimal-pi-coding-agent/agents/pi-coding-agent/resolve",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, cwd: workspace }),
    },
  );
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.tools.some((tool) => tool.active && tool.name === "bash"), true);
  const workflowCall = body.tools.find((tool) => tool.name === "workflow_call");
  assert.equal(workflowCall.active, true);
  assert.equal(workflowCall.address, "system:tool/workflow_call");
  assert.equal(workflowCall.sourceInfo.source, "chat-system");
  assert.match(body.prompt.final, /`memory` \(长期记忆\)/);
  assert.match(body.prompt.final, /`minimal-pi-coding-agent` \(直接执行\)/);
});

test("Pi resources are served by Chat from the managed Agent directory", async () => {
  const skillsResponse = await serverFetch(`/api/skills?projectId=${projectId}&cwd=${encodeURIComponent(workspace)}`);
  assert.equal(skillsResponse.status, 200);
  const skills = await skillsResponse.json();
  const skill = skills.skills.find((item) => item.name === "built-review");
  assert.ok(skill);

  const toggleResponse = await serverFetch("/api/skills", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, cwd: workspace, filePath: skill.filePath, disableModelInvocation: true }),
  });
  assert.equal(toggleResponse.status, 200);

  const extensionsResponse = await serverFetch(`/api/extensions?projectId=${projectId}&cwd=${encodeURIComponent(workspace)}`);
  assert.equal(extensionsResponse.status, 200);
  assert.ok((await extensionsResponse.json()).extensions.some((extension) => extension.name === "built-extension"));

  const pluginsResponse = await serverFetch(`/api/plugins?projectId=${projectId}&cwd=${encodeURIComponent(workspace)}`);
  assert.equal(pluginsResponse.status, 200);
  assert.deepEqual((await pluginsResponse.json()).packages, []);
});

test("Prompt resource production API is read-only and target-aware", async () => {
  const draftResponse = await serverFetch(`/api/prompt-resources/drafts?projectId=${projectId}`);
  assert.equal(draftResponse.status, 200);
  assert.deepEqual((await draftResponse.json()).drafts, []);

  const mutationResponse = await serverFetch(`/api/prompt-resources/drafts?projectId=${projectId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "rule" }),
  });
  assert.ok([404, 405].includes(mutationResponse.status));

  const listResponse = await serverFetch(
    `/api/prompt-resources?projectId=${projectId}&target=project&targetProjectId=${projectId}&q=production-test&status=all`,
  );
  assert.equal(listResponse.status, 200);
  const listed = (await listResponse.json()).resources;
  assert.deepEqual(listed.map((item) => item.id), [promptResourceId]);
  assert.deepEqual(listed[0].target, { type: "project", projectId });

  const historyResponse = await serverFetch(
    `/api/prompt-resources/${encodeURIComponent(promptResourceId)}/history?projectId=${projectId}&target=project&targetProjectId=${projectId}`,
  );
  assert.equal(historyResponse.status, 200);
  assert.deepEqual((await historyResponse.json()).revisions.map((item) => item.revision), [1]);

  const builtInResponse = await serverFetch(
    `/api/prompt-resources?projectId=${projectId}&target=personal&kind=experience&q=22.19.0&status=all`,
  );
  assert.equal(builtInResponse.status, 200);
  const builtIns = (await builtInResponse.json()).resources;
  assert.deepEqual(builtIns.map((item) => item.id), ["workflow-runtime-artifact-validation"]);
  assert.equal(builtIns[0].revision, 5);
  assert.equal(builtIns[0].kind, "experience");
  assert.deepEqual(builtIns[0].target, { type: "personal" });

  const builtInRuleResponse = await serverFetch(
    `/api/prompt-resources?projectId=${projectId}&target=personal&kind=rule&q=Agent%E8%83%BD%E5%8A%9B%E5%AE%8C%E5%A4%87%E6%80%A7&status=all`,
  );
  assert.equal(builtInRuleResponse.status, 200);
  const builtInRules = (await builtInRuleResponse.json()).resources;
  assert.deepEqual(builtInRules.map((item) => item.id), ["agent-capability-design-contract"]);
  assert.equal(builtInRules[0].revision, 1);
  assert.equal(builtInRules[0].kind, "rule");
  assert.deepEqual(builtInRules[0].target, { type: "personal" });
});

test("full history exports the managed Chat Session as standalone HTML", async () => {
  const inlineResponse = await serverFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/export?inline=1&projectId=${projectId}`,
  );
  assert.equal(inlineResponse.status, 200);
  assert.match(inlineResponse.headers.get("content-type") ?? "", /text\/html/);
  assert.match(inlineResponse.headers.get("content-disposition") ?? "", /^inline;/);
  assert.equal(inlineResponse.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(inlineResponse.headers.get("content-security-policy"), "frame-ancestors 'self'");
  assert.equal(inlineResponse.headers.get("x-content-type-options"), "nosniff");
  const html = await inlineResponse.text();
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /id="chat-workflow-history-styles"/);
  assert.match(html, /createChatWorkflowGroup/);

  const missingResponse = await serverFetch("/api/sessions/not-a-chat-session/export?inline=1");
  assert.equal(missingResponse.status, 404);
});

test("file list, metadata, and text reads use the Pi Web-compatible contract", async () => {
  const encodedWorkspace = encodeFilePath(workspace);
  const listResponse = await serverFetch(`/api/files/${encodedWorkspace}?type=list`);
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.equal(list.entries.some((entry) => entry.name === "fixture.md"), true);

  const encodedFile = `${encodedWorkspace}/fixture.md`;
  const metaResponse = await serverFetch(`/api/files/${encodedFile}?type=meta`);
  assert.equal(metaResponse.status, 200);
  assert.equal((await metaResponse.json()).language, "markdown");

  const readResponse = await serverFetch(`/api/files/${encodedFile}?type=read`);
  assert.equal(readResponse.status, 200);
  assert.deepEqual(await readResponse.json(), {
    content: "# Built server fixture\n",
    language: "markdown",
    size: 23,
  });
});

test("file access outside Chat-authorized roots is rejected", async () => {
  if (process.platform === "win32") return;
  const response = await serverFetch("/api/files/etc/passwd?type=read");
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Access denied" });
});


test("built Project Skill and all six tools execute through a real Workflow and Pi", async () => {
  await exerciseProjectManagementRun(serverFetch, { chatHome, projectId, workspace });
});

test("shipped Workflow TUI shares Web Sessions, review, Fork and cancellation on the built server", async () => {
  await exerciseWorkflowTui({ baseUrl, projectId });
});


test("reviewed Workflows support repeated conversations and bounded format repair without rewriting history", async () => {
  await exercisePlannerConversation(serverFetch, { projectId, workspace, chatHome });
});

test("fresh installation serves Web and model setup before Provider credentials are configured", async t => {
  const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chat-fresh-install-"));
  const freshHome = path.join(freshRoot, "home");
  fs.mkdirSync(path.join(freshHome, "agent"), { recursive: true });
  fs.copyFileSync(path.join(projectRoot, "deploy/settings.json.example"), path.join(freshHome, "agent/settings.json"));
  const port = await reservePort();
  const fresh = spawn(process.execPath, [serverEntry], {
    cwd: freshRoot,
    env: {
      PATH: process.env.PATH,
      HOME: freshHome,
      HOST: "127.0.0.1", PORT: String(port), CHAT_HOME: freshHome,
      WORKFLOW_TARGET_WORLD: "local",
      WORKFLOW_LOCAL_DATA_DIR: path.join(freshHome, "runtime/workflow-data"),
      CHAT_CHANNEL_GATEWAY_TOKEN: "fresh-install-fixture-channel-service-token",
      MEM0_TELEMETRY: "false", PI_OFFLINE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  fresh.stdout.on("data", chunk => { output += chunk; });
  fresh.stderr.on("data", chunk => { output += chunk; });
  t.after(async () => {
    if (fresh.exitCode === null) {
      const stopped = new Promise(resolve => fresh.once("exit", resolve));
      fresh.kill("SIGINT");
      const timeout = setTimeout(() => fresh.kill("SIGKILL"), 5000);
      await stopped;
      clearTimeout(timeout);
    }
    fs.rmSync(freshRoot, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(500) });
      ready = response.ok && (await response.json()).service === "chat";
    } catch { /* The server has not bound its socket yet. */ }
    if (ready || fresh.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, output);
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(`${url}/api/models-config`)).status, 200);
  assert.equal(fs.existsSync(path.join(freshHome, "agent/auth.json")), false, "installation must not invent Provider credentials");
});
