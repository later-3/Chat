import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseWorkflowAgentDefinition,
} from "./agent-config.ts";
import { allowFileRoot } from "../files/access.ts";
import { resolveWorkflowAgentDefinition } from "./agent-config-loader.ts";
import {
  clearAgentModelConfig,
  readAgentModelConfig,
  writeAgentModelConfig,
} from "./agent-model-config.ts";

const defaultAgent = parseWorkflowAgentDefinition({
  schemaVersion: 1,
  id: "test-agent",
  name: "Test Agent",
  description: "Default Agent",
  systemPrompt: { mode: "pi-default" },
  customInstructions: ["default rule"],
  tools: { mode: "pi-default" },
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-agent-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("uses the Workflow Agent definition when no external file is selected", async () => {
  const resolved = await resolveWorkflowAgentDefinition({ defaultAgent, cwd: process.cwd() });
  assert.equal(resolved.id, "test-agent");
  assert.deepEqual(resolved.sources, [{ kind: "workflow-default" }]);
  assert.deepEqual(resolved.customInstructions, [{ text: "default rule" }]);
  assert.deepEqual(resolved.resources, { mode: "inherit" });
});

test("a primary Agent file replaces the Workflow default and resolves relative Prompt files", async (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, "system.md"), "External system prompt\n");
  fs.writeFileSync(path.join(dir, "rule.md"), "External rule\n");
  fs.writeFileSync(path.join(dir, "agent.json"), JSON.stringify({
    schemaVersion: 1,
    id: "test-agent",
    name: "Configured Agent",
    description: "External configuration",
    model: { provider: "provider-a", modelId: "model-a" },
    thinkingLevel: "high",
    systemPrompt: { mode: "replace", file: "./system.md" },
    customInstructions: [{ file: "./rule.md" }],
    tools: { mode: "explicit", names: ["read", "bash"], exclude: ["bash"] },
    resources: {
      mode: "explicit",
      skillPaths: ["./skills/review"],
      extensionPaths: ["./extensions/guard.ts"],
      pluginSources: ["npm:example-plugin", "./local-plugin"],
    },
  }));

  const resolved = await resolveWorkflowAgentDefinition({
    defaultAgent,
    cwd: dir,
    selection: { primary: "agent.json" },
  });
  assert.equal(resolved.name, "Configured Agent");
  assert.deepEqual(resolved.model, { provider: "provider-a", modelId: "model-a" });
  assert.equal(resolved.thinkingLevel, "high");
  assert.equal(resolved.systemPrompt.mode, "replace");
  assert.equal(resolved.systemPrompt.text, "External system prompt\n");
  assert.equal(resolved.systemPrompt.sourcePath, fs.realpathSync(path.join(dir, "system.md")));
  assert.deepEqual(resolved.customInstructions, [{
    text: "External rule\n",
    sourcePath: fs.realpathSync(path.join(dir, "rule.md")),
  }]);
  assert.deepEqual(resolved.tools, {
    mode: "explicit",
    names: ["read", "bash"],
    exclude: ["bash"],
  });
  assert.deepEqual(resolved.resources, {
    mode: "explicit",
    skillPaths: [path.join(fs.realpathSync(dir), "skills/review")],
    extensionPaths: [path.join(fs.realpathSync(dir), "extensions/guard.ts")],
    pluginSources: ["npm:example-plugin", path.join(fs.realpathSync(dir), "local-plugin")],
  });
  assert.deepEqual(resolved.sources, [{ kind: "primary", path: fs.realpathSync(path.join(dir, "agent.json")) }]);
});

test("append files override scalar fields and append unique instructions in order", async (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, "shared.md"), "shared file rule");
  fs.writeFileSync(path.join(dir, "one.json"), JSON.stringify({
    schemaVersion: 1,
    model: { provider: "one", modelId: "model-one" },
    customInstructions: ["one", { file: "shared.md" }],
  }));
  fs.writeFileSync(path.join(dir, "two.json"), JSON.stringify({
    schemaVersion: 1,
    model: { provider: "two", modelId: "model-two" },
    customInstructions: ["one", "two", { file: "shared.md" }],
  }));

  const resolved = await resolveWorkflowAgentDefinition({
    defaultAgent,
    cwd: dir,
    selection: {
      append: ["one.json", "two.json"],
      promptFiles: ["shared.md"],
    },
  });
  assert.deepEqual(resolved.model, { provider: "two", modelId: "model-two" });
  assert.deepEqual(resolved.customInstructions.map((item) => item.text), [
    "default rule",
    "one",
    "shared file rule",
    "two",
  ]);
  assert.deepEqual(resolved.sources.map((source) => source.kind), [
    "workflow-default",
    "append",
    "append",
  ]);
});

test("rejects identity changes in appended configuration", async (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, "invalid.json"), JSON.stringify({
    schemaVersion: 1,
    id: "another-agent",
  }));
  await assert.rejects(
    resolveWorkflowAgentDefinition({
      defaultAgent,
      cwd: dir,
      selection: { append: ["invalid.json"] },
    }),
    /不能修改id、name或description/,
  );
});

