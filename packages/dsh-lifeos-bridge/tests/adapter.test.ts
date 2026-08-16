import assert from "node:assert/strict";
import test from "node:test";
import { createUserMessage, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { LifeosLlmAdapter } from "../src/adapter.ts";
import type { ChatProductClient } from "../src/chat-client.ts";
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
