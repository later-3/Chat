import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ensureAgentHomeProject } from "../../src/projects/registry.ts";
import { readSessionMemory } from "../../src/long-agents/session-memory.ts";
import { sessionMemoryWorkflowDefinition } from "../../src/workflows/session-memory/index.ts";
import { ensureChatSessionWithId } from "../../src/chat-session.ts";
import { SESSION_MEMORY_WRITER_AGENT } from "../../src/workflows/session-memory/agents/writer/index.ts";

function writeFauxConfiguration(agentDir, faux) {
  const model = faux.getModel();
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: model.provider, defaultModel: model.id, defaultThinkingLevel: "off", compaction: { enabled: false },
  }));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: { [model.provider]: { baseUrl: model.baseUrl, api: model.api, apiKey: "faux-key",
      models: [{ id: model.id, name: model.name, reasoning: model.reasoning, input: model.input, cost: model.cost,
        contextWindow: model.contextWindow, maxTokens: model.maxTokens }] } },
  }));
}

function textOf(message) {
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
}

/**
 * Registers the Workflow-call dispatch runtime at the same boundary the production bootstrap uses
 * (src/runtime-initialization.ts). The child Workflow itself runs inside the Workflow SDK runtime, which
 * is not available in a plain unit-test process, so this stub records the call the worker actually made
 * and returns a real child result through that boundary.
 */
const childCalls = [];
async function registerWorkflowCallRuntime() {
  const { registerChatWorkflowCallRuntime } = await import("../../src/workflows/workflow-call-runtime.ts");
  registerChatWorkflowCallRuntime({
    describe: async (input) => {
      throw new Error(`describe 在本测试中未使用: ${JSON.stringify(input)}`);
    },
    start: async (input) => {
      childCalls.push(input);
      const startedAt = new Date().toISOString();
      return {
        status: "completed", callId: "call-child-1", workflowId: input.targetWorkflowId, runId: "run-child-1",
        workflowInvocationId: "invocation-child-1", sessionId: "sess-child-1", startedAt, completedAt: startedAt,
        durationMs: 3, text: "子工作流结果：第 42 行确实为空指针", model: null,
      };
    },
    wait: async () => { throw new Error("wait 在本测试中未使用"); },
    cancel: async () => { throw new Error("cancel 在本测试中未使用"); },
  });
}

async function fixture(t, prefix) {
  const previousCwd = process.cwd();
  const previousChatHome = process.env.CHAT_HOME;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const faux = registerFauxProvider({ api: `${prefix}-faux`, provider: `${prefix}-faux` });
  t.after(() => {
    faux.unregister();
    process.chdir(previousCwd);
    if (previousChatHome === undefined) delete process.env.CHAT_HOME;
    else process.env.CHAT_HOME = previousChatHome;
    fs.rmSync(base, { recursive: true, force: true });
  });
  process.chdir(base);
  process.env.CHAT_HOME = path.join(base, ".chat");
  writeFauxConfiguration(path.join(base, ".chat", "agent"), faux);
  // Session memory only exists inside a Long Agent home, so the node session must live there.
  await registerWorkflowCallRuntime();
  const project = await ensureAgentHomeProject("friend", "Friend", process.env.CHAT_HOME);
  return { base, faux, workspace: project.cwd, project };
}

const run = (input) => sessionMemoryWorkflowDefinition.run(input);

