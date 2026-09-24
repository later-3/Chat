import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ensureAgentHomeProject } from "../../src/projects/registry.ts";
import { readSessionMemory } from "../../src/long-agents/session-memory.ts";
import { sessionMemoryWorkflowDefinition } from "../../src/workflows/session-memory/index.ts";
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
  const project = await ensureAgentHomeProject("friend", "Friend", process.env.CHAT_HOME);
  return { base, faux, workspace: project.cwd, project };
}

const run = (input) => sessionMemoryWorkflowDefinition.run(input);

test("session-memory workflow: work then remember with the current-round projection", { concurrency: false }, async (t) => {
  const { faux, workspace, project } = await fixture(t, "chat-smem-workflow");
  const writerInputs = [];
  const workerTools = [];
  faux.setResponses([
    (context) => { workerTools.push((context.tools ?? []).map((tool) => tool.name)); return fauxAssistantMessage("work 阶段：已定位到空指针在第 42 行"); },
    (context) => {
      writerInputs.push(context.messages.map((message) => `${message.role}:${textOf(message)}`).join("\n---\n"));
      return fauxAssistantMessage(fauxToolCall("session_memory", { operation: "write", purpose: "finding", author: "agent", content: "空指针根因在第 42 行", expectedRevision: 0 }));
    },
    fauxAssistantMessage("已写入：entryId=smem-0001，revision=1"),
  ]);
  const result = await run({
    projectId: project.projectId, chatHome: process.env.CHAT_HOME, cwd: workspace,
    sessionId: undefined, prompt: "为什么这里空指针？", workflowInvocationId: "smem-invocation-1",
  });
  assert.equal(typeof result.text, "string");
  assert.notEqual(result.text, "");
  assert.equal(workerTools[0].includes("session_memory"), true, "the worker is offered the memory tool for on-demand reads");
  const memory = await readSessionMemory(process.env.CHAT_HOME, "friend", result.sessionId);
  assert.equal(memory.entries.length, 1, "the writer wrote exactly one entry");
  assert.equal(memory.entries[0].content, "空指针根因在第 42 行");
  assert.equal(writerInputs.length, 1);
  assert.equal(writerInputs[0].includes("为什么这里空指针？"), true, "the writer sees the round's user message");
  assert.equal(writerInputs[0].includes("work 阶段：已定位到空指针在第 42 行"), true, "the writer sees the whole work stage");
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
  // A Session with no user entry at all: the remember stage must fail visibly and write nothing.
  await assert.rejects(
    runSessionMemoryRememberStep({ projectId: project.projectId, chatHome: process.env.CHAT_HOME, cwd: workspace,
      sessionId: undefined, prompt: "无用户条目", workflowInvocationId: "smem-refuse-1" }),
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
