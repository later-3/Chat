import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_DSH_CONTEXT_INJECTION_ITEMS,
  MAX_DSH_CONTEXT_INJECTION_TEXT_CHARS,
  MAX_DSH_CONTEXT_SOURCE_DETAILS,
  dshContextInjectionProjectionSchema,
} from "../src/contracts.ts";
import { DshContextInjectionReader } from "../src/context-injection-reader.ts";

function message(
  id: string,
  role: string,
  source: unknown,
  content: readonly unknown[] = [{ type: "text", text: id }],
) {
  return { id, role, source, content };
}

test("blank DSH session reports that context has not been assembled yet", () => {
  const reader = new DshContextInjectionReader({
    get: () => ({ events: [], deriveMessages: () => [] }),
  });
  const projection = reader.read("dsh-session-blank");
  assert.ok(projection !== null);
  assert.equal(projection.status, "not_assembled");
  assert.equal(projection.chatForwarding, "not_forwarded");
  assert.deepEqual(projection.items, []);
  assert.match(projection.revision, /^[a-f0-9]{64}$/u);
  assert.deepEqual(dshContextInjectionProjectionSchema.parse(projection), projection);
});

test("reader projects only producer context from the current derived model surface", () => {
  const reader = new DshContextInjectionReader({
    get: () => ({
      events: [{ type: "user/message" }, { type: "step/start" }],
      deriveMessages: () => [
        message("direct-user", "user", { kind: "user" }, [{ type: "text", text: "你好" }]),
        message("assistant", "assistant", {
          kind: "model",
          provider: "lifeos",
          model: "workflow",
        }),
        message("tool", "user", { kind: "tool", callId: "call-1" }),
        message("compaction", "user", { kind: "plugin", plugin: "compact" }),
        message(
          "instructions",
          "user",
          {
            kind: "agent-instructions",
            form: "instructions",
            changes: [
              { path: "/repo/AGENTS.md", action: "add" },
              { path: "/repo/packages/AGENTS.md", action: "add" },
            ],
          },
          [{ type: "text", text: "workspace rules" }],
        ),
        message(
          "runtime",
          "user",
          {
            kind: "plugin",
            plugin: "@deepseek-ai/dsh-system-prompt",
            form: "snapshot",
            sections: [{ name: "permissions", text: "private" }],
          },
          [{ type: "text", text: "runtime context" }],
        ),
        message(
          "catalog",
          "user",
          {
            kind: "skill-catalog",
            form: "catalog",
            entries: [
              { name: "openai-docs", description: "OpenAI docs" },
              { name: "pdf", description: "PDF" },
            ],
          },
          [{ type: "text", text: "available skills" }],
        ),
        message("future", "user", { kind: "future-context", form: "future-form" }),
      ],
    }),
  });

  const projection = reader.read("dsh-session-1");
  assert.ok(projection !== null);
  assert.equal(projection.status, "ready");
  assert.equal(projection.totalItems, 4);
  assert.equal(projection.omittedItems, 0);
  assert.deepEqual(
    projection.items.map((item) => item.messageId),
    ["instructions", "runtime", "catalog", "future"],
  );
  assert.deepEqual(projection.items[0]?.sourceDetails, [
    "/repo/AGENTS.md",
    "/repo/packages/AGENTS.md",
  ]);
  assert.deepEqual(projection.items[1]?.sourceDetails, ["permissions"]);
  assert.deepEqual(projection.items[2]?.sourceDetails, ["openai-docs", "pdf"]);
  assert.equal(projection.items[3]?.form, null);
  assert.equal(projection.totalContentCharacters, 52);
});

test("a completed DSH pre-step with no context is ready rather than blank", () => {
  const reader = new DshContextInjectionReader({
    get: () => ({ events: [{ type: "step/start" }], deriveMessages: () => [] }),
  });
  assert.equal(reader.read("dsh-session-empty")?.status, "ready");
});

test("reader bounds bodies, source metadata, and long active histories", () => {
  const details = Array.from({ length: MAX_DSH_CONTEXT_SOURCE_DETAILS + 3 }, (_, index) => ({
    name: `section-${index}`,
  }));
  const messages = Array.from({ length: MAX_DSH_CONTEXT_INJECTION_ITEMS + 2 }, (_, index) =>
    message(`context-${index}`, "user", {
      kind: "plugin",
      plugin: "fixture",
      form: "catalog",
    }),
  );
  messages.push(
    message(
      "large-context",
      "user",
      { kind: "plugin", plugin: "fixture", form: "snapshot", sections: details },
      [
        { type: "text", text: "x".repeat(MAX_DSH_CONTEXT_INJECTION_TEXT_CHARS + 5) },
        { type: "image", attachment: { id: "image-1" } },
      ],
    ),
  );
  const reader = new DshContextInjectionReader({
    get: () => ({ events: [{ type: "step/start" }], deriveMessages: () => messages }),
  });

  const projection = reader.read("dsh-session-large");
  assert.ok(projection !== null);
  assert.equal(projection.totalItems, MAX_DSH_CONTEXT_INJECTION_ITEMS + 3);
  assert.equal(projection.items.length, MAX_DSH_CONTEXT_INJECTION_ITEMS);
  assert.equal(projection.omittedItems, 3);
  assert.equal(projection.items[0]?.messageId, "context-3");
  const last = projection.items.at(-1);
  assert.equal(last?.messageId, "large-context");
  assert.equal(last?.text.length, MAX_DSH_CONTEXT_INJECTION_TEXT_CHARS);
  assert.equal(last?.contentCharacters, MAX_DSH_CONTEXT_INJECTION_TEXT_CHARS + 5);
  assert.equal(last?.truncated, true);
  assert.equal(last?.unsupportedContentBlockCount, 1);
  assert.equal(last?.sourceDetails.length, MAX_DSH_CONTEXT_SOURCE_DETAILS);
  assert.equal(last?.sourceDetailsTruncated, true);
});

test("unknown DSH session stays distinct from an unassembled live session", () => {
  const reader = new DshContextInjectionReader({ get: () => undefined });
  assert.equal(reader.read("missing-session"), null);
});
