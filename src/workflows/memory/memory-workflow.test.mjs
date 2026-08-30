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
import { inspectWorkflowAgent } from "../agent-inspection.ts";
import { collectChatWorkflowStageMarkers } from "../workflow-stage.ts";
import { memoryWorkflowDefinition } from "./index.ts";
import { MEMORY_AGENT } from "./agents/memory-agent/index.ts";
import { runMemoryAgentStep } from "./step.ts";
import { MEMORY_TOOL_NAMES } from "./agents/memory-agent/tools/index.ts";

function writeFauxConfiguration(agentDir, faux) {
  const model = faux.getModel();
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: model.provider,
    defaultModel: model.id,
    defaultThinkingLevel: "off",
    compaction: { enabled: false },
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

function messageText(message) {
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
}

test("Memory Workflow uses Pi Skill expansion and only custom Memory tools", { concurrency: false }, async (t) => {
  const previousCwd = process.cwd();
  const previousChatHome = process.env.CHAT_HOME;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-memory-workflow-"));
  const faux = registerFauxProvider({ api: "chat-memory-faux", provider: "chat-memory-faux" });
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

  const calls = [];
  faux.setResponses([(context) => {
    calls.push({
      systemPrompt: context.systemPrompt,
      messages: structuredClone(context.messages),
      toolNames: (context.tools ?? []).map((tool) => tool.name),
    });
    return fauxAssistantMessage("没有找到匹配的长期记忆。");
  }]);

  const result = await runMemoryAgentStep({
    cwd: workspace,
    prompt: "查找我的架构偏好",
    workflowInvocationId: "memory-invocation-1",
  });
  assert.equal(result.text, "没有找到匹配的长期记忆。");
  assert.deepEqual(calls[0].toolNames, MEMORY_TOOL_NAMES);
  assert.match(calls[0].systemPrompt, /Memory Agent/);
  const userText = calls[0].messages
    .filter((message) => message.role === "user")
    .map(messageText)
    .join("\n");
  assert.match(userText, /<skill name="memory"/);
  assert.match(userText, /查找我的架构偏好/);

  const skillPath = path.join(base, ".chat", "runtime", "skills", "memory", "SKILL.md");
  assert.equal(fs.existsSync(skillPath), true);
  const manager = SessionManager.open(result.sessionFile, path.join(base, ".chat", "sessions"));
  assert.deepEqual(collectChatWorkflowStageMarkers(manager.getEntries()).map((stage) => ({
    workflowId: stage.workflowId,
    stageId: stage.stageId,
    agentId: stage.agentId,
  })), [{ workflowId: "memory", stageId: "manage", agentId: "memory-agent" }]);
});

test("Memory Agent inspection uses the same custom tools and Skill as execution", { concurrency: false }, async (t) => {
  const previousCwd = process.cwd();
  const previousChatHome = process.env.CHAT_HOME;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-memory-inspection-"));
  const faux = registerFauxProvider({ api: "chat-memory-inspection-faux", provider: "chat-memory-inspection-faux" });
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

  const inspection = await inspectWorkflowAgent({
    cwd: workspace,
    workflowId: memoryWorkflowDefinition.id,
    agentId: MEMORY_AGENT.id,
    defaultAgent: MEMORY_AGENT,
    prepareAgentSession: memoryWorkflowDefinition.prepareAgentSession,
  });

  assert.deepEqual(
    inspection.tools.filter((tool) => tool.active).map((tool) => tool.name),
    MEMORY_TOOL_NAMES,
  );
  assert.deepEqual(inspection.skills.map((skill) => skill.name).sort(), ["chat-architecture", "memory"]);
  assert.match(inspection.skills.find((skill) => skill.name === "memory")?.content, /The Chat catalog is the source of truth/);
});
