import { respondProjectManagement } from "../../scripts/project-management-runtime-fixture.mjs";
import { ensureProjectManagementSkill } from "../../src/resources/project-management-skill.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { createRouter } from "nitro/h3";
import { ensureLongAgentShareProject } from "../../src/projects/registry.ts";
import { openChatSession } from "../../src/chat-session.ts";
import { readChatSession } from "../../src/session-read-model.ts";
import { readLongAgentState, writeLongAgentRegistry } from "../../src/long-agents/storage.ts";
import {
  LongAgentConfigurationConflictError,
  LongAgentConfigurationInvalidError,
  readLongAgentConfiguration,
  updateLongAgentConfiguration,
} from "../../src/long-agents/configuration.ts";
import { acceptLongAgentEvents, listLongAgents, syncLongAgentEvents } from "../../src/long-agents/bridge.ts";
import { executeLongAgentTurn } from "../../src/long-agents/runtime.ts";
import { listChatSystemTools } from "../../src/tools/registry.ts";
import { collectChatLongAgentTurnMarkers } from "../../src/long-agents/session-turn.ts";
import readLongAgentConfigurationHandler from "../../src/routes/api/long-agents/[longAgentId]/config.get.ts";
import inspectLongAgentHandler from "../../src/routes/api/long-agents/[longAgentId]/inspection.get.ts";
import updateLongAgentConfigurationHandler from "../../src/routes/api/long-agents/[longAgentId]/config.put.ts";

// 归一后：每个已登记的 Long Agent 都有自己的 home Project（id 即 longAgentId）。
// 测试在写入 Registry 后补齐 home 项目，等价于生产启动时的归一/创建 provisioning。
async function writeLongAgentRegistryWithHomes(value, chatHome) {
  const { ensureAgentHomeProject } = await import("../../src/projects/registry.ts");
  const { writeLongAgentRegistry } = await import("../../src/long-agents/storage.ts");
  const registry = await writeLongAgentRegistry(value, chatHome);
  for (const agent of registry.agents) {
    await ensureAgentHomeProject(agent.id, agent.name, chatHome);
  }
  return registry;
}


function address(channelType, instance, platformId) {
  return { channelType, instance, platformId, threadId: null };
}

function event(seq, direction, overrides = {}) {
  return {
    seq,
    eventId: `local:nano-session-1:${direction}:message-${seq}`,
    instanceId: "local",
    direction,
    messageId: `message-${seq}`,
    nanoSessionId: "nano-session-1",
    agentGroupId: "nano-agent-1",
    messagingGroupId: "telegram-mg-1",
    isGroup: false,
    senderId: direction === "in" ? "telegram:user-1" : null,
    senderName: direction === "in" ? "Later" : "",
    text: direction === "in" ? "来自 Telegram 的问题" : "来自长期 Agent 的回答",
    kind: "chat",
    timestamp: `2026-09-05T00:00:0${seq}.000Z`,
    source: address("telegram", "telegram", "telegram:user-1"),
    delivery: address("telegram", "telegram", "telegram:user-1"),
    chatSessionId: null,
    ...overrides,
  };
}

function configurationDefinition(document, name = document.agent.name, description = document.agent.description) {
  const definition = document.agent.definition;
  return {
    schemaVersion: 1,
    id: document.agent.id,
    name,
    description,
    ...(definition.model === null || definition.model === undefined ? {} : { model: definition.model }),
    ...(definition.thinkingLevel === null || definition.thinkingLevel === undefined
      ? {}
      : { thinkingLevel: definition.thinkingLevel }),
    systemPrompt: definition.systemPrompt,
    customInstructions: definition.customInstructions.map((instruction) => (
      typeof instruction === "string" ? instruction : instruction.text
    )),
    tools: definition.tools,
    resources: definition.resources,
  };
}

function configurationUpdate(document, overrides = {}) {
  const name = overrides.name ?? document.agent.name;
  const description = overrides.description ?? document.agent.description;
  return {
    schemaVersion: 1,
    expectedRevision: overrides.expectedRevision ?? document.revision,
    name,
    description,
    enabled: overrides.enabled ?? document.agent.enabled,
    defaultProjectId: overrides.defaultProjectId ?? document.agent.defaultProjectId,
    definition: overrides.definition ?? configurationDefinition(document, name, description),
  };
}

function writeAgentGroupSnapshotFixture(chatHome) {
  const directory = path.join(chatHome, "runtime", "long-agents", "nexus");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "agent-group-snapshot.json"), JSON.stringify({
    schemaVersion: 1,
    longAgentId: "nexus",
    agentGroupId: "nano-agent-1",
    fetchedAt: "2026-09-05T00:00:00.000Z",
    snapshot: {
      id: "nano-agent-1",
      name: "Nexus Nano",
      standingInstructions: "Preserve continuity while NanoClaw is offline.",
      revision: `sha256:${"a".repeat(64)}`,
      workspace: { folder: "nexus", memoryFileCount: 2 },
      coreMemory: {
        index: {
          path: "index.md", content: "# Core Memory", size: 13,
          updatedAt: "2026-09-05T00:00:00.000Z", revision: `sha256:${"b".repeat(64)}`,
        },
        definition: {
          path: "system/definition.md",
          content: "# Memory Protocol",
          size: 17,
          updatedAt: "2026-09-05T00:00:00.000Z",
          revision: `sha256:${"c".repeat(64)}`,
        },
      },
    },
  }));
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function startModelServer(requests, options = {}) {
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    requests.push(await readJson(request));
    if (options.chatHome && respondProjectManagement(requests.at(-1), response, options.chatHome, "long-agent-model")) return;
    if (requests.length <= (options.failFirstRequests ?? 0)) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        error: {
          message: `transient model failure ${String(requests.length)}`,
          type: "invalid_request_error",
        },
      }));
      return;
    }
    const responseText = `Pi Long Agent reply ${String(requests.length)}`;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({
      id: `chatcmpl-long-agent-${String(requests.length)}`,
      object: "chat.completion.chunk",
      created: 0,
      model: "long-agent-model",
      choices: [{ index: 0, delta: { role: "assistant", content: responseText }, finish_reason: null }],
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      id: `chatcmpl-long-agent-${String(requests.length)}`,
      object: "chat.completion.chunk",
      created: 0,
      model: "long-agent-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const bound = server.address();
  assert.equal(typeof bound, "object");
  assert.ok(bound);
  return { server, baseUrl: `http://127.0.0.1:${bound.port}/v1` };
}

async function startNanoGatewayServer(requests) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.headers.authorization !== "Bearer test-channel-token-that-is-at-least-32-characters") {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/webhook/chat-backend/v1/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ schemaVersion: 1, ok: true, instanceId: "local" }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/webhook/chat-backend/v1/agent-groups/get") {
      const body = await readJson(request);
      requests.push({ path: url.pathname, body });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        schemaVersion: 1,
        agentGroup: {
          id: body.agentGroupId,
          name: "Nexus Nano",
          standingInstructions: "Preserve continuity across every channel.",
          revision: `sha256:${"a".repeat(64)}`,
          workspace: { folder: "nexus", memoryFileCount: 2 },
          coreMemory: {
            index: {
              path: "index.md",
              content: "# Core Memory\n\n- Remember the user's durable working context.",
              size: 61,
              updatedAt: "2026-09-05T00:00:00.000Z",
              revision: `sha256:${"b".repeat(64)}`,
            },
            definition: {
              path: "system/definition.md",
              content: "# Memory Protocol\n\nMaintain OKF Markdown carefully.",
              size: 51,
              updatedAt: "2026-09-05T00:00:00.000Z",
              revision: `sha256:${"c".repeat(64)}`,
            },
          },
        },
      }));
      return;
    }
    if (request.method === "POST" && [
      "/webhook/chat-backend/v1/deliveries",
      "/webhook/chat-backend/v1/acks",
    ].includes(url.pathname)) {
      const body = await readJson(request);
      requests.push({ path: url.pathname, body });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(url.pathname.endsWith("/deliveries")
        ? { schemaVersion: 1, persisted: true, messageId: body.messageId }
        : { schemaVersion: 1, completed: true, messageId: body.messageId }));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const bound = server.address();
  assert.equal(typeof bound, "object");
  assert.ok(bound);
  return { server, baseUrl: `http://127.0.0.1:${bound.port}/webhook/chat-backend` };
}

