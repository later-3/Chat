import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "../long-agents/daily-fixture.mjs";
import { ensureChatSessionWithId } from "../../src/chat-session.ts";
import { readSessionMemory, sessionMemoryFile } from "../../src/long-agents/session-memory.ts";
import { minimalPiCodingAgentWorkflowDefinition } from "../../src/workflows/minimal-pi-coding-agent/index.ts";

const WRITER_MARK = "维护**本会话**的会话记忆";

/**
 * The Workflow's LAST node is the session-memory writer, and an ordinary Project session is not an Agent
 * home: this proves the tail writes to `projects/<id>/session-memory/`, i.e. that "every interactive
 * Workflow ends with the memory node" holds for Project sessions too (not only Long Agent homes).
 */
function handlerFor(memoryContent) {
  return (body) => {
    const system = body.messages.find((message) => message.role === "system")?.content;
    const lastIsToolResult = body.messages.at(-1)?.role === "tool";
    // The writer's FIRST turn writes one entry; its second turn closes the round (never another call).
    if (typeof system === "string" && system.includes(WRITER_MARK)) {
      if (lastIsToolResult) return { content: "本轮无需写入" };
      return { tool_calls: [{ index: 0, id: "smem-write-1", type: "function", function: { name: "session_memory",
        arguments: JSON.stringify({ operation: "write", purpose: "finding", author: "agent", content: memoryContent, expectedRevision: 0 }) } }] };
    }
    return { content: "项目会话回答" };
  };
}

/** Text of the FIRST custom entry of a type, for readable failure assertions. */
function entryTextOf(session, customType) {
  const entry = session.manager.getEntries().find((candidate) => candidate.type === "custom_message" && candidate.customType === customType);
  return entry?.content ?? null;
}

async function runProjectRound(f, sessionId, extra) {
  return minimalPiCodingAgentWorkflowDefinition.run({
    projectId: "a", chatHome: f.home, cwd: f.projects.find((project) => project.projectId === "a").projectRoot,
    prompt: "项目会话的一轮请求", sessionId,
    workflowInvocationId: `proj-smem-${sessionId}`, ...extra,
  });
}

test("the Workflow tail writes session memory for an ordinary Project session", { concurrency: false }, async (t) => {
  const f = await fixture(t);
  const sessionId = "sess-project-tail";
  await ensureChatSessionWithId({ chatHome: f.home, projectId: "a" }, sessionId, "Project session");
  f.setHandler(handlerFor("项目会话自己的记忆条目"));

  const result = await runProjectRound(f, sessionId, {});
  assert.equal(result.text, "项目会话回答", "the round answer stays the WORK answer");
  const memory = await readSessionMemory(f.home, "a", sessionId);
  assert.equal(memory.entries.length, 1);
  assert.equal(memory.entries[0].content, "项目会话自己的记忆条目");
  assert.equal(memory.entries[0].purpose, "finding");
  const file = sessionMemoryFile(f.home, "a", sessionId);
  assert.equal(file.includes("/projects/a/session-memory/"), true, `memory must live in the project data dir: ${file}`);
});

test("with the switch off the Project round runs without the memory node", { concurrency: false }, async (t) => {
  const f = await fixture(t);
  const sessionId = "sess-project-tail-off";
  await ensureChatSessionWithId({ chatHome: f.home, projectId: "a" }, sessionId, "Project session");
  f.setHandler(handlerFor("本项目轮次不应写入的记忆"));

  const result = await runProjectRound(f, sessionId, { sessionMemoryEnabled: false });
  assert.equal(result.text, "项目会话回答");
  assert.equal((await readSessionMemory(f.home, "a", sessionId)).entries.length, 0, "the memory node was skipped");
});

test("the remember node records the OWNING Workflow, not session-memory", { concurrency: false }, async (t) => {
  const f = await fixture(t);
  const sessionId = "sess-project-tail-owner";
  await ensureChatSessionWithId({ chatHome: f.home, projectId: "a" }, sessionId, "Project session");
  f.setHandler(handlerFor("归属 Workflow 的记忆"));

  await runProjectRound(f, sessionId, {});
  const { openChatSession } = await import("../../src/chat-session.ts");
  const session = await openChatSession({ chatHome: f.home, projectId: "a", sessionId });
  const stages = session.manager.getEntries()
    .filter((entry) => entry.type === "custom" && entry.customType === "chat.workflow_stage")
    .map((entry) => entry.data);
  const remember = stages.filter((stage) => stage.stageId === "remember");
  assert.equal(remember.length, 1, "the memory node records exactly one stage entry");
  assert.equal(remember[0].workflowId, "minimal-pi-coding-agent", "the owner keeps its own provenance");
  assert.equal(remember[0].agentId, "session-memory-writer");
});

