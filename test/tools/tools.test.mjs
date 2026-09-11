import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRouter } from "nitro/h3";
import { openProject } from "../../src/projects/registry.ts";
import catalogHandler from "../../src/routes/api/workflows/[workflowId]/agents/[agentId]/catalog.get.ts";
import { listChatTools } from "../../src/resources/tools.ts";
import { inspectWorkflowAgent } from "../../src/workflows/agent-inspection.ts";
import { updateAgentDurableConfig } from "../../src/workflows/agent-model-config.ts";
import { PLANNER_AGENT } from "../../src/workflows/planning-execution/agents/planner/index.ts";
import { listChatSystemTools } from "../../src/tools/registry.ts";

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
    {
      address: "system:tool/agent_memory_search",
      name: "agent_memory_search",
      risk: "read-only",
      permissions: ["agent-memory:read"],
    },
    {
      address: "system:tool/agent_memory_read",
      name: "agent_memory_read",
      risk: "read-only",
      permissions: ["agent-memory:read"],
    },
    {
      address: "system:tool/agent_memory_write",
      name: "agent_memory_write",
      risk: "write",
      permissions: ["agent-memory:write"],
    },
    {
      address: "system:tool/project_search",
      name: "project_search",
      risk: "read-only",
      permissions: ["project:read"],
    },
    {
      address: "system:tool/project_read",
      name: "project_read",
      risk: "read-only",
      permissions: ["project:read"],
    },
    {
      address: "system:tool/project_create",
      name: "project_create",
      risk: "write",
      permissions: ["project:create"],
    },
    {
      address: "system:tool/project_open",
      name: "project_open",
      risk: "write",
      permissions: ["project:open"],
    },
    {
      address: "system:tool/project_update",
      name: "project_update",
      risk: "write",
      permissions: ["project:update"],
    },
    {
      address: "system:tool/project_configure",
      name: "project_configure",
      risk: "write",
      permissions: ["project:configure"],
    },
    {
      address: "system:tool/long_agent_manage",
      name: "long_agent_manage",
      risk: "destructive",
      permissions: ["long-agent:manage"],
    },
    {
      address: "system:tool/channel_send",
      name: "channel_send",
      risk: "write",
      permissions: ["channel:send"],
    },
    {
      address: "system:tool/task_manage",
      name: "task_manage",
      risk: "write",
      permissions: ["long-agent:task"],
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
  assert.equal(initial.skills.find((skill) => skill.name === "planner-context")?.owner, "project");
  const personalSkillDir = path.join(chatHome, "agent", "skills", "personal-note");
  fs.mkdirSync(personalSkillDir, { recursive: true });
  fs.writeFileSync(path.join(personalSkillDir, "SKILL.md"), [
    "---",
    "name: personal-note",
    "description: Personal skill for note taking",
    "---",
    "Use this when taking personal notes.",
  ].join("\n"));
  const withPersonal = await inspectWorkflowAgent({
    projectId: project.projectId,
    chatHome,
    cwd: project.cwd,
    defaultAgent: PLANNER_AGENT,
    workflowId: "planning-execution",
    agentId: PLANNER_AGENT.id,
    stageId: "plan",
  });
  assert.equal(withPersonal.skills.find((skill) => skill.name === "personal-note")?.owner, "personal");
  assert.equal(withPersonal.skills.find((skill) => skill.name === "planner-context")?.owner, "project");
  assert.match(initial.prompt.final, /<available_skills>/);
  assert.match(initial.prompt.final, /Read planning context for architecture tasks/);
  assert.match(initial.prompt.final, new RegExp(skillFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  // Durable resource policy: explicit selection is Project-scoped and persistent.
  await updateAgentDurableConfig(project.projectDataDir, "planning-execution", PLANNER_AGENT.id, {
    resources: { mode: "explicit", skillPaths: [skillFile], extensionPaths: [], pluginSources: [] },
  });
  const withResources = await inspectWorkflowAgent({
    projectId: project.projectId,
    chatHome,
    cwd: project.cwd,
    defaultAgent: PLANNER_AGENT,
    workflowId: "planning-execution",
    agentId: PLANNER_AGENT.id,
    stageId: "plan",
  });
  assert.deepEqual(withResources.skills.map((skill) => skill.name), ["planner-context"]);
  assert.deepEqual(withResources.agent.durableConfig?.resources, {
    mode: "explicit",
    skillPaths: [skillFile],
    extensionPaths: [],
    pluginSources: [],
  });
  await updateAgentDurableConfig(project.projectDataDir, "planning-execution", PLANNER_AGENT.id, {
    resources: null,
  });
  const restoredResources = await inspectWorkflowAgent({
    projectId: project.projectId,
    chatHome,
    cwd: project.cwd,
    defaultAgent: PLANNER_AGENT,
    workflowId: "planning-execution",
    agentId: PLANNER_AGENT.id,
    stageId: "plan",
  });
  assert.equal(restoredResources.agent.durableConfig?.resources, undefined);

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

test("Workflow Agent catalog keeps listing every system Tool after a durable Tool selection is saved", async (t) => {
  const { chatHome, workspace } = fixture(t);
  const previousHome = process.env.CHAT_HOME;
  process.env.CHAT_HOME = chatHome;
  t.after(() => {
    if (previousHome === undefined) delete process.env.CHAT_HOME;
    else process.env.CHAT_HOME = previousHome;
  });
  const project = await openProject({
    path: workspace,
    chatHome,
    id: "tool-catalog-project",
    name: "Tool Catalog Project",
  });
  // Simulates the user checking one system Tool in the Workflow Agent dialog:
  // the durable policy narrows to that single address.
  await updateAgentDurableConfig(project.projectDataDir, "planning-execution", PLANNER_AGENT.id, {
    tools: { mode: "pi-default", addresses: ["system:tool/memory_search"] },
  });

  const router = createRouter();
  router.get("/api/workflows/:workflowId/agents/:agentId/catalog", catalogHandler);
  const response = await router.fetch(new Request(
    `http://chat.test/api/workflows/planning-execution/agents/planner/catalog?projectId=${encodeURIComponent(project.projectId)}`,
  ));
  assert.equal(response.status, 200);
  const catalog = await response.json();
  assert.deepEqual(
    catalog.tools
      .filter((tool) => typeof tool.address === "string" && tool.address.startsWith("system:tool/"))
      .map((tool) => tool.address)
      .sort(),
    listChatSystemTools().map((tool) => tool.address).sort(),
    "catalog must keep listing every system Tool so unchecked options do not disappear",
  );
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
