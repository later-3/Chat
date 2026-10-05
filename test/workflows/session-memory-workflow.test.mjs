import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ensureAgentHomeProject } from "../../src/projects/registry.ts";
import { readSessionMemory, sessionMemoryFile } from "../../src/long-agents/session-memory.ts";
import { sessionMemoryWorkflowDefinition } from "../../src/workflows/session-memory/index.ts";
import { ensureChatSessionWithId } from "../../src/chat-session.ts";
import { appendChatUserMessage } from "../../src/workflows/session-conversation.ts";
import { fixture } from "../long-agents/daily-fixture.mjs";

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

async function agentHomeFixture(t, prefix) {
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
  const project = await ensureAgentHomeProject("friend", "Friend", process.env.CHAT_HOME);
  return { base, faux, workspace: project.cwd, project };
}

const run = (input) => sessionMemoryWorkflowDefinition.run(input);

test("session-memory workflow: one remember node judges the WHOLE session and its report is the answer", { concurrency: false }, async (t) => {
  const { faux, workspace, project } = await agentHomeFixture(t, "chat-smem-workflow");
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "BUSINESS_IDENTITY_ONLY: act as the project worker.");
  const writerInputs = [];
  const writerTools = [];
  faux.setResponses([
    (context) => {
      assert.doesNotMatch(context.systemPrompt, /BUSINESS_IDENTITY_ONLY/, "the writer must not inherit business identity instructions");
      writerTools.push((context.tools ?? []).map((tool) => tool.name));
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
  ]);
  // Seed an EARLIER round directly in the Session: the writer judges the WHOLE session, so both rounds
  // must reach it (this is the manual, user-triggered consolidation round).
  const seeded = await ensureChatSessionWithId({ chatHome: process.env.CHAT_HOME, projectId: project.projectId },
    "sess-whole", "整轮会话");
  appendChatUserMessage(seeded.session.manager, "第一轮问题");
  seeded.session.manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "第一轮回答：空指针在第一处" }], timestamp: Date.now() });
  seeded.session.manager.flush();

  const result = await run({
    projectId: project.projectId, chatHome: process.env.CHAT_HOME, cwd: workspace,
    sessionId: "sess-whole", prompt: "整理这一轮的会话记忆", workflowInvocationId: "smem-invocation-1",
  });
  assert.equal(result.sessionId, "sess-whole");
  // The round's answer IS the writer's report (entry receipts), not a work-stage answer.
  assert.match(result.text, /已写入 entryId=/);
  assert.deepEqual(writerTools[0], ["session_memory"], "the writer gets exactly the memory tool");
  // Whole-session projection: the earlier round AND the trigger instruction both reach the writer.
  assert.equal(writerInputs[0].includes("第一轮问题"), true, "the earlier round's user message reaches the writer");
  assert.equal(writerInputs[0].includes("第一轮回答"), true, "the earlier round's answer reaches the writer");
  assert.equal(writerInputs[0].includes("整理这一轮的会话记忆"), true, "the trigger message is part of the projection");
  const memory = await readSessionMemory(process.env.CHAT_HOME, "friend", result.sessionId);
  assert.equal(memory.entries.length, 1, "the writer wrote exactly one entry");
  assert.equal(memory.entries[0].content, "空指针根因在第 42 行");
  // The writer's visible reply cites the entry id the tool actually returned (not a scripted value).
  assert.equal(result.text.includes(memory.entries[0].entryId), true, "the report cites the real entry id from the tool result");
  assert.equal(result.text.includes("revision=1"), true, "the report cites the real revision");
  // Exactly one stage ran, owned by the session-memory Workflow itself.
  const session = await ensureChatSessionWithId({ chatHome: process.env.CHAT_HOME, projectId: project.projectId }, result.sessionId);
  const stages = session.session.manager.getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === "chat.workflow_stage")
    .map((entry) => entry.data);
  assert.deepEqual(stages.map((stage) => stage.stageId), ["remember"], "the round is a single remember stage");
  assert.equal(stages[0].workflowId, "session-memory");
  assert.equal(stages[0].agentId, "session-memory-writer");
});

