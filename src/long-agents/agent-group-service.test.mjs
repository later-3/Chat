import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRouter } from "nitro/h3";
import {
  buildAgentGroupContextInstructions,
  readLongAgentAgentGroup,
} from "./agent-group-service.ts";
import { writeLongAgentRegistry } from "./storage.ts";
import { resolveChatSystemTools } from "../tools/registry.ts";
import readAgentGroupHandler from "../routes/api/long-agents/[longAgentId]/agent-group.get.ts";
import updateAgentGroupHandler from "../routes/api/long-agents/[longAgentId]/agent-group.patch.ts";
import readAgentMemoryHandler from "../routes/api/long-agents/[longAgentId]/agent-memory.get.ts";
import updateAgentMemoryHandler from "../routes/api/long-agents/[longAgentId]/agent-memory.patch.ts";

const REVISION_A = `sha256:${"a".repeat(64)}`;
const REVISION_B = `sha256:${"b".repeat(64)}`;
const REVISION_C = `sha256:${"c".repeat(64)}`;
const TOKEN = "test-channel-token-that-is-at-least-32-characters";

function groupEnvelope(overrides = {}) {
  return {
    schemaVersion: 1,
    agentGroup: {
      id: "nano-agent-1",
      name: "Nexus Nano",
      standingInstructions: "Always maintain a clear working ledger.",
      revision: REVISION_A,
      workspace: { folder: "nexus", memoryFileCount: 3 },
      coreMemory: {
        index: {
          path: "index.md", content: "# Core\n\n- The user values continuity.", size: 37,
          updatedAt: "2026-09-06T01:02:03.000Z", revision: REVISION_B,
        },
        definition: {
          path: "system/definition.md",
          content: "# Memory protocol\n\nUse OKF Markdown.",
          size: 36,
          updatedAt: "2026-09-06T01:02:03.000Z",
          revision: REVISION_C,
        },
      },
      ...overrides,
    },
  };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function startNanoServer(requests) {
  const state = { groupGetStatus: 200, groupInvalidJson: false };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ schemaVersion: 1, error: "unauthorized" }));
      return;
    }
    const body = await readJson(request);
    requests.push({ path: url.pathname, body, authorization: request.headers.authorization });
    let result;
    if (url.pathname.endsWith("/agent-groups/get") && state.groupInvalidJson) {
      response.writeHead(200, { "Content-Type": "application/json" }).end("not-json");
      return;
    }
    if (url.pathname.endsWith("/agent-groups/get") && state.groupGetStatus !== 200) {
      response.writeHead(state.groupGetStatus, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ schemaVersion: 1, error: "unavailable group" }));
      return;
    }
    if (url.pathname.endsWith("/agent-groups/get")) result = groupEnvelope();
    else if (url.pathname.endsWith("/agent-groups/update")) {
      result = groupEnvelope({
        name: body.name ?? "Nexus Nano",
        standingInstructions: body.standingInstructions ?? "Always maintain a clear working ledger.",
        revision: REVISION_C,
      });
    } else if (url.pathname.endsWith("/memory/list")) {
      result = {
        schemaVersion: 1,
        agentGroupId: body.agentGroupId,
        files: [{ path: "index.md", size: 35, updatedAt: "2026-09-06T01:02:03.000Z", revision: REVISION_B }],
      };
    } else if (url.pathname.endsWith("/memory/read") || url.pathname.endsWith("/memory/write")) {
      result = {
        schemaVersion: 1,
        agentGroupId: body.agentGroupId,
        file: {
          path: body.path,
          content: body.content ?? "# Core\n\n- The user values continuity.",
          size: (body.content ?? "# Core\n\n- The user values continuity.").length,
          updatedAt: "2026-09-06T01:02:03.000Z",
          revision: REVISION_B,
        },
      };
    } else if (url.pathname.endsWith("/memory/delete")) {
      result = { schemaVersion: 1, agentGroupId: body.agentGroupId, deleted: true, path: body.path };
    } else if (url.pathname.endsWith("/memory/search")) {
      result = {
        schemaVersion: 1,
        agentGroupId: body.agentGroupId,
        results: [{ path: "index.md", revision: REVISION_B, score: 1, snippet: "continuity" }],
      };
    } else {
      response.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ schemaVersion: 1, error: "not found" }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, state, baseUrl: `http://127.0.0.1:${address.port}/webhook/chat-backend` };
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-agent-group-"));
  const chatHome = path.join(root, "home");
  const requests = [];
  const nano = await startNanoServer(requests);
  const previousToken = process.env.CHAT_CHANNEL_GATEWAY_TOKEN;
  process.env.CHAT_CHANNEL_GATEWAY_TOKEN = TOKEN;
  t.after(async () => {
    if (nano.server.listening) await closeServer(nano.server);
    if (previousToken === undefined) delete process.env.CHAT_CHANNEL_GATEWAY_TOKEN;
    else process.env.CHAT_CHANNEL_GATEWAY_TOKEN = previousToken;
    fs.rmSync(root, { recursive: true, force: true });
  });
  await writeLongAgentRegistry({
    schemaVersion: 1,
    instances: [{ id: "local", name: "Local", executionMode: "chat-pi", gatewayBaseUrl: nano.baseUrl }],
    agents: [{
      id: "nexus",
      name: "Nexus",
      description: "Daily coworker",
      enabled: true,
      instanceId: "local",
      nanoclawAgentGroupId: "nano-agent-1",
      defaultProjectId: "daily",
      inbox: {
        messagingGroupId: "mg-1",
        channelType: "telegram",
        instance: "telegram",
        platformId: "telegram:user-1",
        threadId: null,
      },
    }],
  }, chatHome);
  return { root, chatHome, requests, nano };
}