test("legacy per-session bindings migrate to one Project Long Agent primary session", { concurrency: false }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-long-agent-"));
  const chatHome = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await ensureLongAgentShareProject(chatHome);
  const legacyBinding = {
    id: "telegram-binding",
    projectId: "nexus",
    chatSessionId: "telegram-session",
    longAgentId: "nexus",
    nanoclawInstanceId: "local",
    nanoclawAgentGroupId: "nano-agent-1",
    nanoclawSessionId: "nano-session-1",
    primaryMessagingGroupId: "telegram-mg-1",
    source: address("telegram", "telegram", "telegram:user-1"),
    chatWebMessagingGroupId: null,
    chatWebPlatformId: "chat-session:telegram-session",
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:03.000Z",
  };
  fs.writeFileSync(path.join(chatHome, "runtime", "long-agent-state.json"), JSON.stringify({
    schemaVersion: 1,
    cursors: { local: 9 },
    bindings: [
      legacyBinding,
      {
        ...legacyBinding,
        id: "web-binding",
        chatSessionId: "web-session",
        nanoclawSessionId: null,
        primaryMessagingGroupId: null,
        source: address("chat-web", "chat-web", "chat-session:web-session"),
        chatWebPlatformId: "chat-session:web-session",
        createdAt: "2026-09-05T00:00:01.000Z",
      },
    ],
  }));

  const state = await readLongAgentState(chatHome);
  assert.equal(state.schemaVersion, 3);
  assert.deepEqual(state.projectAgents, [{
    id: "project-long-agent:nexus:nexus",
    projectId: "nexus",
    longAgentId: "nexus",
    primarySessionId: "telegram-session",
    status: "active",
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:03.000Z",
  }]);
  assert.equal(state.bindings.length, 1);
  assert.equal(state.bindings[0].projectLongAgentId, state.projectAgents[0].id);
  assert.equal(state.bindings[0].nanoclawSessionId, "nano-session-1");
  assert.equal(JSON.parse(fs.readFileSync(path.join(chatHome, "runtime", "long-agent-state.json"), "utf8")).schemaVersion, 3);
});

test("LongAgent default definition grants every registered Chat system Tool", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-long-agent-default-tools-"));
  const chatHome = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await ensureLongAgentShareProject(chatHome);
  await writeLongAgentRegistryWithHomes({
    schemaVersion: 1,
    instances: [{
      id: "local", name: "Local NanoClaw", executionMode: "chat-pi",
      gatewayBaseUrl: "http://127.0.0.1:3000/webhook/chat-backend",
    }],
    agents: [{
      id: "nexus", name: "Nexus", description: "Daily coworker", enabled: true,
      instanceId: "local", nanoclawAgentGroupId: "private-agent-group", defaultProjectId: "nexus",
      inbox: {
        messagingGroupId: "private-messaging-group", channelType: "telegram", instance: "telegram",
        platformId: "telegram:private-user", threadId: null,
      },
    }],
  }, chatHome);

  const current = await readLongAgentConfiguration("nexus", chatHome);
  assert.equal(current.agent.definition.tools.mode, "pi-default");
  // 默认授予除 long_agent_manage 外的全部系统 Tool；管理其他 Agent 生命周期是特权能力，必须显式配置。
  assert.deepEqual(
    [...current.agent.definition.tools.addresses].sort(),
    listChatSystemTools()
      .map((tool) => tool.address)
      .filter((address) => address !== "system:tool/long_agent_manage")
      .sort(),
    "default Long Agent grants every registered system Tool except the privileged long_agent_manage",
  );
});

test("LongAgent inspection resolves effective Skills through the execution path with ownership", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-long-agent-inspection-"));
  const chatHome = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previousHome = process.env.CHAT_HOME;
  process.env.CHAT_HOME = chatHome;
  t.after(() => {
    if (previousHome === undefined) delete process.env.CHAT_HOME;
    else process.env.CHAT_HOME = previousHome;
  });
  await ensureLongAgentShareProject(chatHome);
  await writeLongAgentRegistryWithHomes({
    schemaVersion: 1,
    instances: [{
      id: "local", name: "Local NanoClaw", executionMode: "chat-pi",
      gatewayBaseUrl: "http://127.0.0.1:3000/webhook/chat-backend",
    }],
    agents: [{
      id: "nexus", name: "Nexus", description: "Daily coworker", enabled: true,
      instanceId: "local", nanoclawAgentGroupId: "private-agent-group", defaultProjectId: "nexus",
      inbox: {
        messagingGroupId: "private-messaging-group", channelType: "telegram", instance: "telegram",
        platformId: "telegram:private-user", threadId: null,
      },
    }],
  }, chatHome);
  const personalSkillDir = path.join(chatHome, "agent", "skills", "personal-note");
  fs.mkdirSync(personalSkillDir, { recursive: true });
  fs.writeFileSync(path.join(personalSkillDir, "SKILL.md"), [
    "---",
    "name: personal-note",
    "description: Personal skill for note taking",
    "---",
    "Use this when taking personal notes.",
  ].join("\n"));
  const ownSkillDir = path.join(chatHome, "long-agents", "nexus", "skills", "daily-briefing");
  fs.mkdirSync(ownSkillDir, { recursive: true });
  fs.writeFileSync(path.join(ownSkillDir, "SKILL.md"), [
    "---",
    "name: daily-briefing",
    "description: Nexus-owned daily briefing skill",
    "---",
    "Compose the daily briefing.",
  ].join("\n"));

  const router = createRouter();
  router.get("/api/long-agents/:longAgentId/inspection", inspectLongAgentHandler);
  const response = await router.fetch(new Request("http://chat.test/api/long-agents/nexus/inspection"));
  assert.equal(response.status, 200);
  const inspection = await response.json();
  assert.equal(inspection.agent.id, "nexus");
  const personalSkill = inspection.skills.find((skill) => skill.name === "personal-note");
  assert.equal(personalSkill?.owner, "personal");
  // S4：自有目录的 Skill 默认生效并按 agent 归属分类。
  const ownSkill = inspection.skills.find((skill) => skill.name === "daily-briefing");
  assert.equal(ownSkill?.owner, "agent");
  for (const skill of inspection.skills) {
    assert.ok(["personal", "project", "plugin", "agent", "injected"].includes(skill.owner));
  }
  const missing = await router.fetch(new Request("http://chat.test/api/long-agents/ghost/inspection"));
  assert.equal(missing.status, 404);
});

