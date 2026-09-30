import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createPromptCaptureRecorder,
  hasPromptCaptures,
  parseProviderPayloadRegions,
  purgePromptCaptures,
  readPromptCaptureIndex,
  readPromptCapturePayload,
} from "../src/session-prompt-capture.ts";

test("openai-completions payloads decompose into managed regions", () => {
  const payload = {
    model: "debug-model",
    messages: [
      { role: "system", content: "Pi base rules\n\n<chat_current_project>\n项目上下文\n</chat_current_project>\n\n<chat_agent_custom_instructions>\n规则正文\n</chat_agent_custom_instructions>" },
      { role: "user", content: "当前Workflow=minimal-pi-coding-agent，本轮Invocation=i-1。" },
      { role: "user", content: "帮我看看这个项目" },
      { role: "assistant", content: "上一轮回答" },
      { role: "tool", content: "工具输出" },
    ],
    tools: [
      { function: { name: "read", description: "Read a file", parameters: { type: "object" } } },
      { function: { name: "workflow_call", parameters: {} } },
    ],
  };
  const neutral = [
    { role: "custom", customType: "chat.workflow_turn_context", timestamp: 1 },
    { role: "user", timestamp: 2 },
    { role: "assistant", timestamp: 3 },
    { role: "toolResult", timestamp: 4 },
  ];
  const regions = parseProviderPayloadRegions(payload, "openai-completions", neutral);
  assert.equal(regions.parsed, true);
  // System prompt: sections are split by the Chat-owned tags
  assert.equal(regions.systemPrompt.chars, payload.messages[0].content.length);
  assert.deepEqual(regions.systemPrompt.sections.map((section) => section.kind), ["pi-base", "chat-project", "chat-custom-instructions"]);
  // Message regions align 1:1 with the neutral list
  assert.deepEqual(regions.messages.map((message) => message.region), [
    "injected-instruction", "current-user-message", "assistant", "tool-result",
  ]);
  assert.equal(regions.messages[0].customType, "chat.workflow_turn_context");
  assert.equal(regions.tools.length, 2);
  assert.equal(regions.tools[0].name, "read");
});

test("anthropic payloads use the top-level system field and tool results stay classified", () => {
  const payload = {
    system: "base\n<chat_project_collaboration>\n协作\n</chat_project_collaboration>",
    messages: [
      { role: "user", content: "第一轮" },
      { role: "assistant", content: [{ type: "text", text: "回答" }] },
      { role: "user", content: "第二轮" },
    ],
    tools: [{ name: "bash", description: "Run bash", input_schema: {} }],
  };
  const neutral = [
    { role: "user", timestamp: 1 },
    { role: "assistant", timestamp: 2 },
    { role: "user", timestamp: 3 },
  ];
  const regions = parseProviderPayloadRegions(payload, "anthropic-messages", neutral);
  assert.equal(regions.parsed, true);
  assert.equal(regions.systemPrompt.sections.map((section) => section.kind).join(","), "pi-base,chat-collaboration");
  assert.deepEqual(regions.messages.map((message) => message.region), ["history-user", "assistant", "current-user-message"]);
  assert.equal(regions.tools[0].name, "bash");
});

test("unknown provider shapes fail open and keep the payload addressable", () => {
  const regions = parseProviderPayloadRegions({ weird: true }, "some-future-api", undefined);
  assert.equal(regions.parsed, false);
  assert.match(regions.parseError, /some-future-api/);
});

test("records round-trip through the gzip sidecar and index, and purge removes everything", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-prompt-capture-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionId = "01a0test000000000000000000";

  const recorder = createPromptCaptureRecorder({
    sessionDir,
    storageProjectId: "chat",
    sessionId,
    turn: { source: "workflow", workflowId: "minimal-pi-coding-agent", workflowInvocationId: "inv-1", stageId: "execute", turnKey: "inv-1:execute" },
    agent: { agentId: "pi-coding-agent", agentName: "Pi Coding Agent" },
  });
  recorder.pushNeutralContext([
    { role: "custom", customType: "chat.workflow_turn_context", content: "指令", timestamp: 1 },
    { role: "user", content: "用户消息", timestamp: 2 },
  ]);
  await recorder.record({ model: "debug-model", messages: [
    { role: "system", content: "系统提示" },
    { role: "user", content: "指令" },
    { role: "user", content: "用户消息" },
  ], tools: [{ function: { name: "read", parameters: {} } }] }, { provider: "debug-local", modelId: "debug-model", api: "openai-completions" });
  // A second request without a neutral snapshot is recorded as a direct stream call.
  await recorder.record({ messages: [{ role: "system", content: "摘要指令" }, { role: "user", content: "摘要" }] }, { provider: "debug-local", modelId: "debug-model", api: "openai-completions" });

  assert.equal(await hasPromptCaptures(sessionDir, sessionId), true);
  const records = await readPromptCaptureIndex(sessionDir, sessionId);
  assert.equal(records.length, 2);
  assert.equal(records[0].kind, "agent");
  assert.equal(records[0].turn.workflowId, "minimal-pi-coding-agent");
  assert.equal(records[0].agent.agentId, "pi-coding-agent");
  assert.equal(records[0].model.provider, "debug-local");
  assert.equal(records[0].regions.messages.length, 2);
  assert.equal(records[0].regions.messages[0].region, "injected-instruction");
  assert.equal(records[1].kind, "direct");
  const payload = await readPromptCapturePayload(sessionDir, sessionId, records[0]);
  assert.equal(payload.messages[2].content, "用户消息");

  await purgePromptCaptures(sessionDir, sessionId);
  assert.equal(await hasPromptCaptures(sessionDir, sessionId), false);
  assert.deepEqual(await readPromptCaptureIndex(sessionDir, sessionId), []);
});
