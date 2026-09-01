import assert from "node:assert/strict";
import test from "node:test";
import {
  injectPlanningRevisionContext,
  stripLegacyPlanningHandoffs,
} from "./context.ts";

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

test("revision instructions are model-facing while persisted feedback remains the latest native user", () => {
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
    { role: "user", content: "keep the Hook and add rollback", timestamp: 3 },
  ];

  const transformed = injectPlanningRevisionContext(messages, {
    invocationId: "invocation-1",
    planRevision: 2,
    previousPlan: "earlier answer",
  });

  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "user"]);
  assert.deepEqual(transformed.map((message) => message.role), ["user", "assistant", "custom", "user"]);
  assert.match(transformed[2].content, /第2版计划/);
  assert.match(transformed[2].content, /<previous_plan>\nearlier answer/);
  assert.equal(transformed[3], messages[2]);
});