test("LongAgent registry rejects unsafe Gateway URLs and duplicate Agent Group mappings", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-long-agent-registry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = {
    schemaVersion: 1,
    instances: [{ id: "local", name: "Local", gatewayBaseUrl: "http://remote.example/webhook/chat-backend" }],
    agents: [],
  };
  await assert.rejects(writeLongAgentRegistryWithHomes(base, root), /必须使用HTTPS/);
  const instance = { id: "local", name: "Local", gatewayBaseUrl: "http://127.0.0.1:3000/webhook/chat-backend" };
  await assert.rejects(writeLongAgentRegistryWithHomes({
    schemaVersion: 1,
    instances: [instance, { ...instance, id: "second", name: "Second" }],
    agents: [],
  }, root), /只支持一个NanoClaw instance/);
  const agent = {
    id: "one", name: "One", description: "", enabled: true, instanceId: "local",
    nanoclawAgentGroupId: "ag-shared", defaultProjectId: "nexus",
    inbox: {
      messagingGroupId: "mg-one", channelType: "telegram", instance: "telegram",
      platformId: "telegram:user", threadId: null,
    },
  };
  await assert.rejects(writeLongAgentRegistryWithHomes({
    schemaVersion: 1,
    instances: [instance],
    agents: [agent, { ...agent, id: "two", inbox: { ...agent.inbox, messagingGroupId: "mg-two" } }],
  }, root), /Agent Group被重复配置/);
});

