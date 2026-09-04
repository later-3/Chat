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
let server;
let embeddingServer;
let baseUrl;
let serverOutput = "";
let authenticatedCookiePromise;
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

async function authenticatedCookie() {
  authenticatedCookiePromise ??= (async () => {
    const response = await fetch(`${baseUrl}/api/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
      body: JSON.stringify({ username: "test-user", password: "123456", persistent: true }),
    });
    assert.equal(response.status, 200);
    const setCookie = response.headers.get("set-cookie");
    assert.ok(setCookie);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=Lax/i);
    return setCookie.split(";", 1)[0];
  })();
  return authenticatedCookiePromise;
}

async function authenticatedFetch(pathname, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cookie", await authenticatedCookie());
  return fetch(`${baseUrl}${pathname}`, { ...init, headers });
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
      CHAT_WEB_AUTH_ENABLED: "1",
      CHAT_WEB_AUTH_USERNAME: "test-user",
      CHAT_WEB_AUTH_PASSWORD: "123456",
      CHAT_WEB_AUTH_SESSION_SECRET: "built-server-test-session-secret-at-least-32-characters",
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
  const opened = await authenticatedFetch("/api/projects/open", {
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
  const redirectResponse = await fetch(`${baseUrl}/`, { redirect: "manual" });
  assert.equal(redirectResponse.status, 307);
  assert.equal(redirectResponse.headers.get("location"), "/login?next=%2F");

  const response = await authenticatedFetch("/");
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

test("health is public while Chat product APIs require login", async () => {
  const healthResponse = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), { ok: true, service: "chat" });

  const unauthorized = await fetch(`${baseUrl}/api/sessions`);
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("x-chat-auth-required"), "1");
  assert.deepEqual(await unauthorized.json(), { error: "Authentication required" });

  const unauthorizedMemory = await fetch(`${baseUrl}/api/memories`);
  assert.equal(unauthorizedMemory.status, 401);

  const loginPage = await fetch(`${baseUrl}/login`);
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /登录到 Chat/);
});

test("memory management API persists, searches, updates, rebuilds, and deletes", async () => {
  const createResponse = await authenticatedFetch("/api/memories", {
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

  const listResponse = await authenticatedFetch("/api/memories?kind=decision");
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.equal(list.total, 1);
  assert.equal(list.items[0].id, created.id);

  const detailResponse = await authenticatedFetch(`/api/memories/${created.id}`);
  assert.equal(detailResponse.status, 200);
  assert.equal((await detailResponse.json()).memory.text, created.text);

  const searchResponse = await authenticatedFetch("/api/memories/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "MEMORY_HTTP_ALPHA", topK: 1 }),
  });
  assert.equal(searchResponse.status, 200);
  assert.equal((await searchResponse.json()).results[0].memory.id, created.id);

  const updatedText = "Later 选择 MEMORY_HTTP_BETA 作为 Chat 的长期记忆方案。";
  const updateResponse = await authenticatedFetch(`/api/memories/${created.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target: { type: "personal" }, text: updatedText }),
  });
  assert.equal(updateResponse.status, 200);
  const updated = (await updateResponse.json()).memory;
  assert.equal(updated.text, updatedText);
  assert.equal(updated.version, 2);
  assert.equal(updated.indexStatus, "indexed");

  const rebuildResponse = await authenticatedFetch("/api/memories/rebuild", {
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

  const rebuiltSearchResponse = await authenticatedFetch("/api/memories/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "MEMORY_HTTP_BETA", topK: 1 }),
  });
  assert.equal(rebuiltSearchResponse.status, 200);
  assert.equal((await rebuiltSearchResponse.json()).results[0].memory.id, created.id);

  const healthResponse = await authenticatedFetch("/api/memories/health");
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), {
    records: 1,
    indexed: 1,
    pending: 0,
    failed: 0,
    pendingDeletions: 0,
  });

  const deleteResponse = await authenticatedFetch(`/api/memories/${created.id}`, { method: "DELETE" });
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), {
    id: created.id,
    deleted: true,
    indexCleanup: "completed",
  });
  assert.equal((await (await authenticatedFetch("/api/memories")).json()).total, 0);
  assert.equal(fs.existsSync(path.join(chatHome, "memory", "personal", "catalog.db")), true);
  assert.equal(fs.existsSync(path.join(chatHome, "memory", "personal", "vector-store.db")), true);
});

