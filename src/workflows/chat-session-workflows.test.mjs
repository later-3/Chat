import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
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
import { getMemoryStoreManager } from "../memory/manager-runtime.ts";
import { getPromptResourceStore } from "../prompt-resources/store.ts";
import {
  AGENT_CAPABILITY_DESIGN_RULE_ID,
  WORKFLOW_RUNTIME_VALIDATION_EXPERIENCE_ID,
} from "../prompt-resources/builtins.ts";
import { openProject } from "../projects/registry.ts";
import { collectChatToolExecutions } from "../tools/execution-record.ts";
import { runPiCodingAgentPromptStep } from "./minimal-pi-coding-agent/step.ts";
import { PI_CODING_AGENT } from "./minimal-pi-coding-agent/agents/pi-coding-agent/index.ts";
import { inspectWorkflowAgent } from "./agent-inspection.ts";
import {
  runPlanningExecutionStep,
  runPlanningRevisionStep,
  runPlanningStep,
} from "./planning-execution/steps.ts";
import { runRuleManagementStep } from "./rule-management/step.ts";
import { collectChatWorkflowAgentInputs } from "./workflow-stage.ts";
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

const TEST_EMBEDDING_DIMENSION = 64;

function deterministicEmbedding(text) {
  const vector = Array.from({ length: TEST_EMBEDDING_DIMENSION }, () => 0);
  const symbols = Array.from(text.toLowerCase());
  for (let index = 0; index < symbols.length; index += 1) {
    const current = symbols[index]?.codePointAt(0) ?? 0;
    const next = symbols[index + 1]?.codePointAt(0) ?? 0;
    vector[(current * 31 + next * 17 + index) % vector.length] += 1;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function startTestEmbeddingServer(t) {
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/embeddings") {
      response.writeHead(404).end();
      return;
    }
    const body = await readRequestJson(request);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      object: "list",
      model: body.model,
      data: inputs.map((input, index) => ({
        object: "embedding",
        index,
        embedding: deterministicEmbedding(String(input)),
      })),
      usage: { prompt_tokens: 0, total_tokens: 0 },
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  return `http://127.0.0.1:${address.port}/v1`;
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
      return fauxAssistantMessage('<!-- chat-planner-output {"schemaVersion":1,"readiness":"ready_for_review","blockingQuestions":[]} -->\nplan one');
    },
    (context) => {
      recordCall(calls, context);
      return fauxAssistantMessage('<!-- chat-planner-output {"schemaVersion":1,"readiness":"ready_for_review","blockingQuestions":[]} -->\nplan two');
    },
    (context) => {
      recordCall(calls, context);
      return fauxAssistantMessage("executed plan two");
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
  const feedbackManager = SessionManager.open(first.sessionFile, project.sessionDir);
  const feedbackEntryId = feedbackManager.appendMessage({
    role: "user",
    content: "add rollback details",
    timestamp: Date.now(),
  });
  feedbackManager.flush();
  const revised = await runPlanningRevisionStep({
    projectId: project.projectId,
    chatHome,
    cwd: workspace,
    sessionId: planning.sessionId,
    prompt: "planned request",
    workflowInvocationId: "planning-invocation-1",
    planRevision: 2,
    previousPlan: planning.plan,
    feedback: "add rollback details",
    inputEntryIds: [planning.userEntryId, planning.planEntryId, feedbackEntryId],
    agent: planning.plannerAgent,
  });
  const execution = await runPlanningExecutionStep({
    projectId: project.projectId,
    chatHome,
    cwd: workspace,
    sessionId: planning.sessionId,
    workflowInvocationId: "planning-invocation-1",
    prompt: "planned request",
    plan: revised.plan,
    planRevision: 2,
    inputEntryIds: [planning.userEntryId, feedbackEntryId, revised.planEntryId],
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
      schemaVersion: 2,
      invocationId: "direct-invocation-1",
      workflowId: "minimal-pi-coding-agent",
      stageId: "execute",
      nodeKind: "agent",
      agentId: "pi-coding-agent",
    },
    {
      schemaVersion: 2,
      invocationId: "planning-invocation-1",
      workflowId: "planning-execution",
      stageId: "plan",
      nodeKind: "agent",
      agentId: "planner",
    },
    {
      schemaVersion: 2,
      invocationId: "planning-invocation-1",
      workflowId: "planning-execution",
      stageId: "plan",
      nodeKind: "agent",
      agentId: "planner",
    },
    {
      schemaVersion: 2,
      invocationId: "planning-invocation-1",
      workflowId: "planning-execution",
      stageId: "execute",
      nodeKind: "agent",
      agentId: "pi-coding-agent",
    },
    {
      schemaVersion: 2,
      invocationId: "direct-invocation-2",
      workflowId: "minimal-pi-coding-agent",
      stageId: "execute",
      nodeKind: "agent",
      agentId: "pi-coding-agent",
    },
  ]);
  const workflowAgentInputs = collectChatWorkflowAgentInputs(manager.getEntries());
  assert.equal(workflowAgentInputs.length, 3);
  assert.deepEqual(workflowAgentInputs.map(({ entryId: _entryId, ...input }) => input), [
    {
      schemaVersion: 2,
      invocationId: "planning-invocation-1",
      workflowId: "planning-execution",
      stageId: "plan",
      agentId: "planner",
      inputEntryIds: [planning.userEntryId],
    },
    {
      schemaVersion: 2,
      invocationId: "planning-invocation-1",
      workflowId: "planning-execution",
      stageId: "plan",
      agentId: "planner",
      inputEntryIds: [planning.userEntryId, planning.planEntryId, feedbackEntryId],
    },
    {
      schemaVersion: 2,
      invocationId: "planning-invocation-1",
      workflowId: "planning-execution",
      stageId: "execute",
      agentId: "pi-coding-agent",
      inputEntryIds: [planning.userEntryId, feedbackEntryId, revised.planEntryId],
    },
  ]);
  const messages = manager.buildSessionContext().messages;
  assert.deepEqual(
    messages.filter((message) => message.role === "user").map(messageText),
    ["first request", "planned request", "add rollback details", "final request"],
  );
  assert.deepEqual(
    messages.filter((message) => message.role === "assistant").map(messageText),
    [
      "direct one",
      '<!-- chat-planner-output {"schemaVersion":1,"readiness":"ready_for_review","blockingQuestions":[]} -->\nplan one',
      '<!-- chat-planner-output {"schemaVersion":1,"readiness":"ready_for_review","blockingQuestions":[]} -->\nplan two',
      "executed plan two",
      "direct two",
    ],
  );
  assert.equal(messages.filter((message) => message.role === "custom").length, 1);

  assert.equal(calls.length, 5);
  assert.match(calls[1].systemPrompt, /Planner Agent/);
  assert.deepEqual(calls[1].toolNames, ["read", "memory_search"]);
  assert.ok(calls[1].messages.some((message) => message.role === "assistant" && messageText(message) === "direct one"));
  assert.match(JSON.stringify(calls[2].messages), /add rollback details/);
  assert.match(JSON.stringify(calls[2].messages), /plan one/);
  assert.match(calls[3].systemPrompt, /workflow_execution_task_brief/);
  assert.ok(calls[2].messages.some((message) => (
    message.role === "user" && messageText(message).includes("add rollback details")
  )));
  assert.ok(calls[3].messages.some((message) => (
    message.role === "user"
    && messageText(message).includes('"userRequest": "planned request"')
    && messageText(message).includes('"approvedPlan": "plan two"')
    && messageText(message).includes('"approvedPlanRevision": 2')
  )));
  assert.ok(calls[3].messages.some((message) => message.role === "user" && messageText(message) === "planned request"));
  assert.ok(calls[4].messages.some((message) => message.role === "assistant" && messageText(message) === "executed plan two"));
  assert.deepEqual(
    calls[4].messages.filter((message) => message.role === "user").map(messageText),
    ["first request", "planned request", "add rollback details", "final request"],
  );
  assert.equal(
    calls[4].messages.some((message) => message.role === "user" && messageText(message).includes("plan one")),
    false,
  );
  assert.equal(calls[4].messages.some((message) => messageText(message).includes("上一条Planner")), false);
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
    id: "first-planning",
    name: "First Planning",
  });
  writeFauxConfiguration(path.join(chatHome, "agent"), faux);

  const calls = [];
  faux.setResponses([
    (context) => {
      recordCall(calls, context);
      return fauxAssistantMessage('<!-- chat-planner-output {"schemaVersion":1,"readiness":"ready_for_review","blockingQuestions":[]} -->\nfirst plan');
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
    planRevision: 1,
    inputEntryIds: [planning.userEntryId, planning.planEntryId],
    agent: planning.executionAgent,
  });
  const manager = SessionManager.open(execution.sessionFile, sessionDir);

  assert.deepEqual(
    manager.buildSessionContext().messages.map((message) => [message.role, messageText(message)]),
    [
      ["user", "first planned request"],
      ["assistant", '<!-- chat-planner-output {"schemaVersion":1,"readiness":"ready_for_review","blockingQuestions":[]} -->\nfirst plan'],
      ["custom", "<workflow_execution_task_brief>\n{\n  \"schemaVersion\": 1,\n  \"kind\": \"planning_execution_task_brief\",\n  \"task\": {\n    \"userRequest\": \"first planned request\",\n    \"approvedPlanRevision\": 1,\n    \"approvedPlan\": \"first plan\"\n  },\n  \"executionContract\": {\n    \"objective\": \"完成用户真实请求，并交付已批准计划定义的本轮结果。\",\n    \"startRule\": \"计划已完成前置澄清；先执行可推进的工作，不重复向用户收集任务书中已有信息。\",\n    \"discoveryRule\": \"可通过工具验证或调查的事实由Executor主动完成。\",\n    \"authorityRule\": \"只在任务书授权边界内行动；另行授权点必须在动作前停止。\",\n    \"completionReport\": [\n      \"已完成交付物\",\n      \"关键结果\",\n      \"验证证据\",\n      \"剩余风险或阻塞\"\n    ]\n  }\n}\n</workflow_execution_task_brief>"],
      ["assistant", "first execution"],
    ],
  );
  assert.ok(calls[1].messages.some(
    (message) => (
      message.role === "user"
      && messageText(message).includes('"userRequest": "first planned request"')
      && messageText(message).includes('"approvedPlan": "first plan"')
    ),
  ));
});

