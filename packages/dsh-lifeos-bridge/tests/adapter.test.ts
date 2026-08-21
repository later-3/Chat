import assert from "node:assert/strict";
import test from "node:test";
import { createUserMessage, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import {
  captureDshAdapterRequest,
  dshAdapterRequestTraceOf,
  LifeosLlmAdapter,
  sha256,
  workspaceInstructionsOf,
} from "../src/adapter.ts";
import type { ChatProductClient } from "../src/chat-client.ts";
import { exactSectionsFromJson, valueAtJsonPointer } from "../src/dsh-bridge-readable.ts";
import type { AtomicBridgeStateStore } from "../src/state-store.ts";

function options(purpose: "session-title" | "compaction", text: string): GenerateOptions {
  return {
    provider: "lifeos",
    model: "workflow",
    purpose,
    messages: [
      createUserMessage({
        source: { kind: "user" },
        content: [{ type: "text", text }],
      }),
    ],
  };
}

async function collect(adapter: LifeosLlmAdapter, input: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of adapter.stream(input)) chunks.push(chunk);
  return chunks;
}

function auxiliaryAdapter(): { adapter: LifeosLlmAdapter; accesses: () => number } {
  let count = 0;
  const inaccessible = new Proxy(
    {},
    {
      get() {
        count += 1;
        throw new Error("auxiliary generation touched Chat or bridge state");
      },
    },
  );
  return {
    adapter: new LifeosLlmAdapter(
      inaccessible as ChatProductClient,
      inaccessible as AtomicBridgeStateStore,
    ),
    accesses: () => count,
  };
}

function streamedText(chunks: readonly StreamChunk[]): string {
  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ["block-start", "text-delta", "block-end", "finish"],
  );
  const delta = chunks[1];
  const end = chunks[2];
  assert.equal(delta?.type, "text-delta");
  assert.equal(end?.type, "block-end");
  if (delta?.type !== "text-delta" || end?.type !== "block-end") throw new Error("invalid stream");
  assert.equal(end.block.type, "text");
  if (end.block.type !== "text") throw new Error("invalid final block");
  assert.equal(delta.text, end.block.text);
  return delta.text;
}

test("DSH adapter request capture freezes the fully assembled request but excludes AbortSignal", () => {
  const signal = new AbortController().signal;
  const captured = captureDshAdapterRequest({
    provider: "lifeos",
    model: "workflow",
    reasoningEffort: "off" as never,
    sessionId: "dsh-capture" as never,
    system: "真实 System Prompt",
    messages: [
      createUserMessage({
        source: { kind: "user" },
        content: [{ type: "text", text: "真实用户输入" }],
      }),
    ],
    tools: [{ name: "read", description: "读取文件", parameters: { type: "object" } }],
    temperature: 0.2,
    maxTokens: 4_096,
    stop: ["<END>"],
    signal,
  });
  assert.equal(captured.status, "captured");
  if (captured.status !== "captured") throw new Error("expected captured request");
  assert.equal(captured.requestSha256, sha256(captured.requestJson));
  const raw = JSON.parse(captured.requestJson) as Record<string, unknown>;
  assert.equal(raw["system"], "真实 System Prompt");
  assert.deepEqual(raw["tools"], [
    { name: "read", description: "读取文件", parameters: { type: "object" } },
  ]);
  assert.equal(raw["temperature"], 0.2);
  assert.equal(raw["maxTokens"], 4_096);
  assert.equal(raw["signal"], undefined);
  assert.match(captured.requestJson, /真实用户输入/u);

  const sections = exactSectionsFromJson(captured.requestJson);
  assert.deepEqual(
    sections.map((section) => section.jsonPointer),
    [
      "/provider",
      "/model",
      "/reasoningEffort",
      "/sessionId",
      "/system",
      "/messages/0",
      "/tools/0",
      "/temperature",
      "/maxTokens",
      "/stop",
    ],
  );
  for (const section of sections) {
    assert.deepEqual(
      JSON.parse(section.valueJson),
      valueAtJsonPointer(captured.requestJson, section.jsonPointer),
    );
  }
  const trace = dshAdapterRequestTraceOf(captured);
  assert.equal(trace.requestSha256, captured.requestSha256);
  assert.deepEqual(trace.lastUserInput?.textJsonPointers, ["/messages/0/content/0/text"]);
  assert.equal(trace.lastUserInput?.textSha256, sha256("真实用户输入"));
  assert.equal(trace.sections.length, sections.length);
  assert.deepEqual(
    trace.sections.map((section) => section.jsonPointer),
    sections.map((section) => section.jsonPointer),
  );
  assert.doesNotMatch(JSON.stringify(trace), /真实 System Prompt|真实用户输入/u);
});

test("session-title is a bounded local StreamChunk sequence with zero Chat access", async () => {
  const { adapter, accesses } = auxiliaryAdapter();
  const title = streamedText(
    await collect(adapter, options("session-title", `  第一行\n第二行 ${"很长".repeat(80)}  `)),
  );
  assert.equal(accesses(), 0);
  assert.doesNotMatch(title, /\n/);
  assert.ok(Array.from(title).length <= 72);
});

test("compaction summarizes bounded visible text locally with zero Chat access", async () => {
  const { adapter, accesses } = auxiliaryAdapter();
  const summary = streamedText(
    await collect(adapter, options("compaction", `用户可见内容 ${"片段".repeat(4_000)}`)),
  );
  assert.equal(accesses(), 0);
  assert.ok(Array.from(summary).length <= 6_000);
  assert.match(summary, /仅整理当前可见文本/);
  assert.match(summary, /不包含隐藏推理/);
  assert.match(summary, /用户可见内容/);
});

test("DSH agent-instructions remain a typed local audit projection", () => {
  const messages = [
    createUserMessage({
      source: { kind: "plugin", plugin: "runtime", form: "snapshot", sections: [] },
      content: [{ type: "text", text: "DSH runtime context must stay local" }],
    }),
    createUserMessage({
      source: { kind: "agent-instructions", form: "instructions" } as never,
      content: [{ type: "text", text: "# Root AGENTS\n中文回复" }],
    }),
    createUserMessage({
      source: { kind: "agent-instructions", form: "instructions" } as never,
      content: [{ type: "text", text: "# Nested AGENTS\n先运行测试" }],
    }),
    createUserMessage({
      source: { kind: "user" },
      content: [{ type: "text", text: "实现功能" }],
    }),
  ];

  assert.deepEqual(workspaceInstructionsOf(messages), {
    schemaVersion: "workspace-instructions-input.v1",
    items: [{ content: "# Root AGENTS\n中文回复" }, { content: "# Nested AGENTS\n先运行测试" }],
  });
});