test("Agent Group live snapshot is strict, atomically cached, and used stale while NanoClaw is offline", { concurrency: false }, async (t) => {
  const { chatHome, nano } = await setup(t);
  const live = await readLongAgentAgentGroup("nexus", chatHome);
  assert.equal(live.stale, false);
  assert.equal(live.group.id, "nano-agent-1");
  assert.match(buildAgentGroupContextInstructions(live), /Always maintain a clear working ledger/);
  assert.match(buildAgentGroupContextInstructions(live), /The user values continuity/);
  assert.match(buildAgentGroupContextInstructions(live), /<runtime_identity_name>Nexus Nano<\/runtime_identity_name>/);
  assert.match(buildAgentGroupContextInstructions(live), /authoritative runtime identity/);

  const cachePath = path.join(chatHome, "runtime", "long-agents", "nexus", "agent-group-snapshot.json");
  const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  assert.equal(cache.longAgentId, "nexus");
  assert.equal(cache.agentGroupId, "nano-agent-1");
  assert.match(cache.contextRevision, /^sha256:[a-f0-9]{64}$/);
  assert.equal(cache.stale, false);
  assert.equal(fs.statSync(cachePath).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(path.dirname(cachePath)).some((name) => name.endsWith(".tmp")), false);
  const historyPath = path.join(
    chatHome,
    "runtime",
    "long-agents",
    "nexus",
    "snapshots",
    `${cache.contextRevision.slice("sha256:".length)}.json`,
  );
  const immutableBefore = fs.readFileSync(historyPath, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 2));
  const refreshed = await readLongAgentAgentGroup("nexus", chatHome);
  assert.notEqual(refreshed.fetchedAt, live.fetchedAt, "live projection must report this refresh time");
  assert.equal(fs.readFileSync(historyPath, "utf8"), immutableBefore, "same content revision must not overwrite history");

  nano.state.groupInvalidJson = true;
  await assert.rejects(readLongAgentAgentGroup("nexus", chatHome), /无效JSON/);
  nano.state.groupInvalidJson = false;
  nano.state.groupGetStatus = 404;
  await assert.rejects(readLongAgentAgentGroup("nexus", chatHome), /HTTP 404/);
  nano.state.groupGetStatus = 200;
  await closeServer(nano.server);
  const stale = await readLongAgentAgentGroup("nexus", chatHome);
  assert.equal(stale.stale, true);
  assert.equal(stale.group.revision, live.group.revision);
  assert.match(buildAgentGroupContextInstructions(stale), /最后有效缓存/);
});

