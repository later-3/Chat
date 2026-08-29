import assert from "node:assert/strict";
import test from "node:test";
import { projectAgentSessionEvent } from "./chat-run-events.ts";

test("projects message deltas without repeating the full partial message", () => {
  const event = projectAgentSessionEvent({
    type: "message_update",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      provider: "test",
      model: "test",
      api: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    },
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "o",
      partial: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        provider: "test",
        model: "test",
        api: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
      },
    },
  });

  assert.deepEqual(event, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "o" },
  });
});

test("projects tool lifecycle metadata without duplicating full tool results", () => {
  assert.deepEqual(projectAgentSessionEvent({
    type: "tool_execution_end",
    toolCallId: "tool-1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "large result" }], details: {} },
    isError: false,
  }), {
    type: "tool_execution_end",
    toolCallId: "tool-1",
    toolName: "bash",
    isError: false,
  });
});
