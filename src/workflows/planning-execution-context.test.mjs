import assert from "node:assert/strict";
import test from "node:test";
import {
  injectPlanningExecutionContext,
  stripLegacyPlanningHandoffs,
} from "./planning-execution-context.ts";

test("legacy persisted handoffs are removed before the model sees Session history", () => {
  const messages = [
    { role: "user", content: "real request", timestamp: 1 },
    {
      role: "custom",
      customType: "planning-execution-handoff",
      content: "old internal handoff",
      display: false,
      timestamp: 2,
    },
  ];

  assert.deepEqual(stripLegacyPlanningHandoffs(messages), [messages[0]]);
});

test("current user request and plan are inserted for one model call without mutating Session messages", () => {
  const messages = [
    { role: "user", content: "earlier request", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "text", text: "earlier answer" }],
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    },
    { role: "user", content: "current request", timestamp: 3 },
  ];

  const transformed = injectPlanningExecutionContext(
    messages,
    "current request",
    "current plan",
    "invocation-1",
  );

  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "user"]);
  assert.deepEqual(transformed.map((message) => message.role), ["user", "assistant", "custom", "user"]);
  assert.match(transformed[2].content, /"userRequest": "current request"/);
  assert.match(transformed[2].content, /"plannerOutput": "current plan"/);
  assert.match(transformed[2].content, /current plan/);
  assert.equal(transformed[3], messages[2]);
});