test("LongAgent configuration is versioned, atomic, and keeps private routing out of its browser document", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-long-agent-config-"));
  const chatHome = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await ensureLongAgentShareProject(chatHome);
  await writeLongAgentRegistryWithHomes({
    schemaVersion: 1,
    instances: [{
      id: "local", name: "Local NanoClaw", executionMode: "chat-pi",
      gatewayBaseUrl: "http://127.0.0.1:3000/webhook/chat-backend",
    }],
    agents: [{
      id: "nexus", name: "Nexus", description: "Daily coworker", enabled: true,
      instanceId: "local", nanoclawAgentGroupId: "private-agent-group", defaultProjectId: "nexus",
      inbox: {
        messagingGroupId: "private-messaging-group", channelType: "telegram", instance: "telegram",
        platformId: "telegram:private-user", threadId: null,
      },
    }],
  }, chatHome);

  const current = await readLongAgentConfiguration("nexus", chatHome);
  assert.match(current.revision, /^[a-f0-9]{64}$/);
  assert.equal(current.channel.host.executionMode, "chat-pi");
  assert.equal(current.agent.definition.model, null);
  assert.equal(current.agent.definition.thinkingLevel, null);
  assert.equal(typeof current.agent.definition.customInstructions[0], "string");
  const currentJson = JSON.stringify(current);
  for (const privateValue of [
    "http://127.0.0.1:3000/webhook/chat-backend",
    "private-agent-group",
    "private-messaging-group",
    "telegram:private-user",
  ]) {
    assert.equal(currentJson.includes(privateValue), false);
  }
  const enabledListJson = JSON.stringify(await listLongAgents({ projectId: "nexus", chatHome }));
  assert.equal(JSON.parse(enabledListJson).agents[0].available, true);
  assert.equal(enabledListJson.includes(path.join(root, "ncl.sock")), false);
  assert.equal(enabledListJson.includes(path.join(root, "cli.sock")), false);

  const validUpdate = configurationUpdate(current, {
    name: "Nexus Daily",
    description: "Daily planning coworker",
    enabled: false,
  });
  validUpdate.definition.thinkingLevel = "high";
  validUpdate.definition.systemPrompt = { mode: "replace", text: "You are the Daily planning coworker." };
  validUpdate.definition.customInstructions = ["Search memory before answering historical questions."];
  validUpdate.definition.tools = {
    mode: "pi-default",
    addresses: ["system:tool/memory_search", "system:tool/workflow_call"],
  };

  await assert.rejects(
    updateLongAgentConfiguration("nexus", { ...validUpdate, privateRouting: "must-not-be-accepted" }, chatHome),
    LongAgentConfigurationInvalidError,
  );
  await assert.rejects(
    updateLongAgentConfiguration("nexus", {
      ...validUpdate,
      definition: { ...validUpdate.definition, nanoclawAgentGroupId: "must-not-be-accepted" },
    }, chatHome),
    LongAgentConfigurationInvalidError,
  );
  await assert.rejects(
    updateLongAgentConfiguration("nexus", { ...validUpdate, defaultProjectId: "missing-project" }, chatHome),
    LongAgentConfigurationInvalidError,
  );
  await assert.rejects(
    updateLongAgentConfiguration("nexus", {
      ...validUpdate,
      definition: {
        ...validUpdate.definition,
        model: { provider: "missing-provider", modelId: "missing-model" },
      },
    }, chatHome),
    LongAgentConfigurationInvalidError,
  );
  await assert.rejects(
    updateLongAgentConfiguration("nexus", {
      ...validUpdate,
      definition: {
        ...validUpdate.definition,
        tools: { mode: "pi-default", addresses: ["system:tool/not-registered"] },
      },
    }, chatHome),
    LongAgentConfigurationInvalidError,
  );
  await assert.rejects(
    updateLongAgentConfiguration("nexus", {
      ...validUpdate,
      definition: {
        ...validUpdate.definition,
        tools: { mode: "explicit", names: ["not-a-real-tool"], exclude: [] },
      },
    }, chatHome),
    LongAgentConfigurationInvalidError,
  );

  fs.writeFileSync(path.join(chatHome, "agent", "models.json"), JSON.stringify({
    providers: {
      "configured-auth-test": {
        baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "test-only-key",
        models: [{ id: "configured-model", name: "Configured model", input: ["text"],
          reasoning: false, contextWindow: 8192, maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      },
    },
  }));
  validUpdate.definition.model = { provider: "configured-auth-test", modelId: "configured-model" };
  const updated = await updateLongAgentConfiguration("nexus", validUpdate, chatHome);
  assert.equal(updated.agent.name, "Nexus Daily");
  assert.equal(updated.agent.enabled, false);
  assert.equal(updated.agent.definition.id, "nexus");
  assert.equal(updated.agent.definition.name, "Nexus Daily");
  assert.equal(updated.agent.definition.thinkingLevel, "high");
  assert.deepEqual(updated.agent.definition.tools.addresses, [
    "system:tool/memory_search", "system:tool/workflow_call",
  ]);
  assert.notEqual(updated.revision, current.revision);
  assert.equal((await readLongAgentConfiguration("nexus", chatHome)).agent.enabled, false);
  const listed = await listLongAgents({ projectId: "nexus", chatHome });
  assert.deepEqual(listed.agents.map((agent) => [agent.id, agent.available]), [["nexus", false]]);
  await assert.rejects(
    executeLongAgentTurn({
      longAgentId: "nexus",
      projectId: "nexus",
      text: "disabled agents cannot run",
      chatHome,
    }),
    /找不到可用LongAgent/,
  );

  await assert.rejects(
    updateLongAgentConfiguration("nexus", configurationUpdate(current, {
      name: "Stale update",
      description: "Must be rejected",
    }), chatHome),
    LongAgentConfigurationConflictError,
  );

  const concurrentUpdates = ["Nexus Alpha", "Nexus Beta"].map((name) => (
    updateLongAgentConfiguration("nexus", configurationUpdate(updated, {
      name,
      description: `${name} description`,
    }), chatHome)
  ));
  const concurrentResults = await Promise.allSettled(concurrentUpdates);
  assert.equal(concurrentResults.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(concurrentResults.filter((result) => (
    result.status === "rejected" && result.reason instanceof LongAgentConfigurationConflictError
  )).length, 1);

  const persisted = JSON.parse(fs.readFileSync(path.join(chatHome, "long-agents.json"), "utf8"));
  assert.ok(["Nexus Alpha", "Nexus Beta"].includes(persisted.agents[0].name));
  assert.equal(persisted.agents[0].nanoclawAgentGroupId, "private-agent-group");
  assert.equal(fs.readdirSync(chatHome).some((entry) => entry.endsWith(".tmp")), false);
  const audit = fs.readFileSync(path.join(chatHome, "logs", "audit.jsonl"), "utf8");
  assert.equal(audit.split("\n").filter((line) => line.includes("long-agent.config.update")).length, 2);
  assert.equal(audit.includes("private-agent-group"), false);
  assert.equal(audit.includes("private-messaging-group"), false);
});

test("LongAgent configuration HTTP contract returns safe status codes and supports disabled Agents", { concurrency: false }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-long-agent-config-route-"));
  const chatHome = path.join(root, "home");
  const previousChatHome = process.env.CHAT_HOME;
  process.env.CHAT_HOME = chatHome;
  t.after(() => {
    if (previousChatHome === undefined) delete process.env.CHAT_HOME;
    else process.env.CHAT_HOME = previousChatHome;
    fs.rmSync(root, { recursive: true, force: true });
  });
  await ensureLongAgentShareProject(chatHome);
  await writeLongAgentRegistryWithHomes({
    schemaVersion: 1,
    instances: [{
      id: "local", name: "Local NanoClaw", executionMode: "chat-pi",
      gatewayBaseUrl: "http://127.0.0.1:3000/webhook/chat-backend",
    }],
    agents: [{
      id: "nexus", name: "Nexus", description: "Daily coworker", enabled: false,
      instanceId: "local", nanoclawAgentGroupId: "private-agent-group", defaultProjectId: "nexus",
      inbox: {
        messagingGroupId: "private-messaging-group", channelType: "telegram", instance: "telegram",
        platformId: "telegram:private-platform", threadId: null,
      },
    }],
  }, chatHome);

  const router = createRouter();
  router.get("/api/long-agents/:longAgentId/config", readLongAgentConfigurationHandler);
  router.put("/api/long-agents/:longAgentId/config", updateLongAgentConfigurationHandler);

  const getResponse = await router.fetch(new Request("http://chat.test/api/long-agents/nexus/config"));
  const currentText = await getResponse.text();
  const current = JSON.parse(currentText);
  assert.equal(getResponse.status, 200);
  assert.equal(getResponse.headers.get("cache-control"), "no-store");
  assert.equal(current.agent.enabled, false);
  assert.equal(current.agent.definition.model, null);
  assert.equal(typeof current.agent.definition.customInstructions[0], "string");
  for (const privateValue of [
    "private-ncl.sock",
    "private-cli.sock",
    "private-agent-group",
    "private-messaging-group",
    "telegram:private-platform",
  ]) {
    assert.equal(currentText.includes(privateValue), false);
  }

  const invalidId = await router.fetch(new Request("http://chat.test/api/long-agents/INVALID/config"));
  assert.equal(invalidId.status, 400);
  const missing = await router.fetch(new Request("http://chat.test/api/long-agents/missing/config"));
  assert.equal(missing.status, 404);

  const privateRequestValue = "private-routing-value-must-not-leak";
  const invalidResponse = await router.fetch(new Request("http://chat.test/api/long-agents/nexus/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...configurationUpdate(current), token: privateRequestValue }),
  }));
  const invalidText = await invalidResponse.text();
  assert.equal(invalidResponse.status, 400);
  assert.equal(invalidText.includes(privateRequestValue), false);

  const malformedResponse = await router.fetch(new Request("http://chat.test/api/long-agents/nexus/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: "{",
  }));
  assert.equal(malformedResponse.status, 400);

  const nextInput = configurationUpdate(current, {
    name: "Nexus Configured",
    description: "Configured through HTTP",
  });
  const putResponse = await router.fetch(new Request("http://chat.test/api/long-agents/nexus/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(nextInput),
  }));
  assert.equal(putResponse.status, 200);
  const next = await putResponse.json();
  assert.equal(next.agent.name, "Nexus Configured");
  assert.equal(next.agent.enabled, false);

  const staleResponse = await router.fetch(new Request("http://chat.test/api/long-agents/nexus/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(nextInput),
  }));
  assert.equal(staleResponse.status, 409);

  const privateStorageDetail = `${chatHome}/private-storage-detail`;
  fs.writeFileSync(path.join(chatHome, "long-agents.json"), `{${JSON.stringify(privateStorageDetail)}`);
  const storageResponse = await router.fetch(new Request("http://chat.test/api/long-agents/nexus/config"));
  const storageText = await storageResponse.text();
  assert.equal(storageResponse.status, 500);
  assert.equal(storageText.includes(privateStorageDetail), false);
});

