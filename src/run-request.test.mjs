import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_WORKFLOW_PROMPT_CHARS,
  parseMinimalWorkflowHttpInput,
} from "./run-request.ts";

const defaults = { cwd: "/workspace", prompt: "default" };

test("empty body keeps the VS Code debug defaults", () => {
  assert.deepEqual(parseMinimalWorkflowHttpInput(undefined, defaults), defaults);
});

test("adapter input overrides cwd and prompt", () => {
  assert.deepEqual(
    parseMinimalWorkflowHttpInput({ cwd: "/repo", prompt: "你好" }, defaults),
    { cwd: "/repo", prompt: "你好" },
  );
});

test("invalid and oversized prompts are rejected", () => {
  assert.throws(
    () => parseMinimalWorkflowHttpInput({ prompt: "   " }, defaults),
    /prompt必须是非空字符串/,
  );
  assert.throws(
    () => parseMinimalWorkflowHttpInput({ prompt: "x".repeat(MAX_WORKFLOW_PROMPT_CHARS + 1) }, defaults),
    /prompt不能超过/,
  );
});