test("the configured account creates a signed HttpOnly session", async () => {
  const rejected = await fetch(`${baseUrl}/api/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "test-user", password: "wrong", persistent: true }),
  });
  assert.equal(rejected.status, 401);

  const cookie = await authenticatedCookie();
  const sessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { Cookie: cookie },
  });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  assert.equal(session.authenticated, true);
  assert.equal(session.username, "test-user");

  const devicesResponse = await authenticatedFetch("/api/devices");
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
    const response = await authenticatedFetch("/api/projects/open", {
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

  const homeResponse = await authenticatedFetch("/api/home");
  assert.equal(homeResponse.status, 200);
  const home = await homeResponse.json();
  assert.deepEqual(Object.keys(home), ["home"]);

  const forgedIdentity = await authenticatedFetch("/api/projects/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: child, id: "chat" }),
  });
  assert.equal(forgedIdentity.status, 400);
});

test("session list and detail come from the isolated Chat session directory", async () => {
  const listResponse = await authenticatedFetch(`/api/sessions?projectId=${projectId}`);
  assert.equal(listResponse.status, 200);
  assert.match(listResponse.headers.get("cache-control") ?? "", /no-store/);
  const list = await listResponse.json();
  assert.deepEqual(list.sessions.map((session) => session.id), [sessionId]);

  const detailResponse = await authenticatedFetch(`/api/sessions/${encodeURIComponent(sessionId)}?projectId=${projectId}&deferThinking=1&deferMedia=1`);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.deepEqual(detail.context.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(detail.context.messages.length, detail.context.entryIds.length);
  assert.deepEqual(detail.workflowCallTree, []);
  assert.deepEqual(detail.workflowCallStatistics.capacity, { active: 0, limit: 8 });

  const workflowCallsResponse = await authenticatedFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/workflow-calls?projectId=${projectId}`,
  );
  assert.equal(workflowCallsResponse.status, 200, await workflowCallsResponse.clone().text());
  assert.match(workflowCallsResponse.headers.get("cache-control") ?? "", /no-store/);
  const workflowCalls = await workflowCallsResponse.json();
  assert.deepEqual(workflowCalls.workflowCallTree, []);
  assert.deepEqual(workflowCalls.workflowCallStatistics, detail.workflowCallStatistics);

  const unknownCallResponse = await authenticatedFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/workflow-calls/missing-call?projectId=${projectId}`,
    { method: "DELETE" },
  );
  assert.equal(unknownCallResponse.status, 409);
  assert.match(await unknownCallResponse.text(), /不存在Workflow调用/);

  const renameResponse = await authenticatedFetch(`/api/sessions/${encodeURIComponent(sessionId)}?projectId=${projectId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Built Session" }),
  });
  assert.equal(renameResponse.status, 200, await renameResponse.clone().text());
  assert.deepEqual(await renameResponse.json(), { sessionId, name: "Built Session" });
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

  const detailResponse = await authenticatedFetch(
    `/api/sessions/${encodeURIComponent(manager.getSessionId())}?projectId=${projectId}&deferMedia=1`,
  );
  assert.equal(detailResponse.status, 200, await detailResponse.clone().text());
  const detail = await detailResponse.json();
  const toolResult = detail.context.messages.find((message) => message.role === "toolResult");
  const image = toolResult?.content.find((block) => block.type === "image");
  assert.match(image?.source?.url ?? "", /tool-result-image\?blockIndex=1&projectId=built-project$/);

  const imageResponse = await authenticatedFetch(image.source.url);
  assert.equal(imageResponse.status, 200, await imageResponse.clone().text());
  assert.equal(imageResponse.headers.get("content-type"), "image/png");
  assert.equal(imageResponse.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual([...new Uint8Array(await imageResponse.arrayBuffer())], [65, 66, 67, 68]);
});

