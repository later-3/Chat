import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getPromptResourceStore } from "../prompt-resources/store.ts";
import { openProject } from "../projects/registry.ts";
import { runPiCodingAgentPromptStep } from "./minimal-pi-coding-agent/step.ts";
import { PI_CODING_AGENT } from "./minimal-pi-coding-agent/agents/pi-coding-agent/index.ts";
import { inspectWorkflowAgent } from "./agent-inspection.ts";
import {
  runPlanningExecutionStep,
  runPlanningStep,
} from "./planning-execution/steps.ts";
import { runRuleManagementStep } from "./rule-management/step.ts";
import {
  collectChatWorkflowAgentInputs,
  collectChatWorkflowMessages,
} from "./workflow-stage.ts";
import { collectChatWorkflowTurnConfigurations } from "./workflow-configuration.ts";

function messageText(message) {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function writeFauxConfiguration(agentDir, faux, settings = {}) {
  const model = faux.getModel();
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: model.provider,
    defaultModel: model.id,
    defaultThinkingLevel: "off",
    compaction: { enabled: true },
    ...settings,
  }));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      [model.provider]: {
        baseUrl: model.baseUrl,
        api: model.api,
        apiKey: "faux-key",
        models: [{
          id: model.id,
          name: model.name,
          reasoning: model.reasoning,
          input: model.input,
          cost: model.cost,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        }],
      },
    },
  }));
}

function recordCall(calls, context) {
  calls.push({
    systemPrompt: context.systemPrompt,
    messages: structuredClone(context.messages),
    toolNames: (context.tools ?? []).map((tool) => tool.name),
  });
}

