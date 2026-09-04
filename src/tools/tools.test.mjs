import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openProject } from "../projects/registry.ts";
import { listChatTools } from "../resources/tools.ts";
import { inspectWorkflowAgent } from "../workflows/agent-inspection.ts";
import { updateAgentDurableConfig } from "../workflows/agent-model-config.ts";
import { PLANNER_AGENT } from "../workflows/planning-execution/agents/planner/index.ts";
import { listChatSystemTools } from "./registry.ts";

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-tools-"));
  const chatHome = path.join(base, ".chat");
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { chatHome, workspace };
}

test("Chat system Tool manifests are stable, qualified, and risk classified", () => {
  assert.deepEqual(listChatSystemTools().map((tool) => ({
    address: tool.address,
    name: tool.manifest.name,
    risk: tool.manifest.risk,
    permissions: tool.manifest.permissions,
  })), [
    {
      address: "system:tool/memory_search",
      name: "memory_search",
      risk: "read-only",
      permissions: ["memory:read"],
    },
    {
      address: "system:tool/memory_record",
      name: "memory_record",
      risk: "write",
      permissions: ["memory:write"],
    },
    {
      address: "system:tool/workflow_call",
      name: "workflow_call",
      risk: "write",
      permissions: ["workflow:call"],
    },
  ]);
  const memorySearch = listChatSystemTools().find((tool) => tool.manifest.name === "memory_search");
  assert.equal(memorySearch?.version, "system:memory-search@2");
  assert.match(memorySearch?.manifest.description ?? "", /stable user background, preferences, historical decisions/);
  assert.match(memorySearch?.manifest.description ?? "", /never invent a match/);
});

test("Planner resolves the system Memory Tool and Project overrides remain durable", async (t) => {
  const { chatHome, workspace } = fixture(t);
  const project = await openProject({
    path: workspace,
    chatHome,
    id: "tool-project",
    name: "Tool Project",
  });
  const skillDir = path.join(project.projectConfigDir, "skills", "planner-context");
  const skillFile = path.join(skillDir, "SKILL.md");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(skillFile, [
    "---",
    "name: planner-context",
    "description: Read planning context for architecture tasks",
    "---",
    "Use the project architecture context when preparing an implementation plan.",
  ].join("\n"));

  const initial = await inspectWorkflowAgent({
    projectId: project.projectId,
    chatHome,
    cwd: project.cwd,
    defaultAgent: PLANNER_AGENT,
    workflowId: "planning-execution",
    agentId: PLANNER_AGENT.id,
    stageId: "plan",
  });
  const memorySearch = initial.tools.find((tool) => tool.name === "memory_search");
  assert.equal(memorySearch?.active, true);
  assert.equal(memorySearch?.address, "system:tool/memory_search");
  assert.equal(memorySearch?.risk, "read-only");
  assert.deepEqual(
    initial.tools.filter((tool) => tool.active).map((tool) => tool.name),
    ["read", "memory_search"],
  );
  assert.equal(initial.tools.some((tool) => tool.name === "workflow_call"), false);
  assert.equal(initial.skills.some((skill) => skill.name === "planner-context"), true);
  assert.match(initial.prompt.final, /<available_skills>/);
  assert.match(initial.prompt.final, /Read planning context for architecture tasks/);
  assert.match(initial.prompt.final, new RegExp(skillFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  await updateAgentDurableConfig(project.projectDataDir, "planning-execution", PLANNER_AGENT.id, {
    tools: { mode: "none" },
  });
  const disabled = await inspectWorkflowAgent({
    projectId: project.projectId,
    chatHome,
    cwd: project.cwd,
    defaultAgent: PLANNER_AGENT,
    workflowId: "planning-execution",
    agentId: PLANNER_AGENT.id,
    stageId: "plan",
  });
  assert.equal(disabled.tools.some((tool) => tool.name === "memory_search"), false);
  assert.deepEqual(disabled.agent.durableConfig?.tools, { mode: "none" });

  const extensionDir = path.join(project.projectConfigDir, "extensions");
  fs.mkdirSync(extensionDir, { recursive: true });
  fs.writeFileSync(path.join(extensionDir, "project-tool.ts"), [
    "export default function register(pi) {",
    "  pi.registerTool({",
    "    name: 'project_lookup',",
    "    label: 'Project lookup',",
    "    description: 'Look up Project data.',",
    "    parameters: { type: 'object', properties: {}, additionalProperties: false },",
    "    async execute() { return { content: [{ type: 'text', text: 'ok' }], details: {} }; },",
    "  });",
    "}",
  ].join("\n"));

  const catalog = await listChatTools(project.projectId, chatHome);
  const catalogSearch = catalog.tools.find((tool) => tool.address === "system:tool/memory_search");
  assert.ok(catalogSearch);
  assert.ok(catalogSearch.consumers.some((consumer) => (
    consumer.workflowId === "planning-execution"
    && consumer.agentId === "planner"
    && consumer.source === "workflow-default"
    && consumer.enabled
  )));
  assert.ok(catalogSearch.consumers.some((consumer) => (
    consumer.workflowId === "planning-execution"
    && consumer.agentId === "planner"
    && consumer.source === "project-config"
    && !consumer.enabled
  )));
  const projectTool = catalog.tools.find((tool) => tool.name === "project_lookup");
  assert.equal(projectTool?.sourceInfo.scope, "project");
  assert.equal(projectTool?.address, "project/tool-project:tool/project_lookup");

  await updateAgentDurableConfig(project.projectDataDir, "planning-execution", PLANNER_AGENT.id, {
    tools: {
      mode: "explicit",
      names: ["project_lookup"],
      exclude: [],
      addresses: ["system:tool/memory_search"],
    },
  });
  const projectSelected = await inspectWorkflowAgent({
    projectId: project.projectId,
    chatHome,
    cwd: project.cwd,
    defaultAgent: PLANNER_AGENT,
    workflowId: "planning-execution",
    agentId: PLANNER_AGENT.id,
    stageId: "plan",
  });
  assert.equal(projectSelected.tools.find((tool) => tool.name === "project_lookup")?.active, true);
  assert.equal(projectSelected.tools.find((tool) => tool.name === "project_lookup")?.sourceInfo.scope, "project");
  assert.equal(projectSelected.tools.find((tool) => tool.name === "memory_search")?.active, true);
});

test("workflow_call is available to any Agent only when its system Tool address is selected", async (t) => {
  const { chatHome, workspace } = fixture(t);
  const project = await openProject({
    path: workspace,
    chatHome,
    id: "workflow-call-tool-project",
    name: "Workflow Call Tool Project",
  });
  const configuredAgent = {
    ...PLANNER_AGENT,
    tools: {
      mode: "explicit",
      names: ["read"],
      exclude: [],
      addresses: ["system:tool/workflow_call"],
    },
  };

  const inspection = await inspectWorkflowAgent({
    projectId: project.projectId,
    chatHome,
    cwd: project.cwd,
    defaultAgent: configuredAgent,
    workflowId: "planning-execution",
    agentId: configuredAgent.id,
    stageId: "plan",
  });

  const workflowCall = inspection.tools.find((tool) => tool.name === "workflow_call");
  assert.equal(workflowCall?.active, true);
  assert.equal(workflowCall?.address, "system:tool/workflow_call");
  assert.equal(workflowCall?.sourceInfo.source, "chat-system");
  assert.equal(workflowCall?.risk, "write");
});