test("Chat Web Long Agent runs Pi natively and replays one stable Turn only once", { concurrency: false }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-long-agent-pi-"));
  const chatHome = path.join(root, "home");
  const modelRequests = [];
  const model = await startModelServer(modelRequests, { chatHome });
  t.after(async () => {
    await closeServer(model.server);
    fs.rmSync(root, { recursive: true, force: true });
  });

  await ensureLongAgentShareProject(chatHome);
  const agentDir = path.join(chatHome, "agent");
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "long-agent-test",
    defaultModel: "long-agent-model",
    defaultThinkingLevel: "off",
  }));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "long-agent-test": {
        baseUrl: model.baseUrl,
        api: "openai-completions",
        apiKey: "long-agent-test-key",
        models: [{
          id: "long-agent-model",
          name: "Long Agent Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        }],
      },
    },
  }));
  await writeLongAgentRegistryWithHomes({
    schemaVersion: 1,
    instances: [{
      id: "local",
      name: "Local NanoClaw",
      gatewayBaseUrl: "http://127.0.0.1:3000/webhook/chat-backend",
    }],
    agents: [{
      id: "nexus",
      name: "Nexus",
      description: "Daily Long Agent",
      enabled: true,
      instanceId: "local",
      nanoclawAgentGroupId: "nano-agent-1",
      defaultProjectId: "nexus",
      inbox: {
        messagingGroupId: "telegram-mg-1",
        channelType: "telegram",
        instance: "telegram",
        platformId: "telegram:user-1",
        threadId: null,
      },
    }],
  }, chatHome);

  writeAgentGroupSnapshotFixture(chatHome);

  const first = await executeLongAgentTurn({
    longAgentId: "nexus",
    projectId: "nexus",
    text: "原生 Pi 第一问",
    chatHome,
    turnId: "stable-web-turn-1",
  });
  assert.equal(first.completed, true);
  assert.equal(first.text, "Pi Long Agent reply 1");
  assert.equal(first.model?.provider, "long-agent-test");
  assert.equal(modelRequests.length, 1);

  const replay = await executeLongAgentTurn({
    longAgentId: "nexus",
    projectId: "nexus",
    sessionId: first.sessionId,
    text: "原生 Pi 第一问",
    chatHome,
    turnId: "stable-web-turn-1",
  });
  assert.equal(replay.text, first.text);
  assert.equal(modelRequests.length, 1);

  const second = await executeLongAgentTurn({
    longAgentId: "nexus",
    projectId: "nexus",
    sessionId: first.sessionId,
    text: "原生 Pi 第二问",
    chatHome,
    turnId: "stable-web-turn-2",
  });
  assert.equal(second.text, "Pi Long Agent reply 2");
  assert.equal(modelRequests.length, 2);
  assert.match(JSON.stringify(modelRequests[1].messages), /原生 Pi 第一问/);
  assert.match(JSON.stringify(modelRequests[1].messages), /Pi Long Agent reply 1/);

  const oldReplayAfterNewTurn = await executeLongAgentTurn({
    longAgentId: "nexus",
    projectId: "nexus",
    sessionId: first.sessionId,
    text: "原生 Pi 第一问",
    chatHome,
    turnId: "stable-web-turn-1",
  });
  assert.equal(oldReplayAfterNewTurn.text, "Pi Long Agent reply 1");
  assert.equal(modelRequests.length, 2);

  const opened = await openChatSession({ projectId: "nexus", chatHome, sessionId: first.sessionId });
  assert.deepEqual(
    opened.manager.buildSessionContext().messages.map((message) => message.role),
    ["user", "assistant", "user", "assistant"],
  );
  assert.equal(
    opened.manager.buildSessionContext().messages.some((message) => "chatLongAgent" in message),
    false,
    "Pi-native messages must not be synthetic NanoClaw projections",
  );
  assert.deepEqual(
    collectChatLongAgentTurnMarkers(opened.manager.getEntries()).map((marker) => [marker.turnId, marker.status]),
    [
      ["stable-web-turn-1", "running"],
      ["stable-web-turn-1", "completed"],
      ["stable-web-turn-2", "running"],
      ["stable-web-turn-2", "completed"],
    ],
  );

  const projected = await readChatSession(first.sessionId, undefined, {}, "nexus", chatHome);
  assert.deepEqual(
    projected.context.messages.map((message) => message.chatLongAgent?.turnId ?? null),
    ["stable-web-turn-1", "stable-web-turn-1", "stable-web-turn-2", "stable-web-turn-2"],
  );
  assert.equal(projected.context.messages[1].usage.totalTokens, 7);

  await ensureProjectManagementSkill(chatHome);
  const projectTurn = await executeLongAgentTurn({ longAgentId: "nexus", projectId: "nexus", sessionId: first.sessionId,
    text: "PROJECT_TOOL_E2E: 创建学习道德经项目并完成配置", chatHome, turnId: "project-management-turn" });
  assert.equal(projectTurn.text, "PROJECT_TOOL_E2E_OK");
  assert.equal(projectTurn.sessionId, first.sessionId);
  const projectHistory = await readChatSession(first.sessionId, undefined, {}, "nexus", chatHome);
  const toolResults = projectHistory.context.messages.filter((m) => m.role === "toolResult" && m.toolName.startsWith("project_"));
  assert.equal(toolResults.length, 8);
  assert.ok(toolResults.slice(0, -1).every((m) => !m.isError));
  assert.equal(toolResults.at(-1).isError, true);

});

test("Long Agent retries a failed stable Turn without duplicating its user message", { concurrency: false }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-long-agent-retry-"));
  const chatHome = path.join(root, "home");
  const modelRequests = [];
  const model = await startModelServer(modelRequests, { failFirstRequests: 2 });
  t.after(async () => {
    await closeServer(model.server);
    fs.rmSync(root, { recursive: true, force: true });
  });

  await ensureLongAgentShareProject(chatHome);
  const agentDir = path.join(chatHome, "agent");
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "long-agent-test",
    defaultModel: "long-agent-model",
    defaultThinkingLevel: "off",
    retry: { enabled: false },
  }));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "long-agent-test": {
        baseUrl: model.baseUrl,
        api: "openai-completions",
        apiKey: "long-agent-test-key",
        models: [{
          id: "long-agent-model",
          name: "Long Agent Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        }],
      },
    },
  }));
  await writeLongAgentRegistryWithHomes({
    schemaVersion: 1,
    instances: [{
      id: "local",
      name: "Local NanoClaw",
      gatewayBaseUrl: "http://127.0.0.1:3000/webhook/chat-backend",
    }],
    agents: [{
      id: "nexus",
      name: "Nexus",
      description: "Daily Long Agent",
      enabled: true,
      instanceId: "local",
      nanoclawAgentGroupId: "nano-agent-1",
      defaultProjectId: "nexus",
      inbox: {
        messagingGroupId: "telegram-mg-1",
        channelType: "telegram",
        instance: "telegram",
        platformId: "telegram:user-1",
        threadId: null,
      },
    }],
  }, chatHome);

  writeAgentGroupSnapshotFixture(chatHome);

  const input = {
    longAgentId: "nexus",
    projectId: "nexus",
    text: "失败后只保留一条用户消息",
    chatHome,
    turnId: "stable-retry-turn-1",
  };
  await assert.rejects(executeLongAgentTurn(input), /transient model failure 1/);
  assert.equal(modelRequests.length, 1);

  const snapshotPath = path.join(chatHome, "runtime", "long-agents", "nexus", "agent-group-snapshot.json");
  const frozenSnapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  const changedSnapshot = structuredClone(frozenSnapshot);
  changedSnapshot.snapshot.coreMemory.index.revision = `sha256:${"d".repeat(64)}`;
  fs.writeFileSync(snapshotPath, JSON.stringify(changedSnapshot));
  await assert.rejects(executeLongAgentTurn(input), /transient model failure 2/);
  assert.equal(modelRequests.length, 2);

  const retried = await executeLongAgentTurn(input);
  assert.equal(retried.text, "Pi Long Agent reply 3");
  assert.equal(modelRequests.length, 3);

  const replay = await executeLongAgentTurn({ ...input, sessionId: retried.sessionId });
  assert.equal(replay.text, retried.text);
  assert.equal(modelRequests.length, 3);

  const opened = await openChatSession({
    projectId: "nexus",
    chatHome,
    sessionId: retried.sessionId,
  });
  const allEntries = opened.manager.getEntries();
  assert.equal(
    allEntries.filter((entry) => entry.type === "message" && entry.message.role === "user").length,
    1,
    "retry must resume the persisted user message instead of appending it again",
  );
  assert.deepEqual(
    opened.manager.buildSessionContext().messages.map((message) => message.role),
    ["user", "assistant"],
  );
  const markers = collectChatLongAgentTurnMarkers(allEntries)
    .filter((marker) => marker.turnId === input.turnId);
  assert.deepEqual(
    markers.map((marker) => marker.status),
    ["running", "failed", "running", "failed", "running", "completed"],
  );
  assert.match(markers[1].error, /transient model failure 1/);
  assert.match(markers[3].error, /transient model failure 2/);
  assert.equal(markers.every((marker) => marker.agentGroupContext?.agentGroupRevision === `sha256:${"a".repeat(64)}`), true);
  assert.equal(markers.every((marker) => marker.agentGroupContext?.indexRevision === `sha256:${"b".repeat(64)}`), true);
  assert.equal(markers.every((marker) => /^sha256:[a-f0-9]{64}$/.test(marker.agentGroupContext?.contextRevision ?? "")), true);
});