test("Long Agent Agent Group and Memory browser APIs expose safe strict projections", { concurrency: false }, async (t) => {
  const { chatHome, requests } = await setup(t);
  const previousHome = process.env.CHAT_HOME;
  process.env.CHAT_HOME = chatHome;
  t.after(() => {
    if (previousHome === undefined) delete process.env.CHAT_HOME;
    else process.env.CHAT_HOME = previousHome;
  });
  const router = createRouter();
  router.get("/api/long-agents/:longAgentId/agent-group", readAgentGroupHandler);
  router.patch("/api/long-agents/:longAgentId/agent-group", updateAgentGroupHandler);
  router.get("/api/long-agents/:longAgentId/agent-memory", readAgentMemoryHandler);
  router.patch("/api/long-agents/:longAgentId/agent-memory", updateAgentMemoryHandler);

  const groupResponse = await router.fetch(new Request("http://chat.test/api/long-agents/nexus/agent-group"));
  assert.equal(groupResponse.status, 200);
  const groupText = await groupResponse.text();
  assert.equal(groupText.includes(nanoGatewayPrivateValue), false);
  const group = JSON.parse(groupText);
  assert.equal(group.workspace.folder, "nexus");
  assert.equal(group.coreMemory.index.path, "index.md");

  const update = await router.fetch(new Request("http://chat.test/api/long-agents/nexus/agent-group", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schemaVersion: 1,
      expectedRevision: REVISION_A,
      name: "Nexus Updated",
      standingInstructions: "Keep the ledger current.",
    }),
  }));
  assert.equal(update.status, 200);
  assert.equal((await update.json()).group.name, "Nexus Updated");
  const blankInstructions = await router.fetch(new Request("http://chat.test/api/long-agents/nexus/agent-group", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, expectedRevision: REVISION_C, standingInstructions: "   " }),
  }));
  assert.equal(blankInstructions.status, 400);

  const list = await router.fetch(new Request("http://chat.test/api/long-agents/nexus/agent-memory?operation=list"));
  assert.equal(list.status, 200);
  assert.equal((await list.json()).files[0].path, "index.md");
  const read = await router.fetch(new Request("http://chat.test/api/long-agents/nexus/agent-memory?operation=read&path=index.md"));
  assert.equal(read.status, 200);
  assert.match((await read.json()).file.content, /continuity/);
  const search = await router.fetch(new Request("http://chat.test/api/long-agents/nexus/agent-memory?operation=search&query=continuity&limit=5"));
  assert.equal(search.status, 200);
  assert.equal((await search.json()).results[0].snippet, "continuity");
  const write = await router.fetch(new Request("http://chat.test/api/long-agents/nexus/agent-memory", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schemaVersion: 1,
      operation: "write",
      path: "projects/chat.md",
      content: "# Chat",
      expectedRevision: null,
    }),
  }));
  assert.equal(write.status, 200);
  assert.equal((await write.json()).file.path, "projects/chat.md");
  const deletion = await router.fetch(new Request("http://chat.test/api/long-agents/nexus/agent-memory", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, operation: "delete", path: "projects/chat.md", expectedRevision: REVISION_B }),
  }));
  assert.equal(deletion.status, 200);
  assert.equal((await deletion.json()).deleted, true);

  const oversized = await router.fetch(new Request("http://chat.test/api/long-agents/nexus/agent-memory", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schemaVersion: 1,
      operation: "write",
      path: "oversized.md",
      content: "中".repeat(307_201),
      expectedRevision: null,
    }),
  }));
  assert.equal(oversized.status, 400);

  const invalid = await router.fetch(new Request("http://chat.test/api/long-agents/nexus/agent-memory?operation=read&path=/private/memory.md"));
  assert.equal(invalid.status, 400);
  assert.equal(requests.every((item) => item.authorization === `Bearer ${TOKEN}`), true);
  assert.equal(JSON.stringify(requests).includes(TOKEN), true, "test records headers only to verify authentication");
  const audit = fs.readFileSync(path.join(chatHome, "logs", "audit.jsonl"), "utf8");
  assert.match(audit, /long-agent\.agent-group\.update/);
  assert.match(audit, /long-agent\.agent-memory\.write/);
  assert.match(audit, /long-agent\.agent-memory\.delete/);
  assert.match(audit, /"type":"web-settings"/);
  assert.equal(audit.includes(TOKEN), false);
  assert.equal(audit.includes(nanoGatewayPrivateValue), false);
});

