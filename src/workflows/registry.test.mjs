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
  ]);
  assert.equal(DEFAULT_CHAT_WORKFLOW_ID, "minimal-pi-coding-agent");
  assert.equal(getChatWorkflowDefinition("unknown"), undefined);

  const workflows = listChatWorkflowDefinitions();
  assert.equal(workflows.length, 2);
  assert.equal("run" in workflows[0], false);
  assert.deepEqual(workflows.map((workflow) => workflow.agents.map((agent) => agent.id)), [
    ["pi-coding-agent"],
    ["planner", "pi-coding-agent"],
  ]);
  assert.deepEqual(workflows.map((workflow) => workflow.stages.map((stage) => stage.agentId)), [
    ["pi-coding-agent"],
    ["planner", "pi-coding-agent"],
  ]);
});
