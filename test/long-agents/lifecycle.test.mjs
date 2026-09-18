import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRouter } from "nitro/h3";
import createHandler from "../../src/routes/api/long-agents.post.ts";
import enableHandler from "../../src/routes/api/long-agents/enable.post.ts";
import {
  archiveLongAgent,
  createLongAgent,
  enableLongAgents,
  deleteLongAgent,
  LongAgentLifecycleError,
  unarchiveLongAgent,
} from "../../src/long-agents/lifecycle.ts";
import { longAgentConfigRoot, readLongAgentRegistry } from "../../src/long-agents/storage.ts";
import { ensureLongAgentShareProject, openProject, readProjectRegistry } from "../../src/projects/registry.ts";

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


const INSTANCE = {
  id: "local", name: "Local NanoClaw", executionMode: "chat-pi",
  gatewayBaseUrl: "http://127.0.0.1:3000/webhook/chat-backend",
};

async function setup(t, agents = []) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-long-agent-lifecycle-"));
  const chatHome = path.join(base, "home");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  await ensureLongAgentShareProject(chatHome);
  const { writeLongAgentRegistry } = await import("../../src/long-agents/storage.ts");
  await writeLongAgentRegistryWithHomes({ schemaVersion: 1, instances: [INSTANCE], agents }, chatHome);
  return { base, chatHome };
}

const verifyOk = async () => {};

test("fresh install enables one default, retries a lost response, and creates a second isolated coworker", async (t) => {
  const { chatHome } = await setup(t);
  fs.rmSync(path.join(chatHome, "long-agents.json"));
  const previousToken = process.env.CHAT_CHANNEL_GATEWAY_TOKEN;
  const previousUrl = process.env.CHAT_NANOCLAW_GATEWAY_URL;
  process.env.CHAT_CHANNEL_GATEWAY_TOKEN = "test-channel-token-that-is-at-least-32-characters";
  process.env.CHAT_NANOCLAW_GATEWAY_URL = "http://127.0.0.1:39999/webhook/chat-backend";
  t.after(() => {
    if (previousToken === undefined) delete process.env.CHAT_CHANNEL_GATEWAY_TOKEN;
    else process.env.CHAT_CHANNEL_GATEWAY_TOKEN = previousToken;
    if (previousUrl === undefined) delete process.env.CHAT_NANOCLAW_GATEWAY_URL;
    else process.env.CHAT_NANOCLAW_GATEWAY_URL = previousUrl;
  });
  const groups = new Map();
  const requests = [];
  let loseResponse = true;
  const revision = `sha256:${"a".repeat(64)}`;
  const file = (name) => ({ path: name, content: "", size: 0, updatedAt: "2026-09-18T00:00:00Z", revision });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(init.headers.Authorization, `Bearer ${process.env.CHAT_CHANNEL_GATEWAY_TOKEN}`);
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/health")) return Response.json({ schemaVersion: 1, ok: true, instanceId: "local" });
    const body = JSON.parse(init.body);
    if (pathname.endsWith("/provision")) {
      requests.push(body.requestId);
      groups.set(`ag-${body.requestId}`, { schemaVersion: 1, agentGroup: {
        id: `ag-${body.requestId}`, name: body.name, standingInstructions: null, revision,
        workspace: { folder: `chat-${body.requestId}`, memoryFileCount: 3 },
        coreMemory: { index: file("index.md"), definition: file("system/definition.md") },
      } });
      if (loseResponse) { loseResponse = false; throw new Error("lost response after persistence"); }
      return Response.json(groups.get(`ag-${body.requestId}`));
    }
    if (pathname.endsWith("/get")) return Response.json(groups.get(body.agentGroupId));
    if (pathname.endsWith("/tasks")) return Response.json({ tasks: [] });
    throw new Error(`Unexpected request: ${pathname}`);
  });
  await assert.rejects(enableLongAgents(chatHome), /暂时不可用/);
  assert.equal((await readLongAgentRegistry(chatHome)).agents.length, 0);
  const [first, repeat] = await Promise.all([enableLongAgents(chatHome), enableLongAgents(chatHome)]);
  assert.equal(first.id, "nexus");
  assert.equal(first.id, repeat.id);
  assert.equal(groups.size, 1);
  assert.equal(new Set(requests).size, 1, "a lost response must reuse the persisted provisioning key");
  const second = await createLongAgent({ id: "coder", name: "Coder", chatHome });
  assert.notEqual(first.defaultProjectId, second.defaultProjectId);
  assert.notEqual(first.nanoclawAgentGroupId, second.nanoclawAgentGroupId);
  assert.equal((await readLongAgentRegistry(chatHome)).agents.length, 2);
  assert.equal((await enableLongAgents(chatHome)).id, first.id);
  await archiveLongAgent(first.id, chatHome);
  await enableLongAgents(chatHome);
  assert.equal((await readLongAgentRegistry(chatHome)).agents[0].enabled, false, "enable must not resurrect archived coworkers");
  await deleteLongAgent(first.id, chatHome);
  const replacement = await createLongAgent({ id: "nexus", name: "Nexus", description: "日常工作与生活助手", chatHome });
  assert.notEqual(first.nanoclawAgentGroupId, replacement.nanoclawAgentGroupId, "recreation must not adopt old Memory");
});

