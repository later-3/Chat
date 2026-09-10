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
import { ensureDailyProject } from "../../src/projects/registry.ts";

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
  await ensureDailyProject(chatHome);
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
  await ensureDailyProject(chatHome);
  await writeLongAgentRegistry({
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
  await ensureDailyProject(chatHome);
  await writeLongAgentRegistry({
    schemaVersion: 1,
    instances: [INSTANCE],
    agents: [agentEntry(CUSTOM_DEFINITION)],
  }, chatHome);
  const definitionPath = path.join(longAgentConfigRoot(chatHome, "nexus"), "definition.json");
  const tampered = { ...JSON.parse(fs.readFileSync(definitionPath, "utf8")), name: "Tampered" };
  fs.writeFileSync(definitionPath, JSON.stringify(tampered));
  await assert.rejects(readLongAgentRegistry(chatHome), /身份不一致/);
});

test("legacy shared-daily Agents migrate to their own Daily Project (S3)", async (t) => {
  const { chatHome } = fixture(t);
  await ensureDailyProject(chatHome);
  await writeLongAgentRegistry({
    schemaVersion: 1,
    instances: [INSTANCE],
    agents: [agentEntry()],
  }, chatHome);

  const { readLongAgentConfiguration } = await import("../../src/long-agents/configuration.ts");
  const document = await readLongAgentConfiguration("nexus", chatHome);
  assert.equal(document.agent.defaultProjectId, "daily-nexus");

  const { resolveProjectContext, readProjectRegistry } = await import("../../src/projects/registry.ts");
  const project = await resolveProjectContext("daily-nexus", chatHome);
  assert.ok(project.cwd.endsWith(path.join("workspaces", "daily-nexus")));
  const registered = await readProjectRegistry(chatHome);
  assert.ok(registered.projects.some((entry) => entry.projectId === "daily-nexus"));

  // 普通 Chat 的共享 daily 不受影响。
  const daily = await resolveProjectContext("daily", chatHome);
  assert.ok(daily.cwd.endsWith(path.join("workspaces", "daily")));

  // 幂等：再次读取不重复迁移。
  const again = await readLongAgentConfiguration("nexus", chatHome);
  assert.equal(again.agent.defaultProjectId, "daily-nexus");
});

test("daily main Session rotates by local date; non-daily bindings stay stable (S5a)", async (t) => {
  const { chatHome } = fixture(t);
  await ensureDailyProject(chatHome);
  await writeLongAgentRegistry({
    schemaVersion: 1,
    instances: [INSTANCE],
    agents: [agentEntry()],
  }, chatHome);
  const { readLongAgentConfiguration } = await import("../../src/long-agents/configuration.ts");
  await readLongAgentConfiguration("nexus", chatHome);
  const { readLongAgentState, readLongAgentRegistry } = await import("../../src/long-agents/storage.ts");
  const { ensureProjectLongAgent } = await import("../../src/long-agents/project-agent.ts");
  const registry = await readLongAgentRegistry(chatHome);
  const agent = registry.agents[0];

  const first = await ensureProjectLongAgent({ chatHome, projectId: "daily-nexus", agent });
  assert.equal(first.isNewSession, true);
  const second = await ensureProjectLongAgent({ chatHome, projectId: "daily-nexus", agent });
  assert.equal(second.isNewSession, false);
  assert.equal(second.projectAgent.primarySessionId, first.projectAgent.primarySessionId);

  // 模拟跨日：把绑定的 sessionDate 改成昨天，下一次进入应轮换到新 Session。
  const { updateLongAgentState } = await import("../../src/long-agents/storage.ts");
  await updateLongAgentState(chatHome, (state) => ({
    state: {
      ...state,
      projectAgents: state.projectAgents.map((binding) => ({ ...binding, sessionDate: "2000-01-01" })),
    },
    result: undefined,
  }));
  const rotated = await ensureProjectLongAgent({ chatHome, projectId: "daily-nexus", agent });
  assert.equal(rotated.isNewSession, true);
  assert.notEqual(rotated.projectAgent.primarySessionId, first.projectAgent.primarySessionId);
  assert.equal(rotated.projectAgent.sessionDate, second.projectAgent.sessionDate === undefined ? undefined : rotated.projectAgent.sessionDate);
  // 旧 Session 历史保留：两个 Session 都在项目数据目录中。
  const state = await readLongAgentState(chatHome);
  assert.equal(state.projectAgents.length, 1);

  // 非 Daily 项目不轮换：sessionDate 缺省，重复进入复用同一 Session。
  const business = await ensureProjectLongAgent({ chatHome, projectId: "daily", agent });
  const businessAgain = await ensureProjectLongAgent({ chatHome, projectId: "daily", agent });
  assert.equal(businessAgain.projectAgent.primarySessionId, business.projectAgent.primarySessionId);
  assert.equal(businessAgain.projectAgent.sessionDate, undefined);
});