test("session-memory workflow: a round judged not worth recording writes nothing and says so", { concurrency: false }, async (t) => {
  const { faux, workspace, project } = await agentHomeFixture(t, "chat-smem-none");
  faux.setResponses([fauxAssistantMessage("本轮无需写入")]);
  const result = await run({
    projectId: project.projectId, chatHome: process.env.CHAT_HOME, cwd: workspace,
    sessionId: undefined, prompt: "没什么可记的", workflowInvocationId: "smem-none-1",
  });
  assert.equal(result.text, "本轮无需写入", "the writer's judgment is the round's answer");
  assert.equal((await readSessionMemory(process.env.CHAT_HOME, "friend", result.sessionId)).entries.length, 0,
    "a round the writer judged not worth recording stays empty");
});

test("session-memory workflow: an ordinary Project session keeps its memory inside the project data dir", { concurrency: false }, async (t) => {
  const f = await fixture(t);
  const sessionId = "sess-project-smem";
  await ensureChatSessionWithId({ chatHome: f.home, projectId: "a" }, sessionId, "Project session");
  // The writer's FIRST turn writes one entry; its second turn closes the round (never another call).
  f.setHandler((body) => {
    const system = body.messages.find((message) => message.role === "system")?.content;
    const lastIsToolResult = body.messages.at(-1)?.role === "tool";
    if (typeof system === "string" && system.includes("维护**本会话**的会话记忆")) {
      if (lastIsToolResult) return { content: "已按工具返回核对写入" };
      return { tool_calls: [{ index: 0, id: "smem-write-1", type: "function", function: { name: "session_memory",
        arguments: JSON.stringify({ operation: "write", purpose: "finding", author: "agent", content: "项目会话自己的记忆条目", expectedRevision: 0 }) } }] };
    }
    return { content: "不应出现的回答" };
  });

  const result = await run({
    projectId: "a", chatHome: f.home,
    cwd: f.projects.find((project) => project.projectId === "a").projectRoot,
    prompt: "整理本会话记忆", sessionId, workflowInvocationId: "proj-smem-1",
  });
  assert.equal(result.text, "已按工具返回核对写入", "the writer's report is the round's answer");
  const memory = await readSessionMemory(f.home, "a", sessionId);
  assert.equal(memory.entries.length, 1);
  assert.equal(memory.entries[0].content, "项目会话自己的记忆条目");
  assert.equal(memory.entries[0].purpose, "finding");
  const file = sessionMemoryFile(f.home, "a", sessionId);
  assert.equal(file.includes("/projects/a/sessions/session-memory/"), true, `memory must live in the project data dir: ${file}`);
});

test("session-memory workflow: a failed round records a visible notice and never reports success", { concurrency: false }, async (t) => {
  const f = await fixture(t);
  const sessionId = "sess-smem-fail";
  await ensureChatSessionWithId({ chatHome: f.home, projectId: "a" }, sessionId, "Project session");
  f.setHandler(() => ({ error: "memory provider exploded" }));

  // The provider error surfaces as the round failing to produce an answer.
  await assert.rejects(
    run({
      projectId: "a", chatHome: f.home,
      cwd: f.projects.find((project) => project.projectId === "a").projectRoot,
      prompt: "整理本会话记忆", sessionId, workflowInvocationId: "proj-smem-fail",
    }),
    /会话记忆 remember 阶段没有返回Assistant文本|memory provider exploded/,
  );
  const { openChatSession } = await import("../../src/chat-session.ts");
  const session = await openChatSession({ chatHome: f.home, projectId: "a", sessionId });
  const notices = session.manager.getEntries()
    .filter((entry) => entry.type === "custom_message" && entry.customType === "chat.session_memory_notice")
    .map((entry) => entry.details);
  assert.equal(notices.length, 1, "the failure is recorded in the session, not only logged");
  assert.equal(notices[0].status, "failed");
  // …and it must reach the PUBLIC message contract: a display:false entry is filtered out by the
  // session read, so the owner would never see it.
  const { readChatSession } = await import("../../src/session-read-model.ts");
  const publicRead = await readChatSession(sessionId, undefined, {}, "a", f.home, { kind: "owner" });
  const visible = publicRead.context.messages.filter((message) => message.role === "custom"
    && message.customType === "chat.session_memory_notice");
  assert.equal(visible.length, 1, "the failure notice must be visible through the public read");
});
