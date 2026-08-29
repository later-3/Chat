import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatAgentCustomInstructions,
  parseWorkflowAgentDefinition,
} from "./agent-definition.ts";

test("Agent custom instructions use one explicit Chat-owned System Prompt region", () => {
  assert.equal(buildChatAgentCustomInstructions([]), undefined);
  assert.equal(
    buildChatAgentCustomInstructions([{ text: " first rule " }, { text: "" }, { text: "second rule" }]),
    [
      "<chat_agent_custom_instructions>",
      "first rule\n\nsecond rule",
      "</chat_agent_custom_instructions>",
    ].join("\n"),
  );
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