test("Planner executes memory_search through Pi before producing a context-dependent plan", { concurrency: false }, async (t) => {
  const previousCwd = process.cwd();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-planner-memory-search-"));
  const faux = registerFauxProvider({ api: "chat-planner-memory-faux", provider: "chat-planner-memory-faux" });
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace);
  const chatHome = path.join(base, "chat-home");
  const project = await openProject({
    path: workspace,
    chatHome,
    id: "planner-memory",
    name: "Planner Memory",
  });
  const previousMemoryEnvironment = {
    provider: process.env.CHAT_MEMORY_EMBEDDER_PROVIDER,
    baseUrl: process.env.CHAT_MEMORY_EMBEDDER_BASE_URL,
    apiKey: process.env.CHAT_MEMORY_EMBEDDER_API_KEY,
    model: process.env.CHAT_MEMORY_EMBEDDING_MODEL,
    dimension: process.env.CHAT_MEMORY_EMBEDDING_DIMENSION,
  };
  process.env.CHAT_MEMORY_EMBEDDER_PROVIDER = "openai";
  process.env.CHAT_MEMORY_EMBEDDER_BASE_URL = await startTestEmbeddingServer(t);
  process.env.CHAT_MEMORY_EMBEDDER_API_KEY = "planner-memory-test";
  process.env.CHAT_MEMORY_EMBEDDING_MODEL = "deterministic-test-embedding";
  process.env.CHAT_MEMORY_EMBEDDING_DIMENSION = String(TEST_EMBEDDING_DIMENSION);
  const memoryManager = getMemoryStoreManager(chatHome);
  t.after(async () => {
    await memoryManager.close();
    for (const [name, value] of Object.entries({
      CHAT_MEMORY_EMBEDDER_PROVIDER: previousMemoryEnvironment.provider,
      CHAT_MEMORY_EMBEDDER_BASE_URL: previousMemoryEnvironment.baseUrl,
      CHAT_MEMORY_EMBEDDER_API_KEY: previousMemoryEnvironment.apiKey,
      CHAT_MEMORY_EMBEDDING_MODEL: previousMemoryEnvironment.model,
      CHAT_MEMORY_EMBEDDING_DIMENSION: previousMemoryEnvironment.dimension,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    faux.unregister();
    process.chdir(previousCwd);
    fs.rmSync(base, { recursive: true, force: true });
  });
  process.chdir(base);
  writeFauxConfiguration(path.join(chatHome, "agent"), faux);

  const writes = await memoryManager.createMany([{ type: "personal" }], {
    text: "用户生活在成都。",
    kind: "fact",
    source: { projectId: project.projectId, sessionId: "memory-source-session" },
  });
  assert.equal(writes[0].error, undefined);
  assert.match(writes[0].memory?.text ?? "", /成都/);

  const calls = [];
  faux.setResponses([
    (context) => {
      recordCall(calls, context);
      return fauxAssistantMessage([
        fauxText("I need the user's stable location before planning."),
        fauxToolCall("memory_search", { query: "用户所在地 成都 周边徒步" }, { id: "planner-memory-search-1" }),
      ], { stopReason: "toolUse" });
    },
    (context) => {
      recordCall(calls, context);
      assert.match(JSON.stringify(context.messages), /用户生活在成都/);
      return fauxAssistantMessage(
        '<!-- chat-planner-output {"schemaVersion":1,"readiness":"ready_for_review","blockingQuestions":[]} -->\n# 执行计划\n以成都为出发地调查周边花期和路线。',
      );
    },
  ]);

  const planning = await runPlanningStep({
    projectId: project.projectId,
    chatHome,
    cwd: workspace,
    prompt: "帮我规划周边看花和轻徒步",
    workflowInvocationId: "planner-memory-invocation",
  });

  assert.match(planning.plan, /成都/);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].toolNames, ["read", "memory_search"]);
  const sessionFile = fs.readdirSync(project.sessionDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => path.join(project.sessionDir, name))[0];
  assert.ok(sessionFile);
  const sessionManager = SessionManager.open(sessionFile, project.sessionDir);
  assert.ok(sessionManager.getEntries().some((entry) => (
    entry.type === "message"
    && entry.message.role === "toolResult"
    && entry.message.toolName === "memory_search"
    && messageText(entry.message).includes("用户生活在成都")
  )));
  assert.deepEqual(
    collectChatToolExecutions(sessionManager.getEntries()).map((execution) => ({
      toolName: execution.toolName,
      toolAddress: execution.toolAddress,
      toolVersion: execution.toolVersion,
      status: execution.status,
      agentId: execution.agentId,
    })),
    [{
      toolName: "memory_search",
      toolAddress: "system:tool/memory_search",
      toolVersion: "system:memory-search@2",
      status: "completed",
      agentId: "planner",
    }],
  );
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
  const experience = await promptResourceStore.get(WORKFLOW_RUNTIME_VALIDATION_EXPERIENCE_ID);
  assert.ok(experience);
  const agentDesignRule = await promptResourceStore.get(AGENT_CAPABILITY_DESIGN_RULE_ID);
  assert.ok(agentDesignRule);

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
        promptResources: [
          { id: rule.id, target: { type: "personal" }, selectedBy: "user" },
          {
            id: WORKFLOW_RUNTIME_VALIDATION_EXPERIENCE_ID,
            target: { type: "personal" },
            selectedBy: "user",
          },
          {
            id: AGENT_CAPABILITY_DESIGN_RULE_ID,
            target: { type: "personal" },
            selectedBy: "user",
          },
        ],
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
  assert.match(calls[0].systemPrompt, /Node\.js 22\.19\.0/);
  assert.match(calls[0].systemPrompt, /能力完备性与Pi装配一致性/);
  assert.match(calls[0].systemPrompt, /Configured review/);
  assert.deepEqual(calls[0].toolNames, ["read"]);
  const manager = SessionManager.open(result.sessionFile, project.sessionDir);
  const snapshot = collectChatWorkflowTurnConfigurations(manager.getEntries())[0];
  assert.deepEqual(
    snapshot.agentConfigs["pi-coding-agent"].promptResources.map((resource) => resource.revision),
    [rule.revision, experience.revision, agentDesignRule.revision],
  );
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
  fs.writeFileSync(path.join(base, "AGENTS.md"), "Parent instructions must stay outside the Project.");
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "Project-only instructions.");
  fs.mkdirSync(path.join(chatHome, "agent"), { recursive: true });
  fs.writeFileSync(path.join(chatHome, "agent", "AGENTS.md"), "Global Chat instructions.");
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
    "---",
    "name: review",
    "description: Review code",
    "---",
    "Review the changed code carefully.",
  ].join("\n"));
  writeFauxConfiguration(path.join(chatHome, "agent"), faux);
  const project = await openProject({
    path: workspace,
    chatHome,
    id: "agent-inspection",
    name: "Agent Inspection",
  });

  const inspection = await inspectWorkflowAgent({
    projectId: project.projectId,
    chatHome,
    cwd: workspace,
    defaultAgent: PI_CODING_AGENT,
    workflowId: "minimal-pi-coding-agent",
    agentId: PI_CODING_AGENT.id,
    stageId: "execute",
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
  assert.deepEqual(inspection.skills.map((skill) => skill.name), ["review"]);
  assert.match(reviewSkill.content, /Review the changed code carefully/);
  assert.match(inspection.prompt.final, /Review code/);
  assert.match(inspection.prompt.final, /Global Chat instructions/);
  assert.match(inspection.prompt.final, /Project-only instructions/);
  assert.doesNotMatch(inspection.prompt.final, /Parent instructions/);
  assert.deepEqual(inspection.prompt.contextFiles.map((file) => file.path), [
    path.join(fs.realpathSync(chatHome), "agent", "AGENTS.md"),
    path.join(fs.realpathSync(workspace), "AGENTS.md"),
  ]);
  assert.ok(inspection.tools.some((tool) => tool.name === "read" && tool.active));
  assert.ok(inspection.tools.some((tool) => tool.name === "workflow_call" && tool.active));
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
