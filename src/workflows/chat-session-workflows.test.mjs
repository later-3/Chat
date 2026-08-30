import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  fauxAssistantMessage,
  registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { runPiCodingAgentPromptStep } from "./minimal-pi-coding-agent/step.ts";
import { PI_CODING_AGENT } from "./minimal-pi-coding-agent/agents/pi-coding-agent/index.ts";
import { inspectWorkflowAgent } from "./agent-inspection.ts";
import {
  runPlanningExecutionStep,
  runPlanningStep,
} from "./planning-execution/steps.ts";
import {
  collectChatWorkflowAgentInputs,
  collectChatWorkflowMessages,
} from "./workflow-stage.ts";

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
  writeFauxConfiguration(path.join(base, ".chat", "agent"), faux);

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
    cwd: workspace,
    prompt: "first request",
    workflowInvocationId: "direct-invocation-1",
  });
  const planning = await runPlanningStep({
    cwd: workspace,
    sessionId: first.sessionId,
    prompt: "planned request",
    workflowInvocationId: "planning-invocation-1",
  });
  const execution = await runPlanningExecutionStep({
    cwd: workspace,
    sessionId: planning.sessionId,
    workflowInvocationId: "planning-invocation-1",
    prompt: "planned request",
    plan: planning.plan,
  });
  const last = await runPiCodingAgentPromptStep({
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
  assert.equal(fs.readdirSync(path.join(base, ".chat", "sessions")).length, 1);

  const manager = SessionManager.open(first.sessionFile, path.join(base, ".chat", "sessions"));
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
  writeFauxConfiguration(path.join(base, ".chat", "agent"), faux);

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
    cwd: workspace,
    prompt: "first planned request",
    workflowInvocationId: "first-planning-invocation",
  });
  const sessionDir = path.join(base, ".chat", "sessions");
  assert.equal(fs.readdirSync(sessionDir).length, 1);

  const execution = await runPlanningExecutionStep({
    cwd: workspace,
    sessionId: planning.sessionId,
    workflowInvocationId: "first-planning-invocation",
    prompt: "first planned request",
    plan: planning.plan,
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
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-agent-config-workflow-"));
  const faux = registerFauxProvider({ api: "chat-agent-config-faux", provider: "chat-agent-config-faux" });
  t.after(() => {
    faux.unregister();
    process.chdir(previousCwd);
    fs.rmSync(base, { recursive: true, force: true });
  });
  process.chdir(base);
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace);
  writeFauxConfiguration(path.join(base, ".chat", "agent"), faux);
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

  const calls = [];
  faux.setResponses([(context) => {
    recordCall(calls, context);
    return fauxAssistantMessage("configured response");
  }]);
  const result = await runPiCodingAgentPromptStep({
    cwd: workspace,
    prompt: "configured request",
    workflowInvocationId: "configured-invocation",
    agentConfigs: {
      "pi-coding-agent": { primary: configPath },
    },
  });

  assert.equal(result.text, "configured response");
  assert.equal(result.model?.provider, model.provider);
  assert.equal(result.model?.modelId, model.id);
  assert.match(calls[0].systemPrompt, /Configured system prompt/);
  assert.match(calls[0].systemPrompt, /<chat_agent_custom_instructions>/);
  assert.match(calls[0].systemPrompt, /Configured additional rule/);
  assert.match(calls[0].systemPrompt, /Configured review/);
  assert.deepEqual(calls[0].toolNames, ["read"]);
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
  writeFauxConfiguration(path.join(base, ".chat", "agent"), faux);

  const inspection = await inspectWorkflowAgent({
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
  assert.equal(inspection.skills.length, 1);
  assert.equal(inspection.skills[0].name, "review");
  assert.match(inspection.skills[0].content, /Review the changed code carefully/);
  assert.match(inspection.prompt.final, /Review code/);
  assert.ok(inspection.tools.some((tool) => tool.name === "read" && tool.active));
  assert.deepEqual(inspection.extensions, []);
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
  const agentDir = path.join(base, ".chat", "agent");
  fs.mkdirSync(workspace);
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
    cwd: workspace,
    prompt: "long request ".repeat(40),
    workflowInvocationId: "compaction-invocation-1",
  });
  assert.equal(first.text, firstResponse);

  const managerAfterFirst = SessionManager.open(first.sessionFile, path.join(base, ".chat", "sessions"));
  assert.equal(managerAfterFirst.getEntries().filter((entry) => entry.type === "compaction").length, 1);
  assert.equal(managerAfterFirst.buildSessionContext().messages[0]?.role, "compactionSummary");

  writeFauxConfiguration(agentDir, faux, { compaction: { enabled: false } });
  const second = await runPiCodingAgentPromptStep({
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
