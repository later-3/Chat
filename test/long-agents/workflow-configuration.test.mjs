import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fixture } from "./daily-fixture.mjs";
import { readLongAgentRegistry, updateLongAgentRegistry } from "../../src/long-agents/storage.ts";
import { acceptLongAgentTurn, executeQueuedLongAgentTurn } from "../../src/long-agents/turn-queue.ts";
import { readAssemblySnapshot } from "../../src/agents/assembly-context.ts";
import { updateAgentDurableConfig, readAgentDurableConfig } from "../../src/workflows/agent-model-config.ts";
import { inspectWorkflowAgent } from "../../src/workflows/agent-inspection.ts";
import { PI_CODING_AGENT } from "../../src/workflows/minimal-pi-coding-agent/agents/pi-coding-agent/index.ts";

function acceptedSnapshot(turn) {
  const manager = SessionManager.inMemory("/tmp");
  for (const entry of turn.seed) manager.appendCustomEntry(entry.customType, entry.data);
  return { manager, snapshot: readAssemblySnapshot(manager, turn.turnId) };
}

test("Web, IM and schedule use Workflow configuration; admission freezes the role and Session selections", async t => {
  const f = await fixture(t);
  const base = path.join(f.home, "long-agents/friend");
  const accepted = [];
  for (const source of ["chat-web", "channel", "scheduled"]) accepted.push(await acceptLongAgentTurn({ ...f.input(source), source,
    agentConfigs: { "pi-coding-agent": { tools: { mode: "none" } } } }));
  for (const turn of accepted) {
    const { snapshot } = acceptedSnapshot(turn);
    assert.equal(snapshot.agent.id, "pi-coding-agent");
    assert.equal(snapshot.agent.tools.mode, "none");
    assert.deepEqual(snapshot.agent.model, { provider: "p3-local", modelId: "daily-model" });
    assert.match(JSON.stringify(snapshot.agent.customInstructions), /Stable Friend/);
  }
  const inspected = await inspectWorkflowAgent({ projectId: "friend", chatHome: f.home, cwd: base,
    workflowId: "minimal-pi-coding-agent", defaultAgent: PI_CODING_AGENT, selection: { tools: { mode: "none" } } });
  assert.equal(inspected.agent.effectiveModel.modelId, "daily-model");
  // A later durable edit cannot change the role of an already accepted invocation.
  await updateAgentDurableConfig(base, "minimal-pi-coding-agent", "pi-coding-agent", { tools: { mode: "explicit", names: ["read"], exclude: [] } });
  const result = await executeQueuedLongAgentTurn({ ...f.input("chat-web"), source: "chat-web", agentConfigs: { "pi-coding-agent": { tools: { mode: "none" } } } });
  assert.equal(result.completed, true);
  assert.equal((await readLongAgentRegistry(f.home)).agents[0].definition.tools.names[0], "read");
});

test("legacy execution settings migrate once into the shared store with identity and native history preserved", async t => {
  const f = await fixture(t);
  const base = path.join(f.home, "long-agents/friend");
  const definitionPath = path.join(base, "definition.json");
  const identity = JSON.parse(fs.readFileSync(definitionPath));
  const legacy = { ...identity, model: { provider: "old", modelId: "old" }, tools: { mode: "none" }, resources: { mode: "inherit" } };
  fs.writeFileSync(definitionPath, JSON.stringify(legacy));
  await updateAgentDurableConfig(base, "minimal-pi-coding-agent", "pi-coding-agent", { model: { provider: "new", modelId: "new" } });
  const migrated = (await readLongAgentRegistry(f.home)).agents[0];
  assert.equal(migrated.definition.model.modelId, "new", "existing shared value wins");
  assert.deepEqual(JSON.parse(fs.readFileSync(definitionPath)), identity);
  const backup = path.join(f.home, "runtime/migrations/long-agent-workflow-config/friend/definition.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(backup)), legacy);
  await updateLongAgentRegistry(f.home, registry => ({ registry: { ...registry, agents: registry.agents.map(agent => ({ ...agent, enabled: false })) }, result: undefined }));
  assert.equal((await readAgentDurableConfig(base, "minimal-pi-coding-agent", "pi-coding-agent")).model.modelId, "new");
  assert.deepEqual(JSON.parse(fs.readFileSync(backup)), legacy);
  await updateAgentDurableConfig(base, "minimal-pi-coding-agent", "pi-coding-agent", { tools: null, resources: null });
  await updateLongAgentRegistry(f.home, registry => ({ registry: { ...registry, agents: registry.agents.map(agent => ({ ...agent,
    definition: { ...agent.definition, tools: { mode: "none" }, resources: { mode: "explicit", skillPaths: [], extensionPaths: [], pluginSources: [] } } })) }, result: undefined }));
  const restored = await readAgentDurableConfig(base, "minimal-pi-coding-agent", "pi-coding-agent");
  assert.equal(restored.tools.mode, "none", "compatibility writes compare the effective inherited value");
  assert.equal(restored.resources.mode, "explicit");
});

test("inspection exposes effective generation parameters and their source", async t => {
  const f = await fixture(t);
  const base = path.join(f.home, "long-agents/friend");
  await updateAgentDurableConfig(base, "minimal-pi-coding-agent", "pi-coding-agent", {
    generation: { temperature: 0.3, maxOutputTokens: 8192 },
  });
  const inspected = await inspectWorkflowAgent({ projectId: "friend", chatHome: f.home, cwd: base,
    workflowId: "minimal-pi-coding-agent", defaultAgent: PI_CODING_AGENT });
  assert.deepEqual(inspected.agent.effectiveGeneration, { temperature: 0.3, maxOutputTokens: 8192 });
  assert.equal(inspected.agent.generationSource, "durable");

  // 会话级选择覆盖持久配置，并把来源标记为 selection。
  const withSessionSelection = await inspectWorkflowAgent({ projectId: "friend", chatHome: f.home, cwd: base,
    workflowId: "minimal-pi-coding-agent", defaultAgent: PI_CODING_AGENT, selection: { generation: { topP: 0.8 } } });
  assert.deepEqual(withSessionSelection.agent.effectiveGeneration, { topP: 0.8 });
  assert.equal(withSessionSelection.agent.generationSource, "selection");
});
