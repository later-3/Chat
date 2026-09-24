import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareSessionMemoryWriterSession,
  SessionMemoryRoundUnavailableError,
} from "../../src/workflows/session-memory/agents/writer/runtime.ts";
import { SESSION_MEMORY_WRITER_AGENT } from "../../src/workflows/session-memory/agents/writer/index.ts";

const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() });
const toolResult = (text) => ({ role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text }], timestamp: Date.now() });

/**
 * The writer reads the round from the DURABLE Session branch (a Workflow agent session does not carry the
 * conversation in the messages handed to transformContext), so the test provides a SessionManager-like
 * object whose context branch contains the entries.
 */
const entryOf = (message) => ({ type: "message", id: `entry-${Math.random().toString(16).slice(2)}`, parentId: null, timestamp: new Date().toISOString(), message });
const sessionManagerWith = (messages) => ({ getContextBranch: () => messages.map(entryOf) });
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
  // A wrong workflow/agent cannot assemble this writer at all.
  await assert.rejects(
    prepareSessionMemoryWriterSession({ ...context([]), workflowId: "memory" }),
    /不能装配Agent/,
  );
});
