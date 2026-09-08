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

test("the request selects a registered workflow", () => {
  assert.equal(
    parseChatWorkflowHttpInput({ workflow: "planning-execution" }, defaults).workflow,
    "planning-execution",
  );
  assert.equal(
    parseChatWorkflowHttpInput({ workflow: "memory" }, defaults).workflow,
    "memory",
  );
  assert.equal(
    parseChatWorkflowHttpInput({ workflow: "rule-management" }, defaults).workflow,
    "rule-management",
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

test("request Agent selections remain turn adjustments instead of merging server defaults", () => {
  const configuredDefaults = {
    ...defaults,
    workflow: "planning-execution",
    agentConfigs: {
      planner: { promptFiles: ["/defaults/planner.md"] },
      "pi-coding-agent": { append: ["/defaults/coding.json"] },
    },
  };
  assert.deepEqual(
    parseChatWorkflowHttpInput({
      agentConfigs: { planner: { promptFiles: ["/request/planner.md"] } },
    }, configuredDefaults),
    {
      cwd: configuredDefaults.cwd,
      prompt: configuredDefaults.prompt,
      workflow: configuredDefaults.workflow,
      agentConfigs: {
        planner: { promptFiles: ["/request/planner.md"] },
      },
    },
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

const VALID_IMAGE = {
  type: "image",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  mimeType: "image/png",
};

test("image attachments flow through the direct-execution Workflow", () => {
  const parsed = parseChatWorkflowHttpInput(
    { prompt: "看这张图", images: [VALID_IMAGE] },
    defaults,
  );
  assert.deepEqual(parsed.images, [VALID_IMAGE]);
});

test("an image-only message does not require a text prompt", () => {
  const parsed = parseChatWorkflowHttpInput({ prompt: "", images: [VALID_IMAGE] }, defaults);
  assert.equal(parsed.prompt, "");
  assert.deepEqual(parsed.images, [VALID_IMAGE]);
});

test("Workflows without image support reject image input with a friendly error", () => {
  assert.throws(
    () => parseChatWorkflowHttpInput(
      { workflow: "planning-execution", prompt: "看这张图", images: [VALID_IMAGE] },
      defaults,
    ),
    /planning-execution暂不支持图片输入/,
  );
});

test("malformed image attachments are rejected at the HTTP boundary", () => {
  assert.throws(
    () => parseChatWorkflowHttpInput({ prompt: "x", images: [{ type: "file", data: VALID_IMAGE.data, mimeType: "image/png" }] }, defaults),
    /\.type必须是image/,
  );
  assert.throws(
    () => parseChatWorkflowHttpInput({ prompt: "x", images: [{ type: "image", data: "not-base64", mimeType: "image/png" }] }, defaults),
    /有效的base64/,
  );
  assert.throws(
    () => parseChatWorkflowHttpInput({ prompt: "x", images: [{ type: "image", data: VALID_IMAGE.data, mimeType: "text/plain" }] }, defaults),
    /image\/\*/,
  );
});
