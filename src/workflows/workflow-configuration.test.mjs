import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PromptResourceStore } from "../prompt-resources/store.ts";
import {
  CHAT_WORKFLOW_CONFIGURATION_CUSTOM_TYPE,
  collectChatWorkflowTurnConfigurations,
  collectLatestChatWorkflowConfigurations,
  prepareChatWorkflowTurnConfiguration,
} from "./workflow-configuration.ts";

function agent(id) {
  return {
    schemaVersion: 1,
    id,
    name: id,
    description: `${id} test Agent`,
    systemPrompt: { mode: "pi-default" },
    customInstructions: [],
    tools: { mode: "pi-default" },
    resources: { mode: "inherit" },
  };
}

function resources(name) {
  return {
    resources: {
      mode: "explicit",
      skillPaths: [name],
      extensionPaths: [],
      pluginSources: [],
    },
  };
}

test("a Workflow turn inherits its Session's latest Agent configuration", async () => {
  const manager = SessionManager.inMemory("/workspace");
  const first = await prepareChatWorkflowTurnConfiguration(manager, {
    invocationId: "turn-1",
    workflowId: "direct",
    agents: [agent("agent")],
    cwd: "/workspace",
    adjustments: { agent: resources("strict") },
  });
  const second = await prepareChatWorkflowTurnConfiguration(manager, {
    invocationId: "turn-2",
    workflowId: "direct",
    agents: [agent("agent")],
    cwd: "/workspace",
  });

  assert.deepEqual(first.agentConfigs, { agent: resources("strict") });
  assert.deepEqual(second.agentConfigs, first.agentConfigs);
  assert.deepEqual(collectLatestChatWorkflowConfigurations(manager.getEntries()), {
    direct: { agent: resources("strict") },
  });
  assert.deepEqual(collectChatWorkflowTurnConfigurations(manager.getEntries()), [
    { schemaVersion: 1, invocationId: "turn-1", workflowId: "direct", agentConfigs: first.agentConfigs },
    { schemaVersion: 1, invocationId: "turn-2", workflowId: "direct", agentConfigs: first.agentConfigs },
  ]);
  assert.deepEqual(manager.buildSessionContext().messages, []);
});

test("same Agent id remains isolated between Workflows", async () => {
  const manager = SessionManager.inMemory("/workspace");
  await prepareChatWorkflowTurnConfiguration(manager, {
    invocationId: "direct-1",
    workflowId: "direct",
    agents: [agent("pi-coding-agent")],
    cwd: "/workspace",
    adjustments: { "pi-coding-agent": resources("direct") },
  });
  await prepareChatWorkflowTurnConfiguration(manager, {
    invocationId: "planning-1",
    workflowId: "planning",
    agents: [agent("pi-coding-agent")],
    cwd: "/workspace",
    adjustments: { "pi-coding-agent": resources("planning") },
  });

  assert.deepEqual(collectLatestChatWorkflowConfigurations(manager.getEntries()), {
    direct: { "pi-coding-agent": resources("direct") },
    planning: { "pi-coding-agent": resources("planning") },
  });
});

test("an adjustment changes only named Agents and an empty selection restores defaults", async () => {
  const manager = SessionManager.inMemory("/workspace");
  const agents = [agent("planner"), agent("executor")];
  const defaults = { planner: resources("planner-default") };
  await prepareChatWorkflowTurnConfiguration(manager, {
    invocationId: "turn-1",
    workflowId: "planning",
    agents,
    cwd: "/workspace",
    defaults,
    adjustments: {
      planner: resources("planner-custom"),
      executor: resources("executor-custom"),
    },
  });
  const second = await prepareChatWorkflowTurnConfiguration(manager, {
    invocationId: "turn-2",
    workflowId: "planning",
    agents,
    cwd: "/workspace",
    defaults,
    adjustments: { planner: {} },
  });

  assert.deepEqual(second.agentConfigs, {
    planner: resources("planner-default"),
    executor: resources("executor-custom"),
  });
  assert.equal(
    manager.getEntries().filter((entry) => (
      entry.type === "custom" && entry.customType === CHAT_WORKFLOW_CONFIGURATION_CUSTOM_TYPE
    )).length,
    2,
  );
});

test("every Stage can reuse Agent definitions resolved once for the turn", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-workflow-frozen-agent-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, "agent.json");
  fs.writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    customInstructions: ["first revision"],
  }));
  const manager = SessionManager.inMemory(root);
  const prepared = await prepareChatWorkflowTurnConfiguration(manager, {
    invocationId: "turn-1",
    workflowId: "planning",
    agents: [agent("planner"), agent("executor")],
    cwd: root,
    adjustments: {
      planner: { append: [configPath] },
      executor: resources("executor"),
    },
  });
  fs.writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    customInstructions: ["changed after the run started"],
  }));

  assert.equal(prepared.agents.planner.customInstructions.at(-1).text, "first revision");
  assert.equal(prepared.agents.executor.resources.skillPaths[0], path.join(fs.realpathSync(root), "executor"));
  assert.equal(collectChatWorkflowTurnConfigurations(manager.getEntries()).length, 1);
});