test("a failed memory node keeps the work answer, records a visible notice and never reports success", { concurrency: false }, async (t) => {
  const f = await fixture(t);
  const sessionId = "sess-project-tail-fail";
  await ensureChatSessionWithId({ chatHome: f.home, projectId: "a" }, sessionId, "Project session");
  // The writer stage fails hard; the work stage answers normally.
  f.setHandler((body) => {
    const system = body.messages.find((message) => message.role === "system")?.content;
    if (typeof system === "string" && system.includes(WRITER_MARK)) {
      return { error: "memory provider exploded" };
    }
    return { content: "项目会话回答" };
  });

  // The provider error surfaces as the writer stage failing to produce an answer.
  await assert.rejects(runProjectRound(f, sessionId, {}), /remember 阶段没有返回Assistant文本|memory provider exploded/);
  const { openChatSession } = await import("../../src/chat-session.ts");
  const session = await openChatSession({ chatHome: f.home, projectId: "a", sessionId });
  const notices = session.manager.getEntries()
    .filter((entry) => entry.type === "custom_message" && entry.customType === "chat.session_memory_notice")
    .map((entry) => entry.details);
  assert.equal(notices.length, 1, "the failure is recorded in the session, not only logged");
  assert.equal(notices[0].status, "failed");
  // …and it must reach the PUBLIC message contract, not only the raw entry file: a display:false entry
  // is filtered out by the session read, so the owner would never see it.
  const { readChatSession } = await import("../../src/session-read-model.ts");
  const publicRead = await readChatSession(sessionId, undefined, {}, "a", f.home, { kind: "owner" });
  const visible = publicRead.context.messages.filter((message) => message.role === "custom"
    && message.customType === "chat.session_memory_notice");
  assert.equal(visible.length, 1, "the failure notice must be visible through the public read");
  assert.equal(publicRead.context.messages.some((message) => message.role === "assistant"
    && JSON.stringify(message.content).includes("项目会话回答")), true, "the work answer stays");
  assert.match(String(entryTextOf(session, "chat.session_memory_notice")), /会话记忆本轮未写入/);
  // The work answer itself is still in the session.
  assert.equal(session.manager.getEntries().some((entry) => entry.type === "message"
    && entry.message?.role === "assistant" && JSON.stringify(entry.message.content).includes("项目会话回答")), true);
});

test("memory switch helpers agree on who closes the round's event stream", async () => {
  const { memoryTailFollows, stageFinishClosesStream } = await import("../../src/workflows/session-memory/tail-policy.ts");
  // Memory on: the work stage steps back, the memory stage closes.
  assert.equal(memoryTailFollows({}), true);
  assert.equal(stageFinishClosesStream({}), false);
  // Memory off: the work stage IS the last node and closes the round.
  assert.equal(memoryTailFollows({ sessionMemoryEnabled: false }), false);
  assert.equal(stageFinishClosesStream({ sessionMemoryEnabled: false }), true);
});

test("the memory node never cleans the work Agent's frozen configuration", { concurrency: false }, async (t) => {
  const f = await fixture(t);
  const sessionId = "sess-project-tail-config";
  await ensureChatSessionWithId({ chatHome: f.home, projectId: "a" }, sessionId, "Project session");
  f.setHandler(handlerFor("配置接缝的记忆"));
  const workProject = f.projects.find((project) => project.projectId === "a").projectRoot;
  // The owner configures the WORK agent; the answer must not be reset by the memory stage.
  const selection = { tools: { mode: "explicit", names: ["read"], exclude: [], addresses: ["system:tool/session_memory"] } };
  await runProjectRound(f, sessionId, { agentConfigs: { "pi-coding-agent": selection } });

  const { openChatSession } = await import("../../src/chat-session.ts");
  const { collectLatestChatWorkflowConfigurations, collectChatWorkflowTurnConfigurations } = await import("../../src/workflows/workflow-configuration.ts");
  const session = await openChatSession({ chatHome: f.home, projectId: "a", sessionId });
  const entries = session.manager.getEntries();

  const stored = collectLatestChatWorkflowConfigurations(entries)["minimal-pi-coding-agent"];
  assert.notEqual(stored?.["pi-coding-agent"], undefined, "the work Agent keeps its selection after remember");
  assert.deepEqual(stored?.["pi-coding-agent"]?.tools?.addresses, ["system:tool/session_memory"]);

  // ONE immutable snapshot per invocation: the memory stage must reuse it, not append a second one.
  const snapshots = collectChatWorkflowTurnConfigurations(entries).filter((snapshot) => snapshot.workflowId === "minimal-pi-coding-agent");
  assert.equal(snapshots.length, 1, "one round = one configuration snapshot");
  assert.equal(snapshots[0].agentConfigs["pi-coding-agent"] !== undefined, true);

  // And the NEXT round still sees the original selection.
  f.setHandler(handlerFor("第二轮的记忆"));
  await runProjectRound(f, sessionId, {});
  const nextSession = await openChatSession({ chatHome: f.home, projectId: "a", sessionId });
  const nextStored = collectLatestChatWorkflowConfigurations(nextSession.manager.getEntries())["minimal-pi-coding-agent"];
  assert.deepEqual(nextStored?.["pi-coding-agent"]?.tools?.addresses, ["system:tool/session_memory"],
    "the original selection stays valid for the next round");
  void workProject;
});