test("Agent Group prompt context applies independent Unicode-safe budgets without truncating API snapshots", async () => {
  const standing = `${"😀".repeat(32_000)}TAIL-STANDING`;
  const index = `${"知".repeat(16_000)}TAIL-INDEX`;
  const definition = `${"忆".repeat(16_000)}TAIL-DEFINITION`;
  const context = buildAgentGroupContextInstructions({
    schemaVersion: 1,
    stale: false,
    fetchedAt: "2026-09-06T01:02:03.000Z",
    group: { id: "nano-agent-1", name: "Nexus Nano", standingInstructions: standing, revision: REVISION_A },
    workspace: { folder: "nexus", memoryFileCount: 2 },
    coreMemory: {
      index: {
        path: "index.md", content: index, size: Buffer.byteLength(index),
        updatedAt: "2026-09-06T01:02:03.000Z", revision: REVISION_B,
      },
      definition: {
        path: "system/definition.md", content: definition, size: Buffer.byteLength(definition),
        updatedAt: "2026-09-06T01:02:03.000Z", revision: REVISION_C,
      },
    },
  });
  assert.equal(context.includes("TAIL-STANDING"), false);
  assert.equal(context.includes("TAIL-INDEX"), false);
  assert.equal(context.includes("TAIL-DEFINITION"), false);
  assert.match(context, /field="standingInstructions" original_code_points="32013"/);
  assert.match(context, /field="index.md" original_code_points="16010"/);
  assert.match(context, /field="system\/definition.md" original_code_points="16015"/);
  assert.equal(context.includes("\ud83d\n"), false, "emoji must not be split into an invalid surrogate");
});

const nanoGatewayPrivateValue = "http://127.0.0.1/private-nano-host-path";

test("agent_memory tools bind the Nano Agent Group from host LongAgent context", { concurrency: false }, async (t) => {
  const { chatHome, requests } = await setup(t);
  const [searchTool, readTool, writeTool] = resolveChatSystemTools([
    "system:tool/agent_memory_search",
    "system:tool/agent_memory_read",
    "system:tool/agent_memory_write",
  ], {
    purpose: "execution",
    projectId: "daily",
    chatHome,
    cwd: chatHome,
    sessionManager: {},
    sessionId: "chat-session-1",
    agentId: "nexus",
    longAgentId: "nexus",
    longAgentTurnId: "turn-1",
  });
  const searched = await searchTool.definition.execute("call-1", { query: "continuity", limit: 2 });
  assert.match(searched.content[0].text, /continuity/);
  const read = await readTool.definition.execute("call-2", { path: "index.md" });
  assert.match(read.content[0].text, /continuity/);
  await writeTool.definition.execute("call-3", { path: "log.md", content: "# Log", expectedRevision: null });

  const toolRequests = requests.filter((item) => item.path.includes("/memory/"));
  assert.deepEqual(toolRequests.map((item) => item.body.agentGroupId), ["nano-agent-1", "nano-agent-1", "nano-agent-1"]);
  await assert.rejects(
    writeTool.definition.execute("call-4", {
      path: "oversized.md",
      content: "中".repeat(307_201),
      expectedRevision: null,
    }),
    /900 KiB/,
  );
  assert.equal(requests.filter((item) => item.path.endsWith("/memory/write")).length, 1);
  assert.equal(toolRequests.some((item) => Object.hasOwn(item.body, "longAgentId")), false);
  assert.equal(JSON.stringify(searchTool.definition.parameters).includes("agentGroupId"), false);
  const audit = fs.readFileSync(path.join(chatHome, "logs", "audit.jsonl"), "utf8");
  assert.match(audit, /"type":"pi-tool"/);
  assert.match(audit, /"projectId":"daily"/);
  assert.match(audit, /"sessionId":"chat-session-1"/);
  assert.match(audit, /"turnId":"turn-1"/);
  assert.match(audit, /"resourcePath":"log.md"/);
});
