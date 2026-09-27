import assert from "node:assert/strict";
import test from "node:test";
import { projectAgentSessionEvent } from "../../src/workflows/chat-run-events.ts";

test("turn boundaries, retries and compression reach the frontend without changing Pi lifecycle", () => {
  for (const event of [
    { type: "turn_start" },
    { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "busy" },
    { type: "compaction_start", reason: "threshold" },
    { type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 2, delayMs: 1000, errorMessage: "terminated" },
    { type: "summarization_retry_attempt_start", source: "compaction", reason: "manual" },
    { type: "summarization_retry_finished" },
  ]) assert.deepEqual(projectAgentSessionEvent(event), event);
});

test("compaction feedback keeps native counts and failure while history stays in Session", () => {
  const result = { summary: "large native summary", firstKeptEntryId: "kept", tokensBefore: 48000, estimatedTokensAfter: 8000 };
  assert.deepEqual(projectAgentSessionEvent({ type: "compaction_end", reason: "threshold", result, aborted: false, willRetry: false }), {
    type: "compaction_end", reason: "threshold", aborted: false, willRetry: false,
    result: { tokensBefore: 48000, estimatedTokensAfter: 8000 },
  });
  const failed = { type: "compaction_end", reason: "overflow", aborted: false, willRetry: false, errorMessage: "provider unavailable" };
  assert.deepEqual(projectAgentSessionEvent(failed), failed);
});

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