test("Workflow selection appends every Agent phase to one Chat Session", { concurrency: false }, async (t) => {
  const previousCwd = process.cwd();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-session-workflows-"));
  const faux = registerFauxProvider({ api: "chat-faux", provider: "chat-faux" });
  t.after(() => {
    faux.unregister();
    process.chdir(previousCwd);
    fs.rmSync(base, { recursive: true, force: true });
  });
  process.chdir(base);
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace);
  const chatHome = path.join(base, "chat-home");
  const project = await openProject({
    path: workspace,
    chatHome,
    createIfMissing: true,
    id: "session-workflows",
    name: "Session Workflows",
  });
  writeFauxConfiguration(path.join(chatHome, "agent"), faux);

  const calls = [];
  faux.setResponses([
    (context) => {
      recordCall(calls, context);
      return fauxAssistantMessage("direct one");
    },
    (context) => {
      recordCall(calls, context);
      return fauxAssistantMessage("plan one");
    },
    (context) => {
      recordCall(calls, context);
      return fauxAssistantMessage("executed plan one");
    },
    (context) => {
      recordCall(calls, context);
      return fauxAssistantMessage("direct two");
    },
  ]);

  const first = await runPiCodingAgentPromptStep({
    projectId: project.projectId,
    chatHome,
    cwd: workspace,
    prompt: "first request",
    workflowInvocationId: "direct-invocation-1",
  });
  const planning = await runPlanningStep({
    projectId: project.projectId,
    chatHome,
    cwd: workspace,
    sessionId: first.sessionId,
    prompt: "planned request",
    workflowInvocationId: "planning-invocation-1",
  });
  const execution = await runPlanningExecutionStep({
    projectId: project.projectId,
    chatHome,
    cwd: workspace,
    sessionId: planning.sessionId,
    workflowInvocationId: "planning-invocation-1",
    prompt: "planned request",
    plan: planning.plan,
    agent: planning.executionAgent,
  });
  const last = await runPiCodingAgentPromptStep({
    projectId: project.projectId,
    chatHome,
    cwd: workspace,
    sessionId: execution.sessionId,
    prompt: "final request",
    workflowInvocationId: "direct-invocation-2",
  });

  assert.equal(planning.sessionId, first.sessionId);
  assert.equal(execution.sessionId, first.sessionId);
  assert.equal(last.sessionId, first.sessionId);
  assert.equal(execution.sessionFile, first.sessionFile);
  assert.equal(last.sessionFile, first.sessionFile);
  assert.equal(fs.readdirSync(project.sessionDir).length, 1);

  const manager = SessionManager.open(first.sessionFile, project.sessionDir);
  const workflowStages = manager.getEntries()
    .filter((entry) => entry.type === "custom" && entry.customType === "chat.workflow_stage")
    .map((entry) => entry.data);
  assert.deepEqual(workflowStages, [
    {
      schemaVersion: 1,
      invocationId: "direct-invocation-1",
      workflowId: "minimal-pi-coding-agent",
      stageId: "execute",
      agentId: "pi-coding-agent",
    },
    {
      schemaVersion: 1,
      invocationId: "planning-invocation-1",
      workflowId: "planning-execution",
      stageId: "plan",
      agentId: "planner",
    },
    {
      schemaVersion: 1,
      invocationId: "planning-invocation-1",
      workflowId: "planning-execution",
      stageId: "execute",
      agentId: "pi-coding-agent",
    },
    {
      schemaVersion: 1,
      invocationId: "direct-invocation-2",
      workflowId: "minimal-pi-coding-agent",
      stageId: "execute",
      agentId: "pi-coding-agent",
    },
  ]);
  const workflowMessages = collectChatWorkflowMessages(manager.getEntries());
  assert.equal(workflowMessages.length, 1);
  assert.equal(workflowMessages[0].workflowId, "planning-execution");
  assert.equal(workflowMessages[0].stageId, "plan");
  assert.equal(workflowMessages[0].agentId, "planner");
  assert.equal(messageText(workflowMessages[0].message), "plan one");
  const workflowAgentInputs = collectChatWorkflowAgentInputs(manager.getEntries());
  assert.equal(workflowAgentInputs.length, 2);
  assert.deepEqual(workflowAgentInputs.map(({ entryId: _entryId, ...input }) => input), [
    {
      schemaVersion: 1,
      invocationId: "planning-invocation-1",
      workflowId: "planning-execution",
      stageId: "plan",
      agentId: "planner",
      userPrompt: "planned request",
    },
    {
      schemaVersion: 1,
      invocationId: "planning-invocation-1",
      workflowId: "planning-execution",
      stageId: "execute",
      agentId: "pi-coding-agent",
      userPrompt: "planned request",
      upstream: {
        stageId: "plan",
        agentId: "planner",
        output: "plan one",
      },
    },
  ]);
  const messages = manager.buildSessionContext().messages;
  assert.deepEqual(
    messages.filter((message) => message.role === "user").map(messageText),
    ["first request", "planned request", "final request"],
  );
  assert.deepEqual(
    messages.filter((message) => message.role === "assistant").map(messageText),
    ["direct one", "executed plan one", "direct two"],
  );
  assert.equal(messages.some((message) => message.role === "custom"), false);

  assert.equal(calls.length, 4);
  assert.equal(calls.flatMap((call) => call.messages).some((message) => message.role === "custom"), false);
  assert.match(calls[1].systemPrompt, /任务规划Agent/);
  assert.equal(calls[1].toolNames.length, 0);
  assert.ok(calls[1].messages.some((message) => message.role === "assistant" && messageText(message) === "direct one"));
  assert.match(calls[2].systemPrompt, /workflow_execution_input/);
  assert.ok(calls[2].messages.some((message) => (
    message.role === "user"
    && messageText(message).includes('"userRequest": "planned request"')
    && messageText(message).includes('"plannerOutput": "plan one"')
  )));
  assert.ok(calls[2].messages.some((message) => message.role === "user" && messageText(message) === "planned request"));
  assert.ok(calls[3].messages.some((message) => message.role === "assistant" && messageText(message) === "executed plan one"));
  assert.deepEqual(
    calls[3].messages.filter((message) => message.role === "user").map(messageText),
    ["first request", "planned request", "final request"],
  );
  assert.equal(
    calls[3].messages.some((message) => message.role === "user" && messageText(message).includes("plan one")),
    false,
  );
  assert.equal(calls[3].messages.some((message) => messageText(message).includes("上一条Planner")), false);
});