test("session-memory workflow: work then remember with the current-round projection", { concurrency: false }, async (t) => {
  const { faux, workspace, project } = await fixture(t, "chat-smem-workflow");
  const writerInputs = [];
  const workerTools = [];
  const workerWorkflowCalls = [];
  faux.setResponses([
    // The worker does ordinary work AND actually calls a business Workflow once (P2: work may delegate).
    (context) => {
      workerTools.push((context.tools ?? []).map((tool) => tool.name));
      return fauxAssistantMessage(fauxToolCall("workflow_call", {
        action: "start",
        workflowId: "minimal-pi-coding-agent",
        prompt: "目标：确认第 42 行的空指针来源。上下文：节点会话已定位到该行。约束：只读检查，不修改文件。期望输出：一句话结论与证据。授权边界：只读。",
        agents: [{ agentId: "pi-coding-agent", tools: ["read"], skills: [] }],
        waitTimeoutMs: 20_000,
      }));
    },
    (context) => {
      const result = context.messages.filter((message) => message.role === "toolResult").map(textOf).join("\n");
      workerWorkflowCalls.push(result);
      const raw = result.slice(result.indexOf("{"));
      const child = raw.startsWith("{") ? JSON.parse(raw) : {};
      // The worker answers with what the delegation boundary reported, which is the child's terminal
      // status; the child's own text is visible to the model only through the tool result.
      return fauxAssistantMessage(`work 阶段：子工作流${result.includes("completed") ? "已完成" : "未完成"}：${String(child.text ?? result)}`.slice(0, 200));
    },
    (context) => {
      writerInputs.push(context.messages.map((message) => `${message.role}:${textOf(message)}`).join("\n---\n"));
      return fauxAssistantMessage(fauxToolCall("session_memory", { operation: "write", purpose: "finding", author: "agent", content: "空指针根因在第 42 行", expectedRevision: 0 }));
    },
    // The writer cites the entry the tool ACTUALLY returned, parsed from its own tool result.
    (context) => {
      const toolResult = context.messages.filter((message) => message.role === "toolResult").map(textOf).join("\n");
      const entryId = /"entryId":"([^"]+)"/.exec(toolResult)?.[1] ?? "missing";
      const revision = /"revision":(\d+)/.exec(toolResult)?.[1] ?? "missing";
      return fauxAssistantMessage(`已写入 entryId=${entryId} revision=${revision}`);
    },
    // The child business Workflow (minimal-pi-coding-agent) executes its own turn.
    fauxAssistantMessage("子工作流结果：第 42 行确实为空指针"),
    fauxAssistantMessage("子工作流结果：第 42 行确实为空指针"),
  ]);
  const result = await run({
    projectId: project.projectId, chatHome: process.env.CHAT_HOME, cwd: workspace,
    sessionId: undefined, prompt: "为什么这里空指针？", workflowInvocationId: "smem-invocation-1",
  });
  assert.equal(typeof result.text, "string");
  assert.notEqual(result.text, "");
  assert.equal(workerTools[0].includes("session_memory"), true, "the worker is offered the memory tool for on-demand reads");
  // Normal work capability: Pi's ordinary tools plus business Workflow delegation.
  assert.equal(workerTools[0].includes("workflow_call"), true, "the worker may call a business Workflow");
  assert.equal(workerTools[0].some((name) => ["read", "bash", "write", "edit"].includes(name)), true,
    "the worker keeps ordinary work tools instead of only the memory tool");
  assert.equal(workerWorkflowCalls.length, 1, "the worker actually delegated to a business Workflow");
  assert.equal(childCalls.length, 1, "exactly one child Workflow call reached the dispatch runtime");
  assert.equal(childCalls[0].prompt.length > 0, true, "the delegation carries an objective, context, constraints and expected output");
  assert.equal(Array.isArray(childCalls[0].agents) && childCalls[0].agents.length > 0, true, "the delegation selects the child Agent capabilities");
  assert.equal(workerWorkflowCalls[0].includes("completed"), true,
    `the worker saw the child Workflow's terminal status (tool result: ${workerWorkflowCalls[0].slice(0, 120)})`);
  assert.equal(childCalls[0].targetWorkflowId, "minimal-pi-coding-agent", "the delegated target is the requested business Workflow");
  assert.equal(childCalls[0].parentWorkflowId, "session-memory", "the delegation records the session-memory parent");
  assert.equal(childCalls[0].parentStageId, "work", "the delegation is attributed to the work stage");
  // The round's answer is the work answer, NOT the memory bookkeeping text.
  assert.equal(result.text.includes("子工作流已完成"), true, "the work answer reflects the child's terminal status");
  assert.equal(result.text.includes("已写入 entryId"), false, "the memory report is not returned as the round's answer");
  const memory = await readSessionMemory(process.env.CHAT_HOME, "friend", result.sessionId);
  assert.equal(memory.entries.length, 1, "the writer wrote exactly one entry");
  assert.equal(memory.entries[0].content, "空指针根因在第 42 行");
  assert.equal(writerInputs.length, 1);
  assert.equal(writerInputs[0].includes("为什么这里空指针？"), true, "the writer sees the round's user message");
  assert.equal(writerInputs[0].includes("子工作流已完成"), true, "the writer sees the whole work stage, including the delegation outcome");
  // The writer's visible reply cites the entry id the tool actually returned (not a scripted value).
  const branch = (await ensureChatSessionWithId({ chatHome: process.env.CHAT_HOME, projectId: project.projectId },
    result.sessionId)).session.manager.getBranch();
  const lastAssistant = [...branch].reverse().find((entry) => entry.type === "message" && entry.message?.role === "assistant");
  const cited = textOf(lastAssistant.message);
  assert.equal(cited.includes(memory.entries[0].entryId), true, "the writer's reply cites the real entry id from the tool result");
  assert.equal(cited.includes("revision=1"), true, "the writer's reply cites the real revision");
});

