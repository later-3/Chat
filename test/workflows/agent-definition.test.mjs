import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatSystemPromptSections,
  parseWorkflowAgentDefinition,
} from "../../src/workflows/agent-definition.ts";

test("Agent custom instructions use one explicit Chat-owned System Prompt region", () => {
  assert.equal(buildChatSystemPromptSections([]), undefined);
  assert.equal(
    buildChatSystemPromptSections([{ text: " first rule " }, { text: "" }, { text: "second rule" }]),
    [
      "<chat_agent_custom_instructions>",
      "first rule\n\nsecond rule",
      "</chat_agent_custom_instructions>",
    ].join("\n"),
  );
});

test("交互 harness 是与自定义指令并列的独立区域，不嵌套在其内部", () => {
  const sections = buildChatSystemPromptSections([
    { text: "first rule" },
    { text: '<chat_interaction_harness revision="sha256:abc">规范正文</chat_interaction_harness>' },
  ]);
  assert.equal(sections, [
    "<chat_agent_custom_instructions>",
    "first rule",
    "</chat_agent_custom_instructions>",
    "",
    '<chat_interaction_harness revision="sha256:abc">规范正文</chat_interaction_harness>',
  ].join("\n"));
  assert.equal(sections.indexOf("</chat_agent_custom_instructions>") < sections.indexOf("<chat_interaction_harness"), true,
    "交互 harness 位于自定义指令区域之外");
});

test("Agent definition parser rejects unsupported data instead of guessing", () => {
  assert.throws(
    () => parseWorkflowAgentDefinition({ schemaVersion: 2 }),
    /schemaVersion 1/,
  );
  assert.throws(
    () => parseWorkflowAgentDefinition({
      schemaVersion: 1,
      id: "agent",
      name: "Agent",
      description: "Agent description",
      systemPrompt: { mode: "replace", text: "" },
      customInstructions: [],
      tools: { mode: "pi-default" },
    }),
    /systemPrompt\.text/,
  );
});
