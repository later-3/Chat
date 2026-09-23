import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ensureAgentHomeProject, resolveProjectContext } from "../../src/projects/registry.ts";
import { reserveChatSession } from "../../src/chat-session.ts";
import { readSessionMemory } from "../../src/long-agents/session-memory.ts";
import { runMemoryAgentStep } from "../../src/workflows/memory/step.ts";
import { MEMORY_AGENT } from "../../src/workflows/memory/agents/memory-agent/index.ts";

function writeFauxConfiguration(agentDir, faux) {
  const model = faux.getModel();
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: model.provider, defaultModel: model.id, defaultThinkingLevel: "off", compaction: { enabled: false },
  }));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: {
    [model.provider]: { baseUrl: model.baseUrl, api: model.api, apiKey: "faux-key", models: [{
      id: model.id, name: model.name, reasoning: model.reasoning, input: model.input,
      cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
    }] },
  } }));
}

/**
 * Runtime evidence for the session-memory dispatch chain: a workflow agent runs in the workflow's own
 * Session, but a `session_memory` write must land in the dispatching (origin) session it was told to
 * target — never in the session it happens to be executing in.
 */
test("the workflow agent writes session memory to the dispatching session, not its own", { concurrency: false }, async (t) => {
  const previousCwd = process.cwd();
  const previousChatHome = process.env.CHAT_HOME;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-workflow-smem-runtime-"));
  const faux = registerFauxProvider({ api: "chat-smem-faux", provider: "chat-smem-faux" });
  t.after(() => {
    process.chdir(previousCwd);
    if (previousChatHome === undefined) delete process.env.CHAT_HOME; else process.env.CHAT_HOME = previousChatHome;
    faux.unregister();
    fs.rmSync(base, { recursive: true, force: true });
  });
  process.chdir(base);
  const chatHome = path.join(base, ".chat");
  process.env.CHAT_HOME = chatHome;
  writeFauxConfiguration(path.join(chatHome, "agent"), faux);
  await ensureAgentHomeProject("friend", "Friend", chatHome);
  // The agent-home project owns its cwd; the workflow run must execute there.
  const workspace = (await resolveProjectContext("friend", chatHome)).cwd;

  const origin = await reserveChatSession({ projectId: "friend", chatHome }, "origin");
  const originSessionId = origin.manager.getSessionId();
  const child = await reserveChatSession({ projectId: "friend", chatHome }, "child");
  const childSessionId = child.manager.getSessionId();
  assert.notEqual(originSessionId, childSessionId);

  const seenTools = [];
  faux.setResponses([
    (context) => {
      seenTools.push((context.tools ?? []).map((tool) => tool.name));
      return fauxAssistantMessage(fauxToolCall("session_memory", { operation: "write", purpose: "finding", author: "agent", content: "workflow 写入的结论", expectedRevision: 0 }));
    },
    fauxAssistantMessage("已记录"),
  ]);

  await runMemoryAgentStep({
    projectId: "friend",
    chatHome,
    cwd: workspace,
    sessionId: childSessionId,
    prompt: "整理本会话记忆",
    workflowInvocationId: "invocation-smem-1",
    // The dispatching session is the origin; the agent executes in the child session.
    sessionMemoryTarget: { storageProjectId: "friend", sessionId: originSessionId },
    agentConfigs: { [MEMORY_AGENT.id]: { tools: { mode: "explicit", names: [], exclude: [], addresses: ["system:tool/session_memory"] } } },
  });

  assert.deepEqual(seenTools[0], ["session_memory"], "the workflow agent was actually offered the tool");
  const originMemory = await readSessionMemory(chatHome, "friend", originSessionId);
  assert.equal(originMemory.entries.length, 1, "the dispatching session received the entry");
  assert.equal(originMemory.entries[0].content, "workflow 写入的结论");
  const childMemory = await readSessionMemory(chatHome, "friend", childSessionId);
  assert.equal(childMemory.entries.length, 0, "the workflow's own session received nothing");
});

/**
 * The shared planning entry (initial planning and post-review replanning) must forward the target too:
 * it is reached before the durable binding is written, so a missing pass-through would send the
 * planner's memory write to the workflow's own session.
 */
test("the shared planning entry forwards the dispatching session to the planner agent", { concurrency: false }, async (t) => {
  const previousCwd = process.cwd();
  const previousChatHome = process.env.CHAT_HOME;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-workflow-smem-plan-"));
  const faux = registerFauxProvider({ api: "chat-smem-plan-faux", provider: "chat-smem-plan-faux" });
  t.after(() => {
    process.chdir(previousCwd);
    if (previousChatHome === undefined) delete process.env.CHAT_HOME; else process.env.CHAT_HOME = previousChatHome;
    faux.unregister();
    fs.rmSync(base, { recursive: true, force: true });
  });
  process.chdir(base);
  const chatHome = path.join(base, ".chat");
  process.env.CHAT_HOME = chatHome;
  writeFauxConfiguration(path.join(chatHome, "agent"), faux);
  await ensureAgentHomeProject("friend", "Friend", chatHome);
  const workspace = (await resolveProjectContext("friend", chatHome)).cwd;

  const origin = await reserveChatSession({ projectId: "friend", chatHome }, "origin");
  const originSessionId = origin.manager.getSessionId();
  const child = await reserveChatSession({ projectId: "friend", chatHome }, "child");
  const childSessionId = child.manager.getSessionId();

  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("session_memory", { operation: "write", purpose: "goal", author: "agent", content: "规划入口写入的目标", expectedRevision: 0 })),
    fauxAssistantMessage('<!-- chat-planner-output {"schemaVersion":1,"readiness":"ready_for_review","blockingQuestions":[]} -->\n\n# 计划\n1. 第一步'),
  ]);

  const { runReviewedPlanningStep } = await import("../../src/workflows/planning-execution/reviewed-planning-runtime.ts");
  const { PLANNER_AGENT } = await import("../../src/workflows/planning-execution/agents/planner/index.ts");
  await runReviewedPlanningStep({
    projectId: "friend",
    chatHome,
    cwd: workspace,
    sessionId: childSessionId,
    prompt: "制定计划",
    workflowInvocationId: "invocation-plan-smem-1",
    sessionMemoryTarget: { storageProjectId: "friend", sessionId: originSessionId },
    agentConfigs: { [PLANNER_AGENT.id]: { tools: { mode: "explicit", names: [], exclude: [], addresses: ["system:tool/session_memory"] } } },
  }, { workflowId: "planning-execution", agents: [PLANNER_AGENT], plannerAgent: PLANNER_AGENT });

  const originMemory = await readSessionMemory(chatHome, "friend", originSessionId);
  assert.equal(originMemory.entries.length, 1, "the planner wrote to the dispatching session");
  assert.equal(originMemory.entries[0].content, "规划入口写入的目标");
  assert.equal((await readSessionMemory(chatHome, "friend", childSessionId)).entries.length, 0, "the workflow's own session received nothing");
});
