import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { reconcileDefaultLongAgentTools } from "../../src/long-agents/definition-defaults.ts";
import { readLongAgentRegistry, writeLongAgentRegistry } from "../../src/long-agents/storage.ts";
import { ensureLongAgentShareProject } from "../../src/projects/registry.ts";
import { listChatSystemTools } from "../../src/tools/registry.ts";

const INSTANCE = {
  id: "local", name: "Local NanoClaw", executionMode: "chat-pi",
  gatewayBaseUrl: "http://127.0.0.1:3000/webhook/chat-backend",
};

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-default-tools-"));
  const chatHome = path.join(base, "home");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { chatHome };
}

function agentEntry(addresses, toolsManagedByDefault) {
  return {
    id: "nexus", name: "Nexus", description: "Daily coworker", enabled: true,
    instanceId: "local", nanoclawAgentGroupId: "ag-nexus", defaultProjectId: "nexus",
    ...(toolsManagedByDefault === undefined ? {} : { toolsManagedByDefault }),
    definition: {
      schemaVersion: 1, id: "nexus", name: "Nexus", description: "Daily coworker",
      systemPrompt: { mode: "pi-default" }, customInstructions: [],
      tools: { mode: "pi-default", addresses }, resources: { mode: "inherit" },
    },
  };
}

test("default-managed Agents receive newly added default Tools additively", async (t) => {
  const { chatHome } = fixture(t);
  await ensureLongAgentShareProject(chatHome);
  const legacy = ["system:tool/memory_search", "system:tool/workflow_call"];
  await writeLongAgentRegistry({
    schemaVersion: 1, instances: [INSTANCE], agents: [agentEntry(legacy, undefined)],
  }, chatHome);

  const updated = await reconcileDefaultLongAgentTools(chatHome);
  assert.deepEqual(updated, ["nexus"]);
  const registry = await readLongAgentRegistry(chatHome);
  const addresses = registry.agents[0].definition.tools.addresses;
  assert.ok(addresses.includes("system:tool/channel_send"));
  assert.ok(addresses.includes("system:tool/task_manage"));
  // 原有保留，不动
  assert.ok(addresses.includes("system:tool/memory_search"));
  assert.equal(registry.agents[0].toolsManagedByDefault, true);

  // 幂等：第二次没有可补的
  assert.deepEqual(await reconcileDefaultLongAgentTools(chatHome), []);
});

test("customized Agents (toolsManagedByDefault=false) are never touched", async (t) => {
  const { chatHome } = fixture(t);
  await ensureLongAgentShareProject(chatHome);
  const custom = ["system:tool/memory_search"];
  await writeLongAgentRegistry({
    schemaVersion: 1, instances: [INSTANCE], agents: [agentEntry(custom, false)],
  }, chatHome);
  const updated = await reconcileDefaultLongAgentTools(chatHome);
  assert.deepEqual(updated, []);
  const registry = await readLongAgentRegistry(chatHome);
  assert.deepEqual(registry.agents[0].definition.tools.addresses, custom);
});

test("reconcile is skipped entirely when every managed Agent already has all defaults", async (t) => {
  const { chatHome } = fixture(t);
  await ensureLongAgentShareProject(chatHome);
  const allDefaults = listChatSystemTools()
    .map((tool) => tool.address)
    .filter((address) => address !== "system:tool/long_agent_manage");
  await writeLongAgentRegistry({
    schemaVersion: 1, instances: [INSTANCE], agents: [agentEntry(allDefaults, true)],
  }, chatHome);
  assert.deepEqual(await reconcileDefaultLongAgentTools(chatHome), []);
});
