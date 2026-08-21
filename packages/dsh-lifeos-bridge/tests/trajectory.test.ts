import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createUserMessage, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { LifeosLlmAdapter } from "../src/adapter.ts";
import type { ChatProductClient } from "../src/chat-client.ts";
import type { ChatRun } from "../src/contracts.ts";
import { AtomicBridgeStateStore } from "../src/state-store.ts";

async function collect(source: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return chunks;
}

test("远端Workflow轨迹不再伪造成DSH原生工具调用", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-trajectory-"));
  const productRunId = "run_trajectory1";
  const running = { productRunId, status: "executing" } as unknown as ChatRun;
  const succeeded = {
    productRunId,
    status: "succeeded",
    finalMessageId: "msg_trajectoryassistant1",
  } as unknown as ChatRun;
  let reads = 0;
  const chat = {
    submitFirstMessageFromDispatch: async () => ({
      session: { sessionId: "psn_trajectory1" },
      message: { messageId: "msg_trajectoryuser1", sessionId: "psn_trajectory1" },
      run: running,
    }),
    getRun: async () => (++reads >= 1 ? succeeded : running),
    getMessage: async () => ({
      messageId: "msg_trajectoryassistant1",
      role: "assistant",
      content: { text: "已完成" },
    }),
  } as unknown as ChatProductClient;
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const adapter = new LifeosLlmAdapter(chat, state);
    const input: GenerateOptions = {
      provider: "lifeos",
      model: "workflow",
      sessionId: "dsh-trajectory" as never,
      // 即使旧Session仍带有历史工具定义，Adapter也不能再生成显示代理调用。
      tools: [{ name: "lifeos_trace", description: "legacy", parameters: {} }],
      messages: [
        createUserMessage({
          source: { kind: "user" },
          content: [{ type: "text", text: "执行并展示过程" }],
        }),
      ],
    };
    const chunks = await collect(adapter.stream(input));
    assert.equal(
      chunks.some((chunk) => chunk.type === "tool-call-delta"),
      false,
    );
    assert.equal(
      chunks.some(
        (chunk) =>
          chunk.type === "block-end" &&
          chunk.block.type === "text" &&
          chunk.block.text === "已完成",
      ),
      true,
    );
    const binding = await state.readSession("dsh-trajectory");
    const request =
      binding?.currentRequestKey === undefined
        ? undefined
        : binding.requests[binding.currentRequestKey];
    assert.equal(request?.traceCursor, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