test("invalid, unknown and future entries do not replace valid Session configuration", async () => {
  const manager = SessionManager.inMemory("/workspace");
  await prepareChatWorkflowTurnConfiguration(manager, {
    invocationId: "turn-1",
    workflowId: "direct",
    agents: [agent("agent")],
    cwd: "/workspace",
    adjustments: { agent: resources("valid") },
  });
  manager.appendCustomEntry(CHAT_WORKFLOW_CONFIGURATION_CUSTOM_TYPE, {
    schemaVersion: 2,
    workflowId: "direct",
    agentConfigs: { agent: resources("future") },
    actor: "user",
  });
  manager.appendCustomEntry(CHAT_WORKFLOW_CONFIGURATION_CUSTOM_TYPE, {
    schemaVersion: 1,
    workflowId: "direct",
    agentConfigs: { agent: { unknown: true } },
    actor: "user",
  });

  assert.deepEqual(collectLatestChatWorkflowConfigurations(manager.getEntries()), {
    direct: { agent: resources("valid") },
  });
  manager.appendCustomEntry(CHAT_WORKFLOW_CONFIGURATION_CUSTOM_TYPE, {
    schemaVersion: 1,
    workflowId: "direct",
    agentConfigs: { "removed-agent": resources("stale") },
    actor: "user",
  });
  const restored = await prepareChatWorkflowTurnConfiguration(manager, {
    invocationId: "turn-2",
    workflowId: "direct",
    agents: [agent("agent")],
    cwd: "/workspace",
  });
  assert.deepEqual(restored.agentConfigs, { agent: resources("valid") });
  assert.deepEqual(collectLatestChatWorkflowConfigurations(manager.getEntries()), {
    direct: { agent: resources("valid") },
  });
  await assert.rejects(prepareChatWorkflowTurnConfiguration(manager, {
    invocationId: "turn-3",
    workflowId: "direct",
    agents: [agent("agent")],
    cwd: "/workspace",
    adjustments: { missing: {} },
  }), /不存在Agent/);
});

test("a resource freeze failure does not persist latest configuration or a turn snapshot", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-workflow-freeze-failure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = SessionManager.inMemory(root);
  await assert.rejects(prepareChatWorkflowTurnConfiguration(manager, {
    invocationId: "turn-invalid",
    workflowId: "direct",
    agents: [agent("agent")],
    cwd: root,
    chatHome: path.join(root, "home"),
    adjustments: {
      agent: {
        promptResources: [{
          id: "missing-resource",
          target: { type: "personal" },
          selectedBy: "user",
        }],
      },
    },
  }), /找不到Prompt资源/);

  assert.deepEqual(collectLatestChatWorkflowConfigurations(manager.getEntries()), {});
  assert.deepEqual(collectChatWorkflowTurnConfigurations(manager.getEntries()), []);
});

test("a turn pins the exact Prompt resource revision and resolved content", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-workflow-resource-revision-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chatHome = path.join(root, "home");
  const store = new PromptResourceStore(path.join(chatHome, "prompt-resources"));
  const firstDraft = await store.createDraft({
    kind: "rule",
    title: "Frozen rule",
    purpose: "Freeze a turn",
    content: "revision one",
    author: { type: "user" },
  });
  const first = await store.commitDraft(firstDraft.id);
  const manager = SessionManager.inMemory(root);
  const prepared = await prepareChatWorkflowTurnConfiguration(manager, {
    invocationId: "turn-1",
    workflowId: "direct",
    agents: [agent("agent")],
    cwd: root,
    chatHome,
    adjustments: {
      agent: {
        promptResources: [{ id: first.id, target: { type: "personal" }, selectedBy: "user" }],
      },
    },
  });
  const secondDraft = await store.createDraft({
    baseResourceId: first.id,
    kind: first.kind,
    title: first.title,
    purpose: first.purpose,
    content: "revision two",
    author: { type: "user" },
  });
  await store.commitDraft(secondDraft.id);

  assert.equal(prepared.agentConfigs.agent.promptResources[0].revision, 1);
  assert.match(prepared.agents.agent.customInstructions.at(-1).text, /revision one/);
  assert.doesNotMatch(prepared.agents.agent.customInstructions.at(-1).text, /revision two/);
});