test("session-memory workflow: an earlier round never leaks into the writer", { concurrency: false }, async (t) => {
  const { faux, workspace, project } = await fixture(t, "chat-smem-rounds");
  const writerInputs = [];
  faux.setResponses([
    fauxAssistantMessage("第二轮回答：已经修好第二处"),
    (context) => { writerInputs.push(context.messages.map(textOf).join("\n")); return fauxAssistantMessage("本轮无需写入"); },
    fauxAssistantMessage("本轮无需写入"),
  ]);
  // Seed an EARLIER round directly in the Session (its own user + assistant entries).
  const { ensureChatSessionWithId } = await import("../../src/chat-session.ts");
  const { appendChatUserMessage } = await import("../../src/workflows/session-conversation.ts");
  const seeded = await ensureChatSessionWithId({ chatHome: process.env.CHAT_HOME, projectId: project.projectId },
    "sess-seeded-round", "旧轮次");
  appendChatUserMessage(seeded.session.manager, "第一轮问题");
  seeded.session.manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "第一轮回答：空指针在第一处" }], timestamp: Date.now() });
  seeded.session.manager.flush();

  const result = await run({ projectId: project.projectId, chatHome: process.env.CHAT_HOME, cwd: workspace,
    sessionId: "sess-seeded-round", prompt: "第二轮问题", workflowInvocationId: "smem-round-2" });
  assert.equal(result.sessionId, "sess-seeded-round");
  assert.equal(writerInputs.length, 1);
  assert.equal(writerInputs[0].includes("第二轮问题"), true, "the writer sees the current round's user message");
  assert.equal(writerInputs[0].includes("第二轮回答：已经修好第二处"), true, "the writer sees the current work stage");
  assert.equal(writerInputs[0].includes("第一轮问题"), false, "the earlier round is NOT injected into the writer");
  assert.equal(writerInputs[0].includes("第一轮回答"), false);
  assert.equal((await readSessionMemory(process.env.CHAT_HOME, "friend", result.sessionId)).entries.length, 0,
    "a round the writer judged not worth recording stays empty");
});

test("session-memory workflow: the remember stage refuses a round without a user entry", { concurrency: false }, async (t) => {
  const { faux, workspace, project } = await fixture(t, "chat-smem-refuse");
  const template = () => fauxAssistantMessage(fauxToolCall("session_memory", { operation: "write", purpose: "finding", author: "agent", content: "不该存在的条目", expectedRevision: 0 }));
  faux.setResponses([template, template, template]);
  const { runSessionMemoryRememberStep } = await import("../../src/workflows/session-memory/step.ts");
  const { SessionMemoryRoundUnavailableError } = await import("../../src/workflows/session-memory/agents/writer/runtime.ts");
  // A REAL Session that has no user entry at all: the remember stage must fail visibly, not record history.
  await ensureChatSessionWithId({ chatHome: process.env.CHAT_HOME, projectId: project.projectId }, "sess-no-round", "空会话");
  await assert.rejects(
    runSessionMemoryRememberStep({ projectId: project.projectId, chatHome: process.env.CHAT_HOME, cwd: workspace,
      sessionId: "sess-no-round", prompt: "无用户条目", workflowInvocationId: "smem-refuse-1" }),
    (error) => error instanceof Error && (error.message.includes("没有返回Assistant文本")
      || error.message.includes(SessionMemoryRoundUnavailableError.name)
      || error.message.includes("本轮用户消息")),
  );
  const { listChatSessions } = await import("../../src/session-read-model.ts");
  for (const session of await listChatSessions(project.projectId, process.env.CHAT_HOME)) {
    assert.equal((await readSessionMemory(process.env.CHAT_HOME, "friend", session.sessionId)).entries.length, 0,
      "a refused round wrote no memory");
  }
});

test("session-memory workflow: with the switch off the round is ordinary work and writes no memory", { concurrency: false }, async (t) => {
  const { faux, workspace, project } = await fixture(t, "chat-smem-switch");
  const workerTools = [];
  faux.setResponses([
    (context) => { workerTools.push((context.tools ?? []).map((tool) => tool.name)); return fauxAssistantMessage("普通一轮：没有记忆也能干活"); },
  ]);
  const result = await run({
    projectId: project.projectId, chatHome: process.env.CHAT_HOME, cwd: workspace,
    sessionId: undefined, prompt: "关掉记忆的这一轮", workflowInvocationId: "smem-off-1", sessionMemoryEnabled: false,
  });
  assert.equal(result.text, "普通一轮：没有记忆也能干活", "the round still does the work");
  assert.equal(workerTools[0].includes("session_memory"), false, "the memory tool is not assembled when the switch is off");
  assert.equal((await readSessionMemory(process.env.CHAT_HOME, "friend", result.sessionId)).entries.length, 0, "no memory is written");
  // No writer stage ran: the Session has no remember-stage marker.
  const session = await ensureChatSessionWithId({ chatHome: process.env.CHAT_HOME, projectId: project.projectId }, result.sessionId);
  const stages = session.session.manager.getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === "chat.workflow_stage")
    .map((entry) => entry.data?.stageId);
  assert.deepEqual(stages, ["work"], "only the work stage ran");
});
