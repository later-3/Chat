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
import { getMemoryStoreManager } from "../../src/memory/manager-runtime.ts";
import { getPromptResourceStore } from "../../src/prompt-resources/store.ts";
import {
  AGENT_CAPABILITY_DESIGN_RULE_ID,
  WORKFLOW_RUNTIME_VALIDATION_EXPERIENCE_ID,
} from "../../src/prompt-resources/builtins.ts";
import { openProject } from "../../src/projects/registry.ts";
import { collectChatToolExecutions } from "../../src/tools/execution-record.ts";
import { runChatDirectStep } from "../../src/workflows/chat-direct/step.ts";
import { inspectWorkflowAgent } from "../../src/workflows/agent-inspection.ts";
import {
  runPlanningExecutionStep,
  runPlanningRevisionStep,
  runPlanningStep,
} from "../../src/workflows/planning-execution/steps.ts";
import { runRuleManagementStep } from "../../src/workflows/rule-management/step.ts";
import { collectChatWorkflowAgentInputs } from "../../src/workflows/workflow-stage.ts";
import { collectChatWorkflowTurnConfigurations } from "../../src/workflows/workflow-configuration.ts";

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