test("Planning Workflow can create the first durable Chat Session", { concurrency: false }, async (t) => {
  const previousCwd = process.cwd();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-first-planning-workflow-"));
  const faux = registerFauxProvider({ api: "chat-first-planning-faux", provider: "chat-first-planning-faux" });
  t.after(() => {
    faux.unregister();
    process.chdir(previousCwd);
    fs.rmSync(base, { recursive: true, force: true });
  });
  process.chdir(base);
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace);
  const chatHome = path.join(base, "chat-home");
  const project = await openProject({
    path: workspace,
    chatHome,
    createIfMissing: true,
    id: "first-planning",
    name: "First Planning",
  });
  writeFauxConfiguration(path.join(chatHome, "agent"), faux);

  const calls = [];
  faux.setResponses([
    (context) => {
      recordCall(calls, context);
      return fauxAssistantMessage("first plan");
    },
    (context) => {
      recordCall(calls, context);
      return fauxAssistantMessage("first execution");
    },
  ]);

  const planning = await runPlanningStep({
    projectId: project.projectId,
    chatHome,
    cwd: workspace,
    prompt: "first planned request",
    workflowInvocationId: "first-planning-invocation",
  });
  const sessionDir = project.sessionDir;
  assert.equal(fs.readdirSync(sessionDir).length, 1);

  const execution = await runPlanningExecutionStep({
    projectId: project.projectId,
    chatHome,
    cwd: workspace,
    sessionId: planning.sessionId,
    workflowInvocationId: "first-planning-invocation",
    prompt: "first planned request",
    plan: planning.plan,
    agent: planning.executionAgent,
  });
  const manager = SessionManager.open(execution.sessionFile, sessionDir);

  assert.deepEqual(
    manager.buildSessionContext().messages.map((message) => [message.role, messageText(message)]),
    [
      ["user", "first planned request"],
      ["assistant", "first execution"],
    ],
  );
  assert.ok(calls[1].messages.some(
    (message) => (
      message.role === "user"
      && messageText(message).includes('"userRequest": "first planned request"')
      && messageText(message).includes('"plannerOutput": "first plan"')
    ),
  ));
});

test("Direct Workflow applies the selected Pi Coding Agent configuration", { concurrency: false }, async (t) => {
  const previousCwd = process.cwd();
  const previousChatHome = process.env.CHAT_HOME;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-agent-config-workflow-"));
  const faux = registerFauxProvider({ api: "chat-agent-config-faux", provider: "chat-agent-config-faux" });
  t.after(() => {
    faux.unregister();
    process.chdir(previousCwd);
    if (previousChatHome === undefined) delete process.env.CHAT_HOME;
    else process.env.CHAT_HOME = previousChatHome;
    fs.rmSync(base, { recursive: true, force: true });
  });
  process.chdir(base);
  process.env.CHAT_HOME = path.join(base, ".chat");
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace);
  writeFauxConfiguration(path.join(base, ".chat", "agent"), faux);
  const project = await openProject({
    path: workspace,
    chatHome: process.env.CHAT_HOME,
    createIfMissing: true,
    id: "agent-config",
    name: "Agent Config",
  });
  const model = faux.getModel();
  const skillDir = path.join(workspace, "skills", "configured-review");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
    "---", "name: configured-review", "description: Configured review", "---", "Review configured output.",
  ].join("\n"));
  const configPath = path.join(workspace, "configured-agent.json");
  fs.writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    id: "pi-coding-agent",
    name: "Configured Pi Coding Agent",
    description: "Integration test Agent",
    model: { provider: model.provider, modelId: model.id },
    thinkingLevel: "off",
    systemPrompt: { mode: "replace", text: "Configured system prompt" },
    customInstructions: ["Configured additional rule"],
    tools: { mode: "explicit", names: ["read"], exclude: [] },
    resources: {
      mode: "explicit",
      skillPaths: [skillDir],
      extensionPaths: [],
      pluginSources: [],
    },
  }));
  const promptResourceStore = await getPromptResourceStore({ type: "personal" }, process.env.CHAT_HOME);
  const ruleDraft = await promptResourceStore.createDraft({
    kind: "rule",
    title: "Configured architecture rule",
    purpose: "Keep the configured module boundary explicit.",
    content: "Do not add unrelated responsibilities to the configured module.",
    tags: ["architecture"],
    sources: [{
      type: "session",
      projectId: "source-project",
      sessionId: "source-session",
      workflowInvocationId: "source-invocation",
      entryIds: ["source-entry"],
      context: "The module previously accumulated unrelated behavior.",
      capturedAt: "2026-08-30T06:00:00.000Z",
    }],
    author: { type: "user" },
  });
  const rule = await promptResourceStore.commitDraft(ruleDraft.id);

  const calls = [];
  faux.setResponses([(context) => {
    recordCall(calls, context);
    return fauxAssistantMessage("configured response");
  }]);
  const result = await runPiCodingAgentPromptStep({
    projectId: project.projectId,
    chatHome: process.env.CHAT_HOME,
    cwd: workspace,
    prompt: "configured request",
    workflowInvocationId: "configured-invocation",
    agentConfigs: {
      "pi-coding-agent": {
        primary: configPath,
        promptResources: [{ id: rule.id, target: { type: "personal" }, selectedBy: "user" }],
      },
    },
  });

  assert.equal(result.text, "configured response");
  assert.equal(result.model?.provider, model.provider);
  assert.equal(result.model?.modelId, model.id);
  assert.match(calls[0].systemPrompt, /Configured system prompt/);
  assert.match(calls[0].systemPrompt, /<chat_agent_custom_instructions>/);
  assert.match(calls[0].systemPrompt, /Configured additional rule/);
  assert.match(calls[0].systemPrompt, /<chat_prompt_resource/);
  assert.match(calls[0].systemPrompt, /Do not add unrelated responsibilities/);
  assert.match(calls[0].systemPrompt, /Configured review/);
  assert.deepEqual(calls[0].toolNames, ["read"]);
  const manager = SessionManager.open(result.sessionFile, project.sessionDir);
  const snapshot = collectChatWorkflowTurnConfigurations(manager.getEntries())[0];
  assert.equal(snapshot.agentConfigs["pi-coding-agent"].promptResources[0].revision, rule.revision);
});

