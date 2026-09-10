import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  longAgentConfigRoot,
  readLongAgentRegistry,
  updateLongAgentRegistry,
  writeLongAgentRegistry,
} from "../../src/long-agents/storage.ts";
import { ensureLongAgentShareProject } from "../../src/projects/registry.ts";

// 归一后：每个已登记的 Long Agent 都有自己的 home Project（id 即 longAgentId）。
async function writeLongAgentRegistryWithHomes(value, chatHome) {
  const { ensureAgentHomeProject } = await import("../../src/projects/registry.ts");
  const { writeLongAgentRegistry } = await import("../../src/long-agents/storage.ts");
  const registry = await writeLongAgentRegistry(value, chatHome);
  for (const agent of registry.agents) {
    await ensureAgentHomeProject(agent.id, agent.name, chatHome);
  }
  return registry;
}


function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-long-agent-root-"));
  const chatHome = path.join(base, "home");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, chatHome };
}

const INSTANCE = {
  id: "local", name: "Local NanoClaw", executionMode: "chat-pi",
  gatewayBaseUrl: "http://127.0.0.1:3000/webhook/chat-backend",
};

function agentEntry(definition) {
  return {
    id: "nexus", name: "Nexus", description: "Daily coworker", enabled: true,
    instanceId: "local", nanoclawAgentGroupId: "private-agent-group", defaultProjectId: "daily",
    inbox: {
      messagingGroupId: "mg", channelType: "telegram", instance: "telegram",
      platformId: "telegram:user", threadId: null,
    },
    ...(definition === undefined ? {} : { definition }),
  };
}

const CUSTOM_DEFINITION = {
  schemaVersion: 1,
  id: "nexus",
  name: "Nexus",
  description: "Daily coworker",
  systemPrompt: { mode: "pi-default" },
  customInstructions: [],
  tools: { mode: "pi-default", addresses: ["system:tool/memory_search"] },
  resources: { mode: "inherit" },
};

