import assert from "node:assert/strict";
import test from "node:test";
import { projectCurrentRoundContext, prepareWorkflowTurnContext } from "../../src/workflows/session-conversation.ts";

const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() });
const toolResult = (text) => ({ role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text }], timestamp: Date.now() });
const handoff = (invocationId, stageId, agentId) => ({
  role: "custom", customType: "chat.workflow_agent_handoff", content: "handoff", display: false,
  details: { invocationId, stageId, agentId, entryId: "x" }, timestamp: Date.now(),
});

test("P2 remember context: only the current round reaches the writer", () => {
  const messages = [
    user("第一轮：请修空指针"),
    assistant("第一轮回答"),
    toolResult("第一轮工具结果"),
    user("第二轮：它又出现了"),
    assistant("work 阶段回答 A"),
    toolResult("work 阶段工具结果"),
    assistant("work 阶段回答 B"),
  ];
  const projected = projectCurrentRoundContext(messages);
  assert.deepEqual(projected.map((message) => message.role), ["user", "assistant", "toolResult", "assistant"]);
  assert.equal(projected[0].content[0].text, "第二轮：它又出现了", "the round starts at its own user entry");
  assert.equal(projected.some((message) => JSON.stringify(message).includes("第一轮")), false, "the previous round is not injected");
  // The WHOLE work stage is kept (every assistant and tool entry), not just the last leaf.
  assert.equal(projected.filter((message) => message.role === "assistant").length, 2);
  assert.equal(projected.filter((message) => message.role === "toolResult").length, 1);
});

test("P2 remember context: the projection composes with the workflow turn context", () => {
  const messages = [
    user("旧的轮次"),
    assistant("旧的回答"),
    handoff("invocation-old", "remember", "session-memory-writer"),
    user("本轮问题"),
    assistant("work 阶段产物"),
    handoff("invocation-new", "remember", "session-memory-writer"),
  ];
  const projected = projectCurrentRoundContext(messages);
  const prepared = prepareWorkflowTurnContext(projected, { workflowId: "session-memory", invocationId: "invocation-new", stageId: "remember", agentId: "session-memory-writer" });
  // The older round AND last-invocation handoff are gone; this invocation's own control remains.
  assert.equal(JSON.stringify(prepared).includes("旧的轮次"), false);
  assert.equal(JSON.stringify(prepared).includes("invocation-old"), false);
  assert.equal(JSON.stringify(prepared).includes("本轮问题"), true);
  assert.equal(JSON.stringify(prepared).includes("work 阶段产物"), true);
  assert.equal(prepared.some((message) => message.role === "custom" && message.customType === "chat.workflow_turn_context"), true);
  // A session with no user message at all is passed through unchanged (no silent truncation).
  const noUser = [assistant("only assistant")];
  assert.deepEqual(projectCurrentRoundContext(noUser), noUser);
});