test("the bounded file index supports client preload and server-ranked search", async () => {
  const indexResponse = await authenticatedFetch(`/api/file-index?cwd=${encodeURIComponent(workspace)}`);
  assert.equal(indexResponse.status, 200, await indexResponse.clone().text());
  const index = await indexResponse.json();
  assert.equal(index.files.includes("fixture.md"), true);
  assert.equal(index.truncated, false);

  const searchResponse = await authenticatedFetch(
    `/api/file-index?cwd=${encodeURIComponent(workspace)}&q=fixture`,
  );
  assert.equal(searchResponse.status, 200, await searchResponse.clone().text());
  assert.equal((await searchResponse.json()).matches[0].path, "fixture.md");

  const outsideResponse = await authenticatedFetch(
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

  const removeResponse = await authenticatedFetch(
    `/api/sessions/${encodeURIComponent(removableSessionId)}/remove?projectId=${projectId}`,
    { method: "POST" },
  );
  assert.equal(removeResponse.status, 200, await removeResponse.clone().text());
  const removed = await removeResponse.json();
  assert.equal(removed.state, "removed");
  assert.equal(removed.session.id, removableSessionId);
  assert.equal(fs.existsSync(originalFile), false);
  assert.equal(fs.existsSync(path.join(sessionDir, "removed", path.basename(originalFile))), true);

  const removedDetail = await authenticatedFetch(
    `/api/sessions/${encodeURIComponent(removableSessionId)}?projectId=${projectId}`,
  );
  assert.equal(removedDetail.status, 410, await removedDetail.clone().text());

  const activeAfterRemove = await (await authenticatedFetch(`/api/sessions?projectId=${projectId}`)).json();
  assert.equal(activeAfterRemove.sessions.some((session) => session.id === removableSessionId), false);
  const removedList = await (await authenticatedFetch(`/api/sessions/removed?projectId=${projectId}`)).json();
  assert.equal(removedList.sessions.some((session) => session.id === removableSessionId), true);
  assert.equal(removedList.retentionDays, 30);

  const settingsResponse = await authenticatedFetch(`/api/sessions/removed/settings?projectId=${projectId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ removedRetentionDays: 14 }),
  });
  assert.equal(settingsResponse.status, 200, await settingsResponse.clone().text());
  assert.deepEqual(await settingsResponse.json(), { removedRetentionDays: 14 });

  const restoreResponse = await authenticatedFetch(
    `/api/sessions/removed/${encodeURIComponent(removableSessionId)}/restore?projectId=${projectId}`,
    { method: "POST" },
  );
  assert.equal(restoreResponse.status, 200, await restoreResponse.clone().text());
  assert.equal(fs.existsSync(originalFile), true);

  assert.equal((await authenticatedFetch(
    `/api/sessions/${encodeURIComponent(removableSessionId)}/remove?projectId=${projectId}`,
    { method: "POST" },
  )).status, 200);
  const purgeResponse = await authenticatedFetch(
    `/api/sessions/removed/${encodeURIComponent(removableSessionId)}?projectId=${projectId}`,
    { method: "DELETE" },
  );
  assert.equal(purgeResponse.status, 200, await purgeResponse.clone().text());
  assert.equal((await purgeResponse.json()).state, "purged");
  assert.equal(fs.existsSync(path.join(sessionDir, "removed", path.basename(originalFile))), false);
  const purgedDetail = await authenticatedFetch(
    `/api/sessions/${encodeURIComponent(removableSessionId)}?projectId=${projectId}`,
  );
  assert.equal(purgedDetail.status, 410, await purgedDetail.clone().text());
});

test("the frontend and backend share one validated .chat root configuration", async () => {
  const initialResponse = await authenticatedFetch("/api/chat-config");
  assert.equal(initialResponse.status, 200);
  assert.equal((await initialResponse.json()).defaultWorkflowId, "minimal-pi-coding-agent");

  const updateResponse = await authenticatedFetch("/api/chat-config", {
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
  const readResponse = await authenticatedFetch("/api/models-config");
  const initial = await readResponse.json();
  assert.equal(readResponse.status, 200, JSON.stringify(initial));
  assert.deepEqual(initial.source, {
    kind: "chat-home",
    path: path.join(chatHome, "agent", "models.json"),
  });
  assert.equal(initial.config.providers["built-runtime"].models[0].id, "built-runtime-model");

  const writeResponse = await authenticatedFetch("/api/models-config", {
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
  const response = await authenticatedFetch("/api/workflows");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.workflows.map((workflow) => workflow.id), [
    "minimal-pi-coding-agent",
    "planning-execution",
    "planner-orchestrator",
    "memory",
    "rule-management",
  ]);
  assert.deepEqual(body.workflows.map((workflow) => workflow.agents.map((agent) => agent.id)), [
    ["pi-coding-agent"],
    ["planner", "pi-coding-agent"],
    ["planner", "coordinator"],
    ["memory-agent"],
    ["rule-curator-agent"],
  ]);
  assert.deepEqual(body.workflows.map((workflow) => workflow.nodes.map((node) => node.agentId)), [
    ["pi-coding-agent"],
    ["planner", undefined, "pi-coding-agent"],
    ["planner", undefined, "coordinator"],
    ["memory-agent"],
    ["rule-curator-agent"],
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
  const catalogResponse = await authenticatedFetch(`/api/tools?projectId=${projectId}`);
  const catalog = await catalogResponse.json();
  assert.equal(catalogResponse.status, 200, JSON.stringify(catalog));
  assert.deepEqual(
    catalog.tools.filter((tool) => tool.sourceInfo.scope === "system").map((tool) => tool.address),
    ["system:tool/memory_search", "system:tool/memory_record", "system:tool/workflow_call"],
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

  const saveResponse = await authenticatedFetch(
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

  const inspectionResponse = await authenticatedFetch(
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

  const clearResponse = await authenticatedFetch(
    `/api/workflows/planning-execution/agents/planner/tool-config?projectId=${projectId}`,
    { method: "DELETE" },
  );
  assert.equal(clearResponse.status, 200);
  assert.deepEqual(await clearResponse.json(), { schemaVersion: 1, removed: true });
});

test("the built server executes a real local Workflow Run through transformed modules", async () => {
  const startResponse = await authenticatedFetch("/runs", {
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
  const acceptedSessionsResponse = await authenticatedFetch(`/api/sessions?projectId=${projectId}`);
  const acceptedSessions = await acceptedSessionsResponse.json();
  assert.equal(acceptedSessionsResponse.status, 200, JSON.stringify(acceptedSessions));
  assert.ok(acceptedSessions.sessions.some((session) => session.id === started.sessionId));

  const deadline = Date.now() + 10_000;
  let status;
  do {
    const response = await authenticatedFetch(`/runs/${encodeURIComponent(started.runId)}`);
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
  const blockingResponse = await authenticatedFetch("/run", {
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

  const startResponse = await authenticatedFetch("/runs", {
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
    const response = await authenticatedFetch(statusPath);
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

  const waitingSessionResponse = await authenticatedFetch(
    `/api/sessions/${encodeURIComponent(reviewStatus.review.sessionId)}?projectId=${projectId}`,
  );
  const waitingSession = await waitingSessionResponse.json();
  assert.equal(waitingSessionResponse.status, 200, JSON.stringify(waitingSession));
  assert.equal(waitingSession.activePlanningExecution.runId, started.runId);
  assert.equal(waitingSession.activePlanningExecution.review.reviewId, reviewStatus.review.reviewId);
  assert.deepEqual(waitingSession.context.messages.map((message) => message.role), ["user", "assistant"]);

  const staleApproval = await authenticatedFetch(`/runs/${encodeURIComponent(started.runId)}/review`, {
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

  const approval = await authenticatedFetch(`/runs/${encodeURIComponent(started.runId)}/review`, {
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
    const response = await authenticatedFetch(statusPath);
    completed = await response.json();
    assert.equal(response.status, 200, JSON.stringify(completed));
    if (["completed", "failed", "cancelled"].includes(completed.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < completionDeadline);
  assert.equal(completed?.status, "completed", JSON.stringify(completed));
  assert.equal(completed.result.sessionId, reviewStatus.review.sessionId);
  assert.equal(completed.result.text, "Workflow runtime smoke completed.");

  const completedSessionResponse = await authenticatedFetch(
    `/api/sessions/${encodeURIComponent(reviewStatus.review.sessionId)}?projectId=${projectId}`,
  );
  const completedSession = await completedSessionResponse.json();
  assert.equal(completedSessionResponse.status, 200, JSON.stringify(completedSession));
  assert.deepEqual(
    completedSession.context.messages.map((message) => message.role),
    ["user", "assistant", "user", "assistant"],
  );
  assert.deepEqual(completedSession.context.messages[2].content, [
    { type: "text", text: "已通过执行计划 v1，开始执行。" },
  ]);

  const replayedApproval = await authenticatedFetch(`/runs/${encodeURIComponent(started.runId)}/review`, {
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
  const response = await authenticatedFetch(
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

  const catalogResponse = await authenticatedFetch(
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
  const response = await authenticatedFetch(
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
  const response = await authenticatedFetch(
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
  const response = await authenticatedFetch(
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
  const skillsResponse = await authenticatedFetch(`/api/skills?projectId=${projectId}&cwd=${encodeURIComponent(workspace)}`);
  assert.equal(skillsResponse.status, 200);
  const skills = await skillsResponse.json();
  const skill = skills.skills.find((item) => item.name === "built-review");
  assert.ok(skill);

  const toggleResponse = await authenticatedFetch("/api/skills", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, cwd: workspace, filePath: skill.filePath, disableModelInvocation: true }),
  });
  assert.equal(toggleResponse.status, 200);

  const extensionsResponse = await authenticatedFetch(`/api/extensions?projectId=${projectId}&cwd=${encodeURIComponent(workspace)}`);
  assert.equal(extensionsResponse.status, 200);
  assert.ok((await extensionsResponse.json()).extensions.some((extension) => extension.name === "built-extension"));

  const pluginsResponse = await authenticatedFetch(`/api/plugins?projectId=${projectId}&cwd=${encodeURIComponent(workspace)}`);
  assert.equal(pluginsResponse.status, 200);
  assert.deepEqual((await pluginsResponse.json()).packages, []);
});

test("Prompt resource production API is read-only and target-aware", async () => {
  const draftResponse = await authenticatedFetch(`/api/prompt-resources/drafts?projectId=${projectId}`);
  assert.equal(draftResponse.status, 200);
  assert.deepEqual((await draftResponse.json()).drafts, []);

  const mutationResponse = await authenticatedFetch(`/api/prompt-resources/drafts?projectId=${projectId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "rule" }),
  });
  assert.ok([404, 405].includes(mutationResponse.status));

  const listResponse = await authenticatedFetch(
    `/api/prompt-resources?projectId=${projectId}&target=project&targetProjectId=${projectId}&q=production-test&status=all`,
  );
  assert.equal(listResponse.status, 200);
  const listed = (await listResponse.json()).resources;
  assert.deepEqual(listed.map((item) => item.id), [promptResourceId]);
  assert.deepEqual(listed[0].target, { type: "project", projectId });

  const historyResponse = await authenticatedFetch(
    `/api/prompt-resources/${encodeURIComponent(promptResourceId)}/history?projectId=${projectId}&target=project&targetProjectId=${projectId}`,
  );
  assert.equal(historyResponse.status, 200);
  assert.deepEqual((await historyResponse.json()).revisions.map((item) => item.revision), [1]);

  const builtInResponse = await authenticatedFetch(
    `/api/prompt-resources?projectId=${projectId}&target=personal&kind=experience&q=Pi+SDK&status=all`,
  );
  assert.equal(builtInResponse.status, 200);
  const builtIns = (await builtInResponse.json()).resources;
  assert.deepEqual(builtIns.map((item) => item.id), ["workflow-runtime-artifact-validation"]);
  assert.equal(builtIns[0].revision, 4);
  assert.equal(builtIns[0].kind, "experience");
  assert.deepEqual(builtIns[0].target, { type: "personal" });

  const builtInRuleResponse = await authenticatedFetch(
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
  const inlineResponse = await authenticatedFetch(
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

  const missingResponse = await authenticatedFetch("/api/sessions/not-a-chat-session/export?inline=1");
  assert.equal(missingResponse.status, 404);
});

test("file list, metadata, and text reads use the Pi Web-compatible contract", async () => {
  const encodedWorkspace = encodeFilePath(workspace);
  const listResponse = await authenticatedFetch(`/api/files/${encodedWorkspace}?type=list`);
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.equal(list.entries.some((entry) => entry.name === "fixture.md"), true);

  const encodedFile = `${encodedWorkspace}/fixture.md`;
  const metaResponse = await authenticatedFetch(`/api/files/${encodedFile}?type=meta`);
  assert.equal(metaResponse.status, 200);
  assert.equal((await metaResponse.json()).language, "markdown");

  const readResponse = await authenticatedFetch(`/api/files/${encodedFile}?type=read`);
  assert.equal(readResponse.status, 200);
  assert.deepEqual(await readResponse.json(), {
    content: "# Built server fixture\n",
    language: "markdown",
    size: 23,
  });
});

test("file access outside Chat-authorized roots is rejected", async () => {
  if (process.platform === "win32") return;
  const response = await authenticatedFetch("/api/files/etc/passwd?type=read");
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Access denied" });
});