test("Agent inspection uses the same resolved Prompt, resources and tools as execution", { concurrency: false }, async (t) => {
  const previousCwd = process.cwd();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-agent-inspection-"));
  const faux = registerFauxProvider({ api: "chat-inspection-faux", provider: "chat-inspection-faux" });
  t.after(() => {
    faux.unregister();
    process.chdir(previousCwd);
    fs.rmSync(base, { recursive: true, force: true });
  });
  process.chdir(base);
  const chatHome = path.join(base, "chat-home");
  const workspace = path.join(base, "workspace");
  const skillDir = path.join(workspace, "skills", "review");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
    "---",
    "name: review",
    "description: Review code",
    "---",
    "Review the changed code carefully.",
  ].join("\n"));
  writeFauxConfiguration(path.join(chatHome, "agent"), faux);

  const inspection = await inspectWorkflowAgent({
    chatHome,
    cwd: workspace,
    defaultAgent: PI_CODING_AGENT,
    selection: {
      append: [],
      resources: {
        mode: "explicit",
        skillPaths: [skillDir],
        extensionPaths: [],
        pluginSources: [],
      },
    },
  });

  assert.equal(inspection.agent.effectiveModel.provider, faux.getModel().provider);
  const reviewSkill = inspection.skills.find((skill) => skill.name === "review");
  assert.ok(reviewSkill);
  assert.ok(inspection.skills.some((skill) => skill.name === "chat-architecture"));
  assert.match(reviewSkill.content, /Review the changed code carefully/);
  assert.match(inspection.prompt.final, /Review code/);
  assert.ok(inspection.tools.some((tool) => tool.name === "read" && tool.active));
  assert.deepEqual(inspection.extensions, []);
});

