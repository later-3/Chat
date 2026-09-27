import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendChatWorkflowStage } from "../../src/workflows/workflow-stage.ts";
import {
  prepareSessionMemoryWriterSession,
  SessionMemoryRoundUnavailableError,
} from "../../src/workflows/session-memory/agents/writer/runtime.ts";
import { SESSION_MEMORY_WRITER_AGENT } from "../../src/workflows/session-memory/agents/writer/index.ts";

const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() });
const toolResult = (text) => ({ role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text }], timestamp: Date.now() });

const sessionManagerWith = (messages) => {
  const manager = SessionManager.inMemory();
  for (const message of messages) manager.appendMessage(message);
  return manager;
};
const context = (messages) => ({
  workflowId: "session-memory", agentId: SESSION_MEMORY_WRITER_AGENT.id, workflowInvocationId: "inv-1", stageId: "remember",
  sessionManager: sessionManagerWith(messages),
});

test("P2 writer runtime: the model input is the current round only", async () => {
  const messages = [
    user("第一轮：请修空指针"),
    assistant("第一轮回答"),
    toolResult("第一轮工具结果"),
    user("第二轮：它又出现了"),
    assistant("work 阶段回答 A"),
    toolResult("work 阶段工具结果"),
    assistant("work 阶段回答 B"),
  ];
  const extensions = await prepareSessionMemoryWriterSession(context(messages));
  const projected = await extensions.transformContext([]);
  assert.equal(projected.some((message) => JSON.stringify(message).includes("第一轮")), false, "previous rounds never reach the writer");
  assert.equal(JSON.stringify(projected).includes("第二轮：它又出现了"), true);
  // The whole work stage survives: both assistant entries and the tool entry.
  assert.equal(projected.filter((message) => message.role === "assistant").length, 2);
  assert.equal(projected.filter((message) => message.role === "toolResult").length, 1);
  // The invocation control instruction is added by the shared workflow turn context.
  assert.equal(projected.some((message) => message.role === "custom" && message.customType === "chat.workflow_turn_context"), true);
});

test("P2 writer runtime: a round without a user entry fails visibly and writes nothing", async () => {
  const extensions = await prepareSessionMemoryWriterSession(context([assistant("只有助手输出"), toolResult("工具结果")]));
  await assert.rejects(
    async () => extensions.transformContext([]),
    (error) => error instanceof SessionMemoryRoundUnavailableError && error.code === "SESSION_MEMORY_ROUND_UNAVAILABLE",
    "the writer refuses instead of receiving the whole history",
  );
  const empty = await prepareSessionMemoryWriterSession(context([]));
  await assert.rejects(async () => empty.transformContext([]), SessionMemoryRoundUnavailableError);
  // The writer is the shared LAST node of every interactive Workflow, so any workflow may assemble it…
  const asTail = await prepareSessionMemoryWriterSession({ ...context([]), workflowId: "memory" });
  assert.equal(typeof asTail.transformContext, "function");
  // …but a wrong AGENT is still refused.
  await assert.rejects(
    prepareSessionMemoryWriterSession({ ...context([]), agentId: "pi-coding-agent" }),
    /不能装配Agent/,
  );
});

test("writer respects native compaction without restoring archived round text or another branch", async () => {
  const manager = sessionManagerWith([user("OLD_ROUND"), assistant("OLD_ANSWER")]);
  const oldLeaf = manager.getLeafId();
  appendChatWorkflowStage(manager, { invocationId: "inv-1", workflowId: "session-memory", stageId: "work", agentId: "worker" });
  manager.appendMessage(user("CURRENT_LONG_REQUEST"));
  manager.appendMessage(assistant("ARCHIVED_WORK_OUTPUT"));
  const kept = manager.appendMessage(user("CURRENT_REVIEW"));
  manager.appendMessage(assistant("KEPT_WORK_OUTPUT"));
  manager.appendCompaction("CURRENT_ROUND_SUMMARY", kept, 50000);
  const compactedLeaf = manager.getLeafId();
  const extensions = await prepareSessionMemoryWriterSession({ ...context([]), sessionManager: manager });
  const projected = await extensions.transformContext([]);
  assert.match(JSON.stringify(projected), /CURRENT_ROUND_SUMMARY/);
  assert.match(JSON.stringify(projected), /CURRENT_REVIEW/);
  assert.match(JSON.stringify(projected), /KEPT_WORK_OUTPUT/);
  assert.doesNotMatch(JSON.stringify(projected), /OLD_ROUND|OLD_ANSWER|CURRENT_LONG_REQUEST|ARCHIVED_WORK_OUTPUT/);
  assert.match(JSON.stringify(manager.getEntries()), /CURRENT_LONG_REQUEST/, "compaction does not delete original history");
  manager.branch(oldLeaf);
  manager.appendMessage(user("OTHER_BRANCH"));
  const other = await extensions.transformContext([]);
  assert.match(JSON.stringify(other), /OTHER_BRANCH/);
  assert.doesNotMatch(JSON.stringify(other), /CURRENT_ROUND_SUMMARY|KEPT_WORK_OUTPUT/);
  manager.branch(compactedLeaf);
  const restored = await extensions.transformContext([]);
  assert.deepEqual(restored.filter(m => m.role !== "custom"), projected.filter(m => m.role !== "custom"));
});

test("hidden handoffs do not break the parent chain used to find compacted round context", async () => {
  const manager = sessionManagerWith([user("OLD_ROUND"), assistant("OLD_ANSWER")]);
  appendChatWorkflowStage(manager, { invocationId: "inv-1", workflowId: "session-memory", stageId: "work", agentId: "worker" });
  manager.appendMessage(user("ROUND_REQUEST"));
  manager.appendMessage(assistant("ROUND_ANSWER"));
  manager.appendCustomMessageEntry("chat.workflow_agent_handoff", "HIDDEN_CONTROL", false);
  manager.setContextEntryFilter(entry => entry.type !== "custom_message" || entry.customType !== "chat.workflow_agent_handoff");
  const extensions = await prepareSessionMemoryWriterSession({ ...context([]), sessionManager: manager });
  const result = JSON.stringify(await extensions.transformContext([]));
  assert.match(result, /ROUND_REQUEST/);
  assert.match(result, /ROUND_ANSWER/);
  assert.doesNotMatch(result, /OLD_ROUND|OLD_ANSWER|HIDDEN_CONTROL/);
});