test("legacy inline definitions migrate to per-Agent roots with backup and marker", async (t) => {
  const { chatHome } = fixture(t);
  await ensureLongAgentShareProject(chatHome);
  const registryPath = path.join(chatHome, "long-agents.json");
  fs.mkdirSync(chatHome, { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify({
    schemaVersion: 1,
    instances: [INSTANCE],
    agents: [agentEntry(CUSTOM_DEFINITION)],
  }, null, 2));

  const registry = await readLongAgentRegistry(chatHome);
  assert.equal(registry.agents[0].definition.tools.addresses[0], "system:tool/memory_search");

  // 拆分落盘：definition 文件存在，Registry 只剩索引字段。
  const definitionPath = path.join(longAgentConfigRoot(chatHome, "nexus"), "definition.json");
  assert.equal(JSON.parse(fs.readFileSync(definitionPath, "utf8")).tools.addresses[0], "system:tool/memory_search");
  const onDisk = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  assert.equal(onDisk.agents[0].definition, undefined);
  assert.equal(onDisk.agents[0].nanoclawAgentGroupId, "private-agent-group");

  // 备份与完成标记。
  const migrationDir = path.join(chatHome, "runtime", "migrations", "long-agent-definition-split");
  assert.ok(fs.existsSync(path.join(migrationDir, "long-agents.json.bak")));
  const marker = JSON.parse(fs.readFileSync(path.join(migrationDir, "done.json"), "utf8"));
  assert.deepEqual(marker.migratedAgents, ["nexus"]);

  // 幂等：再次读取不重复迁移，内容一致。
  const again = await readLongAgentRegistry(chatHome);
  assert.deepEqual(again, registry);
});

test("registry writes stay split and reads reassemble the same definition", async (t) => {
  const { chatHome } = fixture(t);
  await ensureLongAgentShareProject(chatHome);
  await writeLongAgentRegistryWithHomes({
    schemaVersion: 1,
    instances: [INSTANCE],
    agents: [agentEntry(CUSTOM_DEFINITION)],
  }, chatHome);

  const onDisk = JSON.parse(fs.readFileSync(path.join(chatHome, "long-agents.json"), "utf8"));
  assert.equal(onDisk.agents[0].definition, undefined);

  await updateLongAgentRegistry(chatHome, (registry) => ({
    registry: {
      ...registry,
      agents: registry.agents.map((agent) => ({ ...agent, enabled: false })),
    },
    result: undefined,
  }), );
  const updated = await readLongAgentRegistry(chatHome);
  assert.equal(updated.agents[0].enabled, false);
  assert.equal(updated.agents[0].definition.tools.addresses[0], "system:tool/memory_search");
  const stillSplit = JSON.parse(fs.readFileSync(path.join(chatHome, "long-agents.json"), "utf8"));
  assert.equal(stillSplit.agents[0].definition, undefined);
});

test("definition file identity must match the registry entry", async (t) => {
  const { chatHome } = fixture(t);
  await ensureLongAgentShareProject(chatHome);
  await writeLongAgentRegistryWithHomes({
    schemaVersion: 1,
    instances: [INSTANCE],
    agents: [agentEntry(CUSTOM_DEFINITION)],
  }, chatHome);
  const definitionPath = path.join(longAgentConfigRoot(chatHome, "nexus"), "definition.json");
  const tampered = { ...JSON.parse(fs.readFileSync(definitionPath, "utf8")), name: "Tampered" };
  fs.writeFileSync(definitionPath, JSON.stringify(tampered));
  await assert.rejects(readLongAgentRegistry(chatHome), /身份不一致/);
});

test("agent-home normalization merges Agent daily projects, renames the share space, and repatriates history", async (t) => {
  const { chatHome } = fixture(t);
  // 归一前形态：共享 daily + per-agent daily 项目与目录。
  const { ensureLongAgentShareProject } = await import("../../src/projects/registry.ts");
  await ensureLongAgentShareProject(chatHome);
  await writeLongAgentRegistryWithHomes({
    schemaVersion: 1,
    instances: [INSTANCE],
    agents: [{ ...agentEntry(), defaultProjectId: "daily-nexus" }],
  }, chatHome);
  const { ensureProjectDataLayout, readProjectRegistry } = await import("../../src/projects/registry.ts");
  const legacyData = await ensureProjectDataLayout("daily-nexus", chatHome);
  const legacyWorkspace = path.join(chatHome, "workspaces", "daily-nexus");
  fs.mkdirSync(legacyWorkspace, { recursive: true });
  fs.writeFileSync(path.join(legacyWorkspace, "notes.md"), "agent workspace note");
  // 一条属于 nexus 的历史会话与一条普通会话。
  const sessionDir = legacyData.sessionDir;
  const agentSession = path.join(sessionDir, "2026-09-01T00:00:00-000Z_01a00000-0000-7000-8000-000000000001.jsonl");
  fs.writeFileSync(agentSession, [
    JSON.stringify({ type: "session", id: "01a00000-0000-7000-8000-000000000001" }),
    JSON.stringify({ type: "custom", data: { longAgentId: "nexus", turnId: "t1" } }),
  ].join("\n"));
  const shareSessionDir = path.join(chatHome, "projects", "daily", "sessions");
  fs.mkdirSync(shareSessionDir, { recursive: true });
  const plainSession = path.join(shareSessionDir, "2026-09-01T00:00:00-000Z_01a00000-0000-7000-8000-000000000002.jsonl");
  fs.writeFileSync(plainSession, JSON.stringify({ type: "session" }));
  // 共享 daily 的目录与一条旧 catalog 记忆。
  const shareData = path.join(chatHome, "projects", "daily");
  fs.mkdirSync(path.join(shareData, "memory"), { recursive: true });
  fs.mkdirSync(path.join(chatHome, "workspaces", "daily"), { recursive: true });
  fs.writeFileSync(path.join(chatHome, "workspaces", "daily", ".keep"), "");

  const { migrateAgentHomeNormalization } = await import("../../src/migrations/agent-home-normalization.ts");
  const result = await migrateAgentHomeNormalization(chatHome);
  assert.ok(result);
  assert.deepEqual(result.migratedAgents, ["nexus"]);

  // Agent 根：workspace + 会话都归到 long-agents/nexus 下。
  const agentRoot = path.join(chatHome, "long-agents", "nexus");
  assert.equal(fs.existsSync(path.join(agentRoot, "workspace", "notes.md")), true);
  assert.equal(fs.existsSync(path.join(agentRoot, "sessions", path.basename(agentSession))), true);
  assert.equal(fs.existsSync(path.join(chatHome, "workspaces", "daily-nexus")), false);
  assert.equal(fs.existsSync(path.join(chatHome, "projects", "daily-nexus")), false);

  // 共享空间改名；普通会话留在共享空间，Agent 历史迁回 Agent。
  assert.equal(fs.existsSync(path.join(chatHome, "workspaces", "longagentshare")), true);
  assert.equal(fs.existsSync(path.join(chatHome, "projects", "longagentshare", "sessions", path.basename(plainSession))), true);

  // Registry：per-agent daily 登记被移除，home 以 kind=agent 登记；共享空间为 kind=share。
  const registry = await readProjectRegistry(chatHome);
  assert.equal(registry.projects.some((entry) => entry.projectId === "daily-nexus"), false);
  assert.equal(registry.projects.some((entry) => entry.projectId === "daily"), false);
  assert.equal(registry.projects.find((entry) => entry.projectId === "nexus")?.kind, "agent");
  assert.equal(registry.projects.find((entry) => entry.projectId === "longagentshare")?.kind, "share");

  // Long Agent registry：defaultProjectId 归一为 agent id。
  const { readLongAgentRegistry } = await import("../../src/long-agents/storage.ts");
  assert.equal((await readLongAgentRegistry(chatHome)).agents[0].defaultProjectId, "nexus");

  // 幂等：第二次调用返回 null，且不破坏结果。
  assert.equal(await migrateAgentHomeNormalization(chatHome), null);
  assert.equal(fs.existsSync(path.join(agentRoot, "workspace", "notes.md")), true);
});

test("agent home main Session rotates by local date; business bindings stay stable (S5a)", async (t) => {
  const { chatHome } = fixture(t);
  const { ensureLongAgentShareProject } = await import("../../src/projects/registry.ts");
  await ensureLongAgentShareProject(chatHome);
  await writeLongAgentRegistryWithHomes({
    schemaVersion: 1,
    instances: [INSTANCE],
    agents: [{ ...agentEntry(), defaultProjectId: "nexus" }],
  }, chatHome);
  const { readLongAgentRegistry, readLongAgentState, updateLongAgentState } = await import("../../src/long-agents/storage.ts");
  const { ensureProjectLongAgent } = await import("../../src/long-agents/project-agent.ts");
  const agent = (await readLongAgentRegistry(chatHome)).agents[0];

  const first = await ensureProjectLongAgent({ chatHome, projectId: "nexus", agent });
  const second = await ensureProjectLongAgent({ chatHome, projectId: "nexus", agent });
  assert.equal(second.isNewSession, false);
  assert.equal(second.projectAgent.primarySessionId, first.projectAgent.primarySessionId);

  // 跨日：把绑定日期改成昨天，下次进入轮换到新 Session。
  await updateLongAgentState(chatHome, (state) => ({
    state: { ...state, projectAgents: state.projectAgents.map((binding) => ({ ...binding, sessionDate: "2000-01-01" })) },
    result: undefined,
  }));
  const rotated = await ensureProjectLongAgent({ chatHome, projectId: "nexus", agent });
  assert.equal(rotated.isNewSession, true);
  assert.notEqual(rotated.projectAgent.primarySessionId, first.projectAgent.primarySessionId);
  assert.equal((await readLongAgentState(chatHome)).projectAgents.length, 1);

  // 业务项目不轮换。
  const { openProject } = await import("../../src/projects/registry.ts");
  const businessRoot = path.join(chatHome, "..", "business");
  fs.mkdirSync(businessRoot, { recursive: true });
  const businessProject = await openProject({ path: businessRoot, chatHome, id: "business", name: "Business" });
  const business = await ensureProjectLongAgent({ chatHome, projectId: businessProject.projectId, agent });
  const businessAgain = await ensureProjectLongAgent({ chatHome, projectId: businessProject.projectId, agent });
  assert.equal(businessAgain.projectAgent.primarySessionId, business.projectAgent.primarySessionId);
  assert.equal(businessAgain.projectAgent.sessionDate, undefined);
});

test("starting an Agent from the share space routes to its own home Project", async (t) => {
  const { chatHome } = fixture(t);
  const previousHome = process.env.CHAT_HOME;
  process.env.CHAT_HOME = chatHome;
  t.after(() => {
    if (previousHome === undefined) delete process.env.CHAT_HOME;
    else process.env.CHAT_HOME = previousHome;
  });
  const { ensureLongAgentShareProject } = await import("../../src/projects/registry.ts");
  await ensureLongAgentShareProject(chatHome);
  await writeLongAgentRegistryWithHomes({
    schemaVersion: 1,
    instances: [INSTANCE],
    agents: [{ ...agentEntry(), defaultProjectId: "nexus" }],
  }, chatHome);

  const { createRouter } = await import("nitro/h3");
  const startHandler = (await import("../../src/routes/api/long-agents/[longAgentId]/start.post.ts")).default;
  const router = createRouter();
  router.post("/api/long-agents/:longAgentId/start", startHandler);
  for (const shareId of ["daily", "longagentshare"]) {
    const response = await router.fetch(new Request("http://chat.test/api/long-agents/nexus/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: shareId }),
    }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.projectId, "nexus");
    assert.ok(body.primarySessionId);
  }
});