test("Rule Management Workflow loads its Skill and executes Chat-owned tools in the same Session", { concurrency: false }, async (t) => {
  const previousCwd = process.cwd();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-rule-management-workflow-"));
  const faux = registerFauxProvider({ api: "chat-rule-management-faux", provider: "chat-rule-management-faux" });
  t.after(() => {
    faux.unregister();
    process.chdir(previousCwd);
    fs.rmSync(base, { recursive: true, force: true });
  });
  process.chdir(base);
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace);
  const chatHome = path.join(base, ".chat");
  const project = await openProject({
    path: workspace,
    chatHome,
    createIfMissing: true,
    id: "rule-management-project",
    name: "Rule Management Project",
  });
  writeFauxConfiguration(path.join(chatHome, "agent"), faux);

  const calls = [];
  faux.setResponses([
    (context) => {
      recordCall(calls, context);
      return fauxAssistantMessage([
        fauxText("I will search the resource library."),
        fauxToolCall("prompt_resource_search", { query: "architecture" }, { id: "search-1" }),
      ], { stopReason: "toolUse" });
    },
    (context) => {
      recordCall(calls, context);
      return fauxAssistantMessage("No matching resources were found.");
    },
  ]);
  const result = await runRuleManagementStep({
    projectId: "rule-management-project",
    chatHome,
    cwd: project.cwd,
    prompt: "帮我查一下架构规则",
    workflowInvocationId: "rule-management-invocation",
  });

  assert.equal(result.text, "No matching resources were found.");
  assert.match(calls[0].systemPrompt, /rule-library/);
  assert.ok(calls[0].toolNames.includes("prompt_resource_search"));
  assert.equal(calls[0].toolNames.includes("read"), false);
  assert.equal(
    fs.existsSync(path.join(chatHome, "runtime", "skills", "rule-library", "SKILL.md")),
    true,
  );
  const manager = SessionManager.open(
    result.sessionFile,
    path.join(chatHome, "projects", "rule-management-project", "sessions"),
  );
  assert.ok(manager.getEntries().some((entry) => (
    entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "prompt_resource_search"
  )));
});

test("Pi auto-compaction remains part of the same Chat Session", { concurrency: false }, async (t) => {
  const previousCwd = process.cwd();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-session-compaction-"));
  const faux = registerFauxProvider({
    api: "chat-compaction-faux",
    provider: "chat-compaction-faux",
    models: [{ id: "tiny", contextWindow: 10_000, maxTokens: 1_000 }],
  });
  t.after(() => {
    faux.unregister();
    process.chdir(previousCwd);
    fs.rmSync(base, { recursive: true, force: true });
  });
  process.chdir(base);
  const workspace = path.join(base, "workspace");
  const chatHome = path.join(base, "chat-home");
  const agentDir = path.join(chatHome, "agent");
  fs.mkdirSync(workspace);
  const project = await openProject({
    path: workspace,
    chatHome,
    createIfMissing: true,
    id: "compaction",
    name: "Compaction",
  });
  writeFauxConfiguration(agentDir, faux, {
    compaction: { enabled: true, reserveTokens: 9_000, keepRecentTokens: 10 },
  });

  const calls = [];
  const firstResponse = "A".repeat(40);
  faux.setResponses([
    (context) => {
      recordCall(calls, context);
      return fauxAssistantMessage(firstResponse);
    },
    (context) => {
      recordCall(calls, context);
      return fauxAssistantMessage("compacted history");
    },
    (context) => {
      recordCall(calls, context);
      return fauxAssistantMessage("continued after compaction");
    },
  ]);

  const first = await runPiCodingAgentPromptStep({
    projectId: project.projectId,
    chatHome,
    cwd: workspace,
    prompt: "long request ".repeat(40),
    workflowInvocationId: "compaction-invocation-1",
  });
  assert.equal(first.text, firstResponse);

  const managerAfterFirst = SessionManager.open(first.sessionFile, project.sessionDir);
  assert.equal(managerAfterFirst.getEntries().filter((entry) => entry.type === "compaction").length, 1);
  assert.equal(managerAfterFirst.buildSessionContext().messages[0]?.role, "compactionSummary");

  writeFauxConfiguration(agentDir, faux, { compaction: { enabled: false } });
  const second = await runPiCodingAgentPromptStep({
    projectId: project.projectId,
    chatHome,
    cwd: workspace,
    sessionId: first.sessionId,
    prompt: "continue",
    workflowInvocationId: "compaction-invocation-2",
  });
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.sessionFile, first.sessionFile);
  assert.equal(second.text, "continued after compaction");
  assert.equal(calls.length, 3);
});
