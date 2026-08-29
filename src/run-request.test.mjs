import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CHAT_WORKFLOW_ID,
  MAX_WORKFLOW_PROMPT_CHARS,
  parseChatWorkflowHttpInput,
} from "./run-request.ts";

const defaults = {
  cwd: "/workspace",
  prompt: "default",
  workflow: DEFAULT_CHAT_WORKFLOW_ID,
};

test("empty body keeps the VS Code debug defaults", () => {
  assert.deepEqual(parseChatWorkflowHttpInput(undefined, defaults), defaults);
});

test("adapter input overrides cwd and prompt", () => {
  assert.deepEqual(
    parseChatWorkflowHttpInput({ cwd: "/repo", prompt: "你好" }, defaults),
    { cwd: "/repo", prompt: "你好", workflow: DEFAULT_CHAT_WORKFLOW_ID },
  );
});

test("the request selects one of the two registered workflows", () => {
  assert.equal(
    parseChatWorkflowHttpInput({ workflow: "planning-execution" }, defaults).workflow,
    "planning-execution",
  );
  assert.throws(
    () => parseChatWorkflowHttpInput({ workflow: "unknown" }, defaults),
    /workflow必须是/,
  );
});

test("an existing Chat session can be selected by id", () => {
  assert.deepEqual(
    parseChatWorkflowHttpInput(
      { cwd: "/repo", prompt: "继续", sessionId: "session-1" },
      defaults,
    ),
    {
      cwd: "/repo",
      prompt: "继续",
      sessionId: "session-1",
      workflow: DEFAULT_CHAT_WORKFLOW_ID,
    },
  );
  assert.throws(
    () => parseChatWorkflowHttpInput({ sessionId: "" }, defaults),
    /sessionId必须是非空字符串/,
  );
});

test("Agent configuration files are scoped to Agents in the selected Workflow", () => {
  assert.deepEqual(
    parseChatWorkflowHttpInput({
      workflow: "planning-execution",
      agentConfigs: {
        planner: { primary: "/configs/planner.json" },
        "pi-coding-agent": {
          append: ["/configs/coding.json"],
          promptFiles: ["/rules/typescript.md"],
        },
      },
    }, defaults),
    {
      cwd: "/workspace",
      prompt: "default",
      workflow: "planning-execution",
      agentConfigs: {
        planner: { primary: "/configs/planner.json" },
        "pi-coding-agent": {
          append: ["/configs/coding.json"],
          promptFiles: ["/rules/typescript.md"],
        },
      },
    },
  );
  assert.throws(
    () => parseChatWorkflowHttpInput({
      workflow: "minimal-pi-coding-agent",
      agentConfigs: { planner: { primary: "/configs/planner.json" } },
    }, defaults),
    /不存在Agent: planner/,
  );
});

test("invalid and oversized prompts are rejected", () => {
  assert.throws(
    () => parseChatWorkflowHttpInput({ prompt: "   " }, defaults),
    /prompt必须是非空字符串/,
  );
  assert.throws(
    () => parseChatWorkflowHttpInput({ prompt: "x".repeat(MAX_WORKFLOW_PROMPT_CHARS + 1) }, defaults),
    /prompt不能超过/,
  );
});