test("createLongAgent provisions config root, Agent home Project and registry entry atomically", async (t) => {
  const { chatHome } = await setup(t);
  const agent = await createLongAgent({
    id: "luna",
    name: "Luna",
    description: "Reading companion",
    instanceId: "local",
    nanoclawAgentGroupId: "ag-luna",
    chatHome,
    verifyAgentGroup: verifyOk,
  });
  assert.equal(agent.defaultProjectId, "luna");
  assert.equal(agent.status, "active");
  assert.ok(fs.existsSync(path.join(longAgentConfigRoot(chatHome, "luna"), "skills")));
  assert.ok(fs.existsSync(path.join(longAgentConfigRoot(chatHome, "luna"), "definition.json")));
  const projects = await readProjectRegistry(chatHome);
  assert.ok(projects.projects.some((entry) => entry.projectId === "luna" && entry.kind === "agent"));

  await assert.rejects(
    createLongAgent({
      id: "luna", name: "Dup", instanceId: "local", nanoclawAgentGroupId: "ag-new",
      chatHome, verifyAgentGroup: verifyOk,
    }),
    /已存在/,
  );
  await assert.rejects(
    createLongAgent({
      id: "newbie", name: "Dup Group", instanceId: "local", nanoclawAgentGroupId: "ag-luna",
      chatHome, verifyAgentGroup: verifyOk,
    }),
    /已被其他Agent绑定/,
  );
  await assert.rejects(
    createLongAgent({
      id: "ghost", name: "Ghost", instanceId: "missing", nanoclawAgentGroupId: "ag-ghost",
      chatHome, verifyAgentGroup: verifyOk,
    }),
    /找不到NanoClaw实例/,
  );
});

test("createLongAgent rolls back the registry entry when provisioning fails", async (t) => {
  const { chatHome } = await setup(t);
  await assert.rejects(
    createLongAgent({
      id: "bad agent id!", name: "Bad", instanceId: "local", nanoclawAgentGroupId: "ag-bad",
      chatHome, verifyAgentGroup: verifyOk,
    }),
    /格式无效/,
  );
  const registry = await readLongAgentRegistry(chatHome);
  assert.equal(registry.agents.length, 0);
});

test("creation cannot replace an existing user's Project with an Agent home", async (t) => {
  const { chatHome, base } = await setup(t);
  const projectPath = path.join(base, "user-project");
  fs.mkdirSync(projectPath);
  const project = await openProject({ path: projectPath, id: "coder", name: "My code", chatHome });
  await assert.rejects(createLongAgent({ id: "coder", name: "Coder", chatHome }), /已被其他Project使用/);
  assert.equal((await readProjectRegistry(chatHome)).projects.find((entry) => entry.projectId === "coder").path, project.cwd);
  assert.equal((await readLongAgentRegistry(chatHome)).agents.length, 0);
});

test("first-use API validates requests and explains an unavailable Host without registering an assistant", async (t) => {
  const { chatHome } = await setup(t);
  fs.rmSync(path.join(chatHome, "long-agents.json"));
  const previousHome = process.env.CHAT_HOME;
  process.env.CHAT_HOME = chatHome;
  t.after(() => {
    if (previousHome === undefined) delete process.env.CHAT_HOME;
    else process.env.CHAT_HOME = previousHome;
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  const router = createRouter();
  router.post("/api/long-agents", createHandler);
  router.post("/api/long-agents/enable", enableHandler);
  const post = (endpoint, body) => router.fetch(new Request(`http://chat.test/api/long-agents${endpoint}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  assert.equal((await post("", { id: "coder", name: "Coder", secret: "private" })).status, 400);
  assert.equal((await post("/enable", { enabled: true })).status, 400);
  const unavailable = await post("/enable", {});
  assert.equal(unavailable.status, 503);
  const message = await unavailable.text();
  assert.match(message, /NanoClaw/);
  assert.equal(message.includes(chatHome), false);
  assert.equal((await readLongAgentRegistry(chatHome)).agents.length, 0);
  assert.equal((await readLongAgentRegistry(chatHome)).instances.length, 0);
});

test("archive/unarchive/delete follow the two-phase contract", async (t) => {
  const { chatHome } = await setup(t);
  await createLongAgent({
    id: "luna", name: "Luna", instanceId: "local", nanoclawAgentGroupId: "ag-luna",
    chatHome, verifyAgentGroup: verifyOk,
  });

  await assert.rejects(deleteLongAgent("luna", chatHome), /先归档/);

  await archiveLongAgent("luna", chatHome);
  let registry = await readLongAgentRegistry(chatHome);
  assert.equal(registry.agents[0].status, "archived");
  assert.equal(registry.agents[0].enabled, false);

  await unarchiveLongAgent("luna", chatHome);
  registry = await readLongAgentRegistry(chatHome);
  assert.equal(registry.agents[0].status, "active");

  await archiveLongAgent("luna", chatHome);
  await deleteLongAgent("luna", chatHome);
  registry = await readLongAgentRegistry(chatHome);
  assert.equal(registry.agents.length, 0);
  assert.equal(fs.existsSync(longAgentConfigRoot(chatHome, "luna")), false);

  await assert.rejects(deleteLongAgent("luna", chatHome), (error) => {
    assert.ok(error instanceof LongAgentLifecycleError);
    assert.equal(error.statusCode, 404);
    return true;
  });
});