test("NanoClaw chat-pi events execute once, persist delivery, then acknowledge inbound", { concurrency: false }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-long-agent-channel-pi-"));
  const chatHome = path.join(root, "home");
  const modelRequests = [];
  const model = await startModelServer(modelRequests);
  const inbound = event(1, "in", { text: "Telegram 通过 Chat Pi 提问" });
  const commands = [];
  const gateway = await startNanoGatewayServer(commands);
  const previousToken = process.env.CHAT_CHANNEL_GATEWAY_TOKEN;
  process.env.CHAT_CHANNEL_GATEWAY_TOKEN = "test-channel-token-that-is-at-least-32-characters";
  t.after(async () => {
    if (previousToken === undefined) delete process.env.CHAT_CHANNEL_GATEWAY_TOKEN;
    else process.env.CHAT_CHANNEL_GATEWAY_TOKEN = previousToken;
    await Promise.all([closeServer(gateway.server), closeServer(model.server)]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  await ensureLongAgentShareProject(chatHome);
  const agentDir = path.join(chatHome, "agent");
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "long-agent-test",
    defaultModel: "long-agent-model",
    defaultThinkingLevel: "off",
  }));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "long-agent-test": {
        baseUrl: model.baseUrl,
        api: "openai-completions",
        apiKey: "long-agent-test-key",
        models: [{
          id: "long-agent-model",
          name: "Long Agent Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        }],
      },
    },
  }));
  await writeLongAgentRegistryWithHomes({
    schemaVersion: 1,
    instances: [{ id: "local", name: "Local NanoClaw", gatewayBaseUrl: gateway.baseUrl }],
    agents: [{
      id: "nexus",
      name: "Nexus",
      description: "Daily Long Agent",
      enabled: true,
      instanceId: "local",
      nanoclawAgentGroupId: "nano-agent-1",
      defaultProjectId: "nexus",
      inbox: {
        messagingGroupId: "telegram-mg-1",
        channelType: "telegram",
        instance: "telegram",
        platformId: "telegram:user-1",
        threadId: null,
      },
    }],
  }, chatHome);

  const accepted = await acceptLongAgentEvents({ instanceId: "local", events: [inbound], chatHome });
  assert.deepEqual(accepted.results, [{ eventId: inbound.eventId, status: "accepted" }]);
  const [first] = await syncLongAgentEvents(chatHome);
  assert.equal(first.executed, 1);
  assert.equal(first.projected, 0);
  assert.equal(modelRequests.length, 1);
  assert.match(JSON.stringify(modelRequests[0].messages), /Preserve continuity across every channel/);
  // B2：模板作为“格式要求”注入提示词，由 Agent 自己输出，而不是程序事后拼接。
  assert.match(JSON.stringify(modelRequests[0].messages), /回复格式要求：每条回复的最后另起一行/);
  assert.match(JSON.stringify(modelRequests[0].messages), /project：Nexus/);
  assert.match(JSON.stringify(modelRequests[0].messages), /Remember the user's durable working context/);
  assert.match(JSON.stringify(modelRequests[0].messages), /runtime_identity_name/);
  const delivery = commands.find((request) => request.path.endsWith("/deliveries"));
  const ack = commands.find((request) => request.path.endsWith("/acks"));
  assert.equal(delivery.body.messageId, `chat-pi:${inbound.eventId}`);
  assert.equal(delivery.body.destination.channelType, "telegram");
  assert.equal(delivery.body.destination.platformId, "telegram:user-1");
  assert.equal(delivery.body.text, "Pi Long Agent reply 1");
  assert.equal(ack.body.messageId, inbound.messageId);
  assert.ok(commands.indexOf(delivery) < commands.indexOf(ack));

  const state = await readLongAgentState(chatHome);
  assert.equal(state.bindings.length, 1);
  assert.equal(state.pendingEvents.length, 0);
  assert.equal(state.processedEvents[0].eventId, inbound.eventId);
  const opened = await openChatSession({
    projectId: "nexus",
    chatHome,
    sessionId: state.projectAgents[0].primarySessionId,
  });
  assert.deepEqual(
    opened.manager.buildSessionContext().messages.map((message) => [message.role, message.content[0].text]),
    [["user", "Telegram 通过 Chat Pi 提问"], ["assistant", "Pi Long Agent reply 1"]],
  );
  assert.equal(opened.manager.buildSessionContext().messages.some((message) => "chatLongAgent" in message), false);

  const duplicate = await acceptLongAgentEvents({ instanceId: "local", events: [inbound], chatHome });
  assert.deepEqual(duplicate.results, [{ eventId: inbound.eventId, status: "duplicate" }]);
  const commandCount = commands.length;
  const [replay] = await syncLongAgentEvents(chatHome);
  assert.equal(replay.pulled, 0);
  assert.equal(modelRequests.length, 1);
  assert.equal(commands.length, commandCount);

  const wechat = event(2, "in", {
    eventId: "local:wechat-session:in:message-2",
    nanoSessionId: "wechat-session",
    messagingGroupId: "wechat-mg-1",
    senderId: "wechat:user-1",
    text: "微信继续刚才的对话",
    source: address("wechat", "wechat", "wechat:user-1"),
    delivery: address("wechat", "wechat", "wechat:user-1"),
  });
  await acceptLongAgentEvents({ instanceId: "local", events: [wechat], chatHome });
  const [wechatSync] = await syncLongAgentEvents(chatHome);
  assert.equal(wechatSync.executed, 1);
  assert.equal(modelRequests.length, 2);
  assert.match(JSON.stringify(modelRequests[1].messages), /Telegram 通过 Chat Pi 提问/);
  const wechatDelivery = commands.filter((request) => request.path.endsWith("/deliveries")).at(-1);
  assert.equal(wechatDelivery.body.destination.channelType, "wechat");
  assert.equal(wechatDelivery.body.destination.platformId, "wechat:user-1");
  const sharedState = await readLongAgentState(chatHome);
  assert.equal(sharedState.projectAgents.length, 1);
  assert.equal(sharedState.projectAgents[0].primarySessionId, state.projectAgents[0].primarySessionId);
  assert.equal(sharedState.bindings.length, 2);
  assert.equal(sharedState.pendingEvents.length, 0);
});

