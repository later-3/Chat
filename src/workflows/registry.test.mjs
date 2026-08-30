import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_WORKFLOW_IDS,
  DEFAULT_CHAT_WORKFLOW_ID,
  getChatWorkflowDefinition,
  listChatWorkflowDefinitions,
} from "./registry.ts";

test("Workflow registry is the single backend source for available Workflows", () => {
  assert.deepEqual(CHAT_WORKFLOW_IDS, [
    "minimal-pi-coding-agent",
    "planning-execution",
    "memory",
    "rule-management",
  ]);
  assert.equal(DEFAULT_CHAT_WORKFLOW_ID, "minimal-pi-coding-agent");
  assert.equal(getChatWorkflowDefinition("unknown"), undefined);

  const workflows = listChatWorkflowDefinitions();
  assert.equal(workflows.length, 4);
  assert.equal("run" in workflows[0], false);
  assert.equal(workflows.some((workflow) => "prepareAgentSession" in workflow), false);
  assert.deepEqual(workflows.map((workflow) => workflow.agents.map((agent) => agent.id)), [
    ["pi-coding-agent"],
    ["planner", "pi-coding-agent"],
    ["memory-agent"],
    ["rule-curator-agent"],
  ]);
  assert.deepEqual(workflows.map((workflow) => workflow.nodes.map((node) => (
    node.kind === "agent" ? node.agentId : null
  ))), [
    ["pi-coding-agent"],
    ["planner", "pi-coding-agent"],
    ["memory-agent"],
    ["rule-curator-agent"],
  ]);
});
