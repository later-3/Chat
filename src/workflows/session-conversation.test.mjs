import assert from "node:assert/strict";
import test from "node:test";
import { prepareWorkflowTurnContext } from "./session-conversation.ts";

test("workflow transitions filter only stale controls, preserving every authored message and original input", () => {
  const old = { invocationId: "old", workflowId: "planning-execution", stageId: "execute", agentId: "coder" };
  const current = { invocationId: "new", workflowId: "planner-orchestrator", stageId: "plan", agentId: "planner" };
  const messages = [
    { role: "user", content: "original", timestamp: 1 },
    { role: "custom", customType: "chat.workflow_agent_handoff", details: old, content: "old authority", timestamp: 2 },
    { role: "assistant", content: [{ type: "text", text: "original result" }], timestamp: 3 },
    { role: "custom", customType: "unrelated", content: "retained", timestamp: 4 },
    { role: "custom", customType: "chat.planner_output_repair", details: { ...current, stageId: "other" }, content: "other stage", timestamp: 5 },
    { role: "user", content: "new request", timestamp: 6 },
    { role: "custom", customType: "chat.planner_output_repair", details: current, content: "current correction", timestamp: 7 },
  ];
  const before = structuredClone(messages);
  const result = prepareWorkflowTurnContext(messages, current);
  assert.deepEqual(messages, before);
  assert.deepEqual(result.filter((message) => message.customType !== "chat.workflow_turn_context"), [messages[0], messages[2], messages[3], messages[5], messages[6]]);
  assert.match(result.find((message) => message.customType === "chat.workflow_turn_context").content, /不代表本轮继续执行历史阶段/);
});