const TEST_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("channel images reach a vision model and text-only models answer in-channel", { concurrency: false }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-long-agent-channel-images-"));
  const chatHome = path.join(root, "home");
  const modelRequests = [];
  const model = await startModelServer(modelRequests);
  const commands = [];
  const gateway = await startNanoGatewayServer(commands);
  const previousToken = process.env.CHAT_CHANNEL_GATEWAY_TOKEN;
  process.env.CHAT_CHANNEL_GATEWAY_TOKEN = "test-channel-token-that-is-at-least-32-characters";
  t.after(async () => {
    if (previousToken === undefined) delete process.env.CHAT_CHANNEL_GATEWAY_TOKEN;
    else process.env.CHAT_CHANNEL_GATEWAY_TOKEN = previousToken;
    await Promise.all([closeServer(gateway.server), closeServer(model.server)]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  await ensureLongAgentShareProject(chatHome);
  const agentDir = path.join(chatHome, "agent");
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "long-agent-test",
    defaultModel: "long-agent-model",
    defaultThinkingLevel: "off",
  }));
  const writeModels = (input) => fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "long-agent-test": {
        baseUrl: model.baseUrl,
        api: "openai-completions",
        apiKey: "long-agent-test-key",
        models: [{
          id: "long-agent-model",
          name: "Long Agent Model",
          reasoning: false,
          input,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        }],
      },
    },
  }));
  writeModels(["text", "image"]);
  await writeLongAgentRegistryWithHomes({
    schemaVersion: 1,
    instances: [{ id: "local", name: "Local NanoClaw", gatewayBaseUrl: gateway.baseUrl }],
    agents: [{
      id: "nexus",
      name: "Nexus",
      description: "Daily Long Agent",
      enabled: true,
      instanceId: "local",
      nanoclawAgentGroupId: "nano-agent-1",
      defaultProjectId: "nexus",
      inbox: {
        messagingGroupId: "telegram-mg-1",
        channelType: "telegram",
        instance: "telegram",
        platformId: "telegram:user-1",
        threadId: null,
      },
    }],
  }, chatHome);

  // Phase 1: the vision model receives the image as multimodal content.
  const withImage = event(1, "in", {
    text: "看看这张截图",
    images: [{ type: "image", data: TEST_PNG_BASE64, mimeType: "image/png" }],
  });
  await acceptLongAgentEvents({ instanceId: "local", events: [withImage], chatHome });
  const [imageSync] = await syncLongAgentEvents(chatHome);
  assert.equal(imageSync.executed, 1);
  assert.equal(modelRequests.length, 1);
  const requestJson = JSON.stringify(modelRequests[0].messages);
  assert.match(requestJson, /image_url/);
  assert.match(requestJson, new RegExp(TEST_PNG_BASE64.slice(0, 32)));
  const visionDelivery = commands.filter((request) => request.path.endsWith("/deliveries")).at(-1);
  assert.equal(visionDelivery.body.files, undefined);

  // Phase 1b: an image-only message must not send an empty text block,
  // which providers like Kimi reject with "text content is empty".
  const imageOnly = event(2, "in", {
    text: "",
    images: [{ type: "image", data: TEST_PNG_BASE64, mimeType: "image/png" }],
  });
  await acceptLongAgentEvents({ instanceId: "local", events: [imageOnly], chatHome });
  const [imageOnlySync] = await syncLongAgentEvents(chatHome);
  assert.equal(imageOnlySync.executed, 1);
  assert.equal(modelRequests.length, 2);
  const imageOnlyJson = JSON.stringify(modelRequests[1].messages);
  assert.match(imageOnlyJson, /image_url/);
  assert.equal(imageOnlyJson.includes('"text":""'), false);
  assert.match(imageOnlyJson, /see attached image/);
  const imageOnlyDelivery = commands.filter((request) => request.path.endsWith("/deliveries")).at(-1);
  assert.equal(imageOnlyDelivery.body.text, "Pi Long Agent reply 2");

  const state = await readLongAgentState(chatHome);
  const opened = await openChatSession({
    projectId: "nexus",
    chatHome,
    sessionId: state.projectAgents[0].primarySessionId,
  });
  const messages = opened.manager.buildSessionContext().messages;
  const userMessage = messages.find((message) => message.role === "user");
  assert.equal(userMessage.content[0].type, "text");
  assert.equal(userMessage.content[1].type, "image");
  assert.equal(userMessage.content[1].mimeType, "image/png");

  // Phase 2: a text-only model answers in-channel without ever calling the model.
  writeModels(["text"]);
  const textOnlyEvent = event(3, "in", {
    text: "",
    images: [{ type: "image", data: TEST_PNG_BASE64, mimeType: "image/png" }],
  });
  await acceptLongAgentEvents({ instanceId: "local", events: [textOnlyEvent], chatHome });
  const [textOnlySync] = await syncLongAgentEvents(chatHome);
  assert.equal(textOnlySync.executed, 1);
  // No new model call: phase 1 and 1b already made exactly two requests.
  assert.equal(modelRequests.length, 2);
  const noticeDelivery = commands.filter((request) => request.path.endsWith("/deliveries")).at(-1);
  assert.match(noticeDelivery.body.text, /Long Agent Model/);
  assert.match(noticeDelivery.body.text, /不支持图片输入/);
  const noticeAck = commands.filter((request) => request.path.endsWith("/acks")).at(-1);
  assert.equal(noticeAck.body.messageId, textOnlyEvent.messageId);

  const reopened = await openChatSession({
    projectId: "nexus",
    chatHome,
    sessionId: state.projectAgents[0].primarySessionId,
  });
  const transcript = reopened.manager.buildSessionContext().messages;
  const noticeMessage = transcript.at(-1);
  assert.equal(noticeMessage.role, "assistant");
  assert.match(noticeMessage.content[0].text, /不支持图片输入/);
  const noticeUser = transcript.at(-2);
  assert.equal(noticeUser.role, "user");
  assert.equal(noticeUser.content[1].type, "image");
});