test("Agent files and local resources cannot escape Chat's authorized roots", async (t) => {
  const root = fixture(t);
  const project = path.join(root, "project");
  const outside = path.join(root, "outside");
  fs.mkdirSync(project);
  fs.mkdirSync(outside);
  const externalConfig = path.join(outside, "agent.json");
  const externalExtension = path.join(outside, "extension.ts");
  fs.writeFileSync(externalConfig, JSON.stringify({
    schemaVersion: 1,
    id: "test-agent",
    name: "External Agent",
    description: "Outside the Project",
  }));
  fs.writeFileSync(externalExtension, "export default () => ({});\n");

  await assert.rejects(resolveWorkflowAgentDefinition({
    defaultAgent,
    cwd: project,
    selection: { primary: externalConfig },
  }), /路径不在Chat授权目录内/);
  await assert.rejects(resolveWorkflowAgentDefinition({
    defaultAgent,
    cwd: project,
    selection: {
      resources: {
        mode: "explicit",
        skillPaths: [],
        extensionPaths: [externalExtension],
        pluginSources: [],
      },
    },
  }), /路径不在Chat授权目录内/);

  allowFileRoot(outside);
  const resolved = await resolveWorkflowAgentDefinition({
    defaultAgent,
    cwd: project,
    selection: { primary: externalConfig },
  });
  assert.equal(resolved.name, "External Agent");
});

test("the current Agent resource selection overrides configuration files", async (t) => {
  const dir = fixture(t);
  const resolved = await resolveWorkflowAgentDefinition({
    defaultAgent,
    cwd: dir,
    selection: {
      resources: {
        mode: "explicit",
        skillPaths: ["skills/one"],
        extensionPaths: ["extensions/one.ts"],
        pluginSources: ["git:https://example.com/plugin.git"],
      },
    },
  });
  const canonicalDir = fs.realpathSync(dir);
  assert.deepEqual(resolved.resources, {
    mode: "explicit",
    skillPaths: [path.join(canonicalDir, "skills/one")],
    extensionPaths: [path.join(canonicalDir, "extensions/one.ts")],
    pluginSources: ["git:https://example.com/plugin.git"],
  });
});

test("durable Agent model configuration persists and applies over the Workflow default", async (t) => {
  const projectDataDir = fixture(t);
  const config = await writeAgentModelConfig(projectDataDir, "workflow-1", "test-agent", {
    schemaVersion: 1,
    model: { provider: "durable-provider", modelId: "durable-model" },
    thinkingLevel: "high",
  });
  assert.deepEqual(config, {
    schemaVersion: 1,
    model: { provider: "durable-provider", modelId: "durable-model" },
    thinkingLevel: "high",
  });
  assert.deepEqual(await readAgentModelConfig(projectDataDir, "workflow-1", "test-agent"), config);

  const resolved = await resolveWorkflowAgentDefinition({
    defaultAgent,
    cwd: projectDataDir,
    durableModelConfig: { projectDataDir, workflowId: "workflow-1", agentId: "test-agent" },
  });
  assert.deepEqual(resolved.model, { provider: "durable-provider", modelId: "durable-model" });
  assert.equal(resolved.thinkingLevel, "high");
  assert.equal(resolved.sources.at(-1).kind, "durable-config");
});

test("durable model configuration wins over selected configuration files", async (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, "append.json"), JSON.stringify({
    schemaVersion: 1,
    model: { provider: "file-provider", modelId: "file-model" },
  }));
  const projectDataDir = path.join(dir, "data");
  fs.mkdirSync(projectDataDir, { recursive: true });
  await writeAgentModelConfig(projectDataDir, "workflow-1", "test-agent", {
    schemaVersion: 1,
    model: { provider: "durable-provider", modelId: "durable-model" },
  });

  const resolved = await resolveWorkflowAgentDefinition({
    defaultAgent,
    cwd: dir,
    selection: { append: ["append.json"] },
    durableModelConfig: { projectDataDir, workflowId: "workflow-1", agentId: "test-agent" },
  });
  assert.deepEqual(resolved.model, { provider: "durable-provider", modelId: "durable-model" });
  assert.deepEqual(resolved.sources.map((source) => source.kind), [
    "workflow-default",
    "append",
    "durable-config",
  ]);
});

test("clearing the durable model configuration restores the Workflow default", async (t) => {
  const projectDataDir = fixture(t);
  await writeAgentModelConfig(projectDataDir, "workflow-1", "test-agent", {
    schemaVersion: 1,
    model: { provider: "durable-provider", modelId: "durable-model" },
  });
  assert.equal(await clearAgentModelConfig(projectDataDir, "workflow-1", "test-agent"), true);
  assert.equal(await clearAgentModelConfig(projectDataDir, "workflow-1", "test-agent"), false);
  assert.equal(await readAgentModelConfig(projectDataDir, "workflow-1", "test-agent"), undefined);

  const resolved = await resolveWorkflowAgentDefinition({
    defaultAgent,
    cwd: projectDataDir,
    durableModelConfig: { projectDataDir, workflowId: "workflow-1", agentId: "test-agent" },
  });
  assert.equal(resolved.model, undefined);
  assert.deepEqual(resolved.sources, [{ kind: "workflow-default" }]);
});

test("durable model configuration rejects unknown fields, empty configs, and invalid entity ids", async (t) => {
  const projectDataDir = fixture(t);
  await assert.rejects(
    writeAgentModelConfig(projectDataDir, "workflow-1", "test-agent", { schemaVersion: 1, apiKey: "secret" }),
    /未知字段/,
  );
  await assert.rejects(
    writeAgentModelConfig(projectDataDir, "workflow-1", "test-agent", { schemaVersion: 1 }),
    /至少需要model或thinkingLevel/,
  );
  await assert.rejects(
    writeAgentModelConfig(projectDataDir, "workflow-1", "test-agent", {
      schemaVersion: 1,
      thinkingLevel: "mega",
    }),
    /thinkingLevel无效/,
  );
  await assert.rejects(
    writeAgentModelConfig(projectDataDir, "../escape", "test-agent", {
      schemaVersion: 1,
      model: { provider: "p", modelId: "m" },
    }),
    /workflowId格式无效/,
  );
  assert.equal(await readAgentModelConfig(projectDataDir, "workflow-1", "test-agent"), undefined);
});
