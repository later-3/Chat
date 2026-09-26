import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_WORKFLOW_IDS,
  DEFAULT_CHAT_WORKFLOW_ID,
  getChatWorkflowDefinition,
  listChatWorkflowDefinitions,
} from "../../src/workflows/registry.ts";

test("Workflow registry is the single backend source for available Workflows", () => {
  assert.deepEqual(CHAT_WORKFLOW_IDS, [
    "minimal-pi-coding-agent",
    "planning-execution",
    "planner-orchestrator",
    "memory",
    "rule-management",
    "session-memory",
    "problem-diagnosis",
    "topic-session-create",
  ]);
  assert.equal(DEFAULT_CHAT_WORKFLOW_ID, "minimal-pi-coding-agent");
  assert.equal(getChatWorkflowDefinition("unknown"), undefined);

  const workflows = listChatWorkflowDefinitions();
  assert.equal(workflows.length, 8);
  assert.equal("run" in workflows[0], false);
  assert.equal(workflows.some((workflow) => "prepareAgentSession" in workflow), false);
  assert.deepEqual(workflows.map((workflow) => workflow.agentCallable), [
    true,
    true,
    true,
    true,
    false,
    true,
    true,
    true,
  ]);
  assert.deepEqual(workflows.map((workflow) => workflow.agents.map((agent) => agent.id)), [
    ["pi-coding-agent", "session-memory-writer"],
    ["planner", "pi-coding-agent", "session-memory-writer"],
    ["planner", "coordinator", "session-memory-writer"],
    ["memory-agent", "session-memory-writer"],
    ["rule-curator-agent", "session-memory-writer"],
    ["session-memory-worker", "session-memory-writer"],
    ["problem-diagnoser", "session-memory-writer"],
    ["topic-collector", "topic-creator", "session-memory-writer"],
  ]);
  assert.deepEqual(workflows.map((workflow) => workflow.nodes.map((node) => (
    node.kind === "agent" ? node.agentId : null
  ))), [
    ["pi-coding-agent", "session-memory-writer"],
    ["planner", null, "pi-coding-agent", "session-memory-writer"],
    ["planner", null, "coordinator", "session-memory-writer"],
    ["memory-agent", "session-memory-writer"],
    ["rule-curator-agent", "session-memory-writer"],
    ["session-memory-worker", "session-memory-writer"],
    ["problem-diagnoser", "session-memory-writer"],
    ["topic-collector", null, "topic-creator", "session-memory-writer"],
  ]);
});