test("Chat HTTP ingress accepts registered routes and rejects unknown or conflicting events", { concurrency: false }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-long-agent-http-ingress-"));
  const chatHome = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await ensureLongAgentShareProject(chatHome);
  await writeLongAgentRegistryWithHomes({
    schemaVersion: 1,
    instances: [{
      id: "local",
      name: "Local",
      gatewayBaseUrl: "http://127.0.0.1:3000/webhook/chat-backend",
    }],
    agents: [{
      id: "nexus",
      name: "Nexus",
      description: "Daily Long Agent",
      enabled: true,
      instanceId: "local",
      nanoclawAgentGroupId: "nano-agent-1",
      defaultProjectId: "nexus",
      inbox: {
        messagingGroupId: "telegram-mg-1",
        channelType: "telegram",
        instance: "telegram",
        platformId: "telegram:user-1",
        threadId: null,
      },
    }],
  }, chatHome);
  const first = event(1, "out", { text: "主动消息" });
  const accepted = await acceptLongAgentEvents({ instanceId: "local", events: [first], chatHome });
  assert.deepEqual(accepted.results, [{ eventId: first.eventId, status: "accepted" }]);
  await assert.rejects(acceptLongAgentEvents({
    instanceId: "local",
    events: [event(2, "in", { agentGroupId: "unmanaged-agent" })],
    chatHome,
  }), /未映射到Chat Long Agent/);
  await assert.rejects(acceptLongAgentEvents({
    instanceId: "local",
    events: [{ ...first, text: "相同ID不同内容" }],
    chatHome,
  }), /幂等冲突/);

  const unboundGroup = event(4, "in", {
    eventId: "local:nano-group-session:in:message-4",
    nanoSessionId: "nano-group-session",
    messagingGroupId: "telegram-group-1",
    isGroup: true,
    source: address("telegram", "telegram", "telegram:group-1"),
    delivery: address("telegram", "telegram", "telegram:group-1"),
  });
  await acceptLongAgentEvents({ instanceId: "local", events: [unboundGroup], chatHome });
  const [groupSync] = await syncLongAgentEvents(chatHome);
  assert.equal(groupSync.status, "unavailable");
  assert.match(groupSync.error, /尚未绑定Project会话/);
  const groupState = await readLongAgentState(chatHome);
  assert.equal(groupState.pendingEvents.some((pending) => pending.event.eventId === unboundGroup.eventId), true);
  assert.equal(groupState.processedEvents.some((processed) => processed.eventId === unboundGroup.eventId), false);

  await writeLongAgentRegistryWithHomes({
    schemaVersion: 1,
    instances: [{
      id: "local",
      name: "Local",
      gatewayBaseUrl: "http://127.0.0.1:3000/webhook/chat-backend",
    }],
    agents: [{
      id: "nexus",
      name: "Nexus",
      description: "Daily Long Agent",
      enabled: false,
      instanceId: "local",
      nanoclawAgentGroupId: "nano-agent-1",
      defaultProjectId: "nexus",
      inbox: {
        messagingGroupId: "telegram-mg-1",
        channelType: "telegram",
        instance: "telegram",
        platformId: "telegram:user-1",
        threadId: null,
      },
    }],
  }, chatHome);
  await assert.rejects(acceptLongAgentEvents({
    instanceId: "local",
    events: [event(3, "in")],
    chatHome,
  }), /未映射到Chat Long Agent/);
});

test("a scheduled task event runs in the Agent home session without any channel binding", { concurrency: false }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-long-agent-schedule-"));
  const chatHome = path.join(root, "home");
  const modelRequests = [];
  const model = await startModelServer(modelRequests);
  const commands = [];
  const gateway = await startNanoGatewayServer(commands);
  const previousToken = process.env.CHAT_CHANNEL_GATEWAY_TOKEN;
  process.env.CHAT_CHANNEL_GATEWAY_TOKEN = "test-channel-token-that-is-at-least-32-characters";
  t.after(async () => {
    if (previousToken === undefined) delete process.env.CHAT_CHANNEL_GATEWAY_TOKEN;
    else process.env.CHAT_CHANNEL_GATEWAY_TOKEN = previousToken;
    await Promise.all([closeServer(gateway.server), closeServer(model.server)]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  await ensureLongAgentShareProject(chatHome);
  const agentDir = path.join(chatHome, "agent");
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "long-agent-test",
    defaultModel: "long-agent-model",
    defaultThinkingLevel: "off",
  }));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "long-agent-test": {
        baseUrl: model.baseUrl,
        api: "openai-completions",
        apiKey: "long-agent-test-key",
        models: [{
          id: "long-agent-model",
          name: "Long Agent Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        }],
      },
    },
  }));
  await writeLongAgentRegistryWithHomes({
    schemaVersion: 1,
    instances: [{ id: "local", name: "Local NanoClaw", gatewayBaseUrl: gateway.baseUrl }],
    agents: [{
      id: "nexus", name: "Nexus", description: "Daily Long Agent", enabled: true,
      instanceId: "local", nanoclawAgentGroupId: "nano-agent-1", defaultProjectId: "nexus",
    }],
  }, chatHome);

  // 定时任务事件：没有 source / delivery / messaging group，也要能执行。
  const scheduled = {
    seq: 1,
    eventId: "nano:sess-task-1:in:task-evening-summary-1",
    instanceId: "local",
    direction: "in",
    messageId: "task-evening-summary-1",
    nanoSessionId: "sess-task-1",
    agentGroupId: "nano-agent-1",
    messagingGroupId: null,
    isGroup: false,
    senderId: null,
    senderName: "",
    text: "做今天的每日总结",
    kind: "schedule",
    timestamp: new Date().toISOString(),
    source: null,
    delivery: null,
    chatSessionId: null,
    taskId: "task-evening-summary-1",
  };
  const accepted = await acceptLongAgentEvents({ instanceId: "local", events: [scheduled], chatHome });
  assert.deepEqual(accepted.results, [{ eventId: scheduled.eventId, status: "accepted" }]);
  const [result] = await syncLongAgentEvents(chatHome);
  assert.equal(result.executed, 1);
  assert.equal(modelRequests.length, 1);
  assert.match(JSON.stringify(modelRequests[0].messages), /每日总结/);

  // 落在 Agent 自己的 home 项目当日会话；本次运行不自动回投。
  const { readLongAgentState } = await import("../../src/long-agents/storage.ts");
  const state = await readLongAgentState(chatHome);
  const home = state.projectAgents.find((candidate) => candidate.projectId === "nexus");
  assert.ok(home);
  const projected = await readChatSession(home.primarySessionId, undefined, {}, "nexus", chatHome);
  assert.equal(
    projected.context.messages.some((message) => message.chatLongAgent?.turnId === scheduled.eventId),
    true,
    "the scheduled task turn must be recorded in the Agent home session",
  );
  assert.equal(commands.some((request) => request.path.endsWith("/deliveries")), false);
});
