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
import { createLifeosTraceTool, LIFEOS_TRACE_TOOL } from "../src/trace-tool.ts";

async function collect(source: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return chunks;
}

test("Pi tool intent/result becomes a native DSH tool call with durable display cursor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-trajectory-"));
  const productRunId = "run_trajectory1";
  const running = { productRunId, status: "executing" } as unknown as ChatRun;
  const chat = {
    submitFirstMessageFromDispatch: async () => ({
      session: { sessionId: "psn_trajectory1" },
      message: { messageId: "msg_trajectoryuser1", sessionId: "psn_trajectory1" },
      run: running,
    }),
    getRun: async () => running,
    getExecutionTrace: async (_runId: string, afterSequence: number) =>
      afterSequence === 0
        ? {
            schemaVersion: "chat-execution-trace.v1",
            productRunId,
            items: [
              {
                sequence: 1,
                timestamp: "2026-08-18T00:00:00.000Z",
                type: "tool_call",
                toolCallId: "call_bash_1",
                toolName: "bash",
                input: '{"command":"pnpm test","path":"."}',
                inputTruncated: false,
              },
            ],
            nextCursor: 1,
            hasMore: false,
          }
        : {
            schemaVersion: "chat-execution-trace.v1",
            productRunId,
            items: [
              {
                sequence: 2,
                timestamp: "2026-08-18T00:00:01.000Z",
                type: "tool_result",
                toolCallId: "call_bash_1",
                toolName: "bash",
                outcome: "success",
                output: "42 tests passed",
                outputTruncated: false,
                durationMs: 1000,
              },
            ],
            nextCursor: 2,
            hasMore: false,
          },
  } as unknown as ChatProductClient;
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const adapter = new LifeosLlmAdapter(chat, state);
    const input: GenerateOptions = {
      provider: "lifeos",
      model: "workflow",
      sessionId: "dsh-trajectory" as never,
      tools: [{ name: LIFEOS_TRACE_TOOL, description: "display", parameters: {} }],
      messages: [
        createUserMessage({
          source: { kind: "user" },
          content: [{ type: "text", text: "执行并展示过程" }],
        }),
      ],
    };
    const chunks = await collect(adapter.stream(input));
    assert.deepEqual(
      chunks.map((chunk) => chunk.type),
      ["block-start", "tool-call-delta", "block-end", "finish"],
    );
    const end = chunks.find((chunk) => chunk.type === "block-end");
    assert.equal(end?.type, "block-end");
    assert.equal(end?.block.type, "tool-call");
    if (end?.type !== "block-end" || end.block.type !== "tool-call") {
      throw new Error("missing trajectory tool call");
    }
    assert.equal(end.block.name, LIFEOS_TRACE_TOOL);
    const args = JSON.parse(end.block.arguments) as Record<string, unknown>;
    assert.equal(args.toolName, "bash");
    assert.match(String(args.input), /pnpm test/);

    const tool = createLifeosTraceTool(chat, state);
    const result = await tool.execute(args, {
      agent: { id: "dsh-trajectory" },
      signal: new AbortController().signal,
    } as never);
    assert.deepEqual(result, {
      toolName: "bash",
      outcome: "success",
      output: "42 tests passed",
      outputTruncated: false,
      durationMs: 1000,
    });
    const binding = await state.readSession("dsh-trajectory");
    const request =
      binding?.currentRequestKey === undefined
        ? undefined
        : binding.requests[binding.currentRequestKey];
    assert.equal(request?.traceCursor, 1);
    assert.equal(tool.presentCall?.(args)?.card, "terminal");
    assert.deepEqual(
      tool.presentCall?.({
        ...args,
        toolCallId: "memory-node:wnr_memoryquery1",
        toolName: "memory_query",
        input: '{"operation":"memory.query","summary":"正在查询Memory"}',
      }),
      {
        card: "generic",
        title: "Memory · 查询",
        kind: "read",
        description: "Chat Workflow · 可审计节点",
      },
    );
    assert.deepEqual(
      tool.presentResult?.(
        {
          ...args,
          toolCallId: "memory-node:wnr_memoryquery1",
          toolName: "memory_query",
          input: '{"operation":"memory.query","summary":"正在查询Memory"}',
        },
        { content: [{ type: "text", text: "Memory查询完成，冻结2条快照" }] } as never,
      ),
      {
        card: "generic",
        title: "Memory · 查询结果",
        content: [{ type: "text", text: "Memory查询完成，冻结2条快照" }],
      },
    );
    assert.deepEqual(
      tool.presentCall?.({
        ...args,
        toolCallId: "memory-node:wnr_memorywrite1",
        toolName: "memory_write",
        input: '{"operation":"memory.write","summary":"正在写入Memory"}',
      }),
      {
        card: "generic",
        title: "Memory · 写入",
        kind: "edit",
        description: "Chat Workflow · 可审计节点",
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Memory write execution trace becomes a native DSH tool call and safe result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-memory-trajectory-"));
  const productRunId = "run_memorytrajectory1";
  const running = { productRunId, status: "executing" } as unknown as ChatRun;
  const chat = {
    submitFirstMessageFromDispatch: async () => ({
      session: { sessionId: "psn_memorytrajectory1" },
      message: {
        messageId: "msg_memorytrajectoryuser1",
        sessionId: "psn_memorytrajectory1",
      },
      run: running,
    }),
    getRun: async () => running,
    getExecutionTrace: async (_runId: string, afterSequence: number) =>
      afterSequence === 0
        ? {
            schemaVersion: "chat-execution-trace.v1",
            productRunId,
            items: [
              {
                sequence: 1,
                timestamp: "2026-08-19T00:00:00.000Z",
                type: "tool_call",
                toolCallId: "memory-node:wnr_memorywrite1",
                toolName: "memory_write",
                input: '{"operation":"memory.write","summary":"正在保存本次输入到Memory Provider"}',
                inputTruncated: false,
              },
            ],
            nextCursor: 1,
            hasMore: false,
          }
        : {
            schemaVersion: "chat-execution-trace.v1",
            productRunId,
            items: [
              {
                sequence: 2,
                timestamp: "2026-08-19T00:00:01.000Z",
                type: "tool_result",
                toolCallId: "memory-node:wnr_memorywrite1",
                toolName: "memory_write",
                outcome: "success",
                output: "本次输入已写入并可查询",
                outputTruncated: false,
                durationMs: 20,
              },
            ],
            nextCursor: 2,
            hasMore: false,
          },
  } as unknown as ChatProductClient;
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const adapter = new LifeosLlmAdapter(chat, state);
    const chunks = await collect(
      adapter.stream({
        provider: "lifeos",
        model: "workflow",
        sessionId: "dsh-memory-trajectory" as never,
        tools: [{ name: LIFEOS_TRACE_TOOL, description: "display", parameters: {} }],
        messages: [
          createUserMessage({
            source: { kind: "user" },
            content: [{ type: "text", text: "写入并展示Memory节点" }],
          }),
        ],
      }),
    );
    const end = chunks.find((chunk) => chunk.type === "block-end");
    if (end?.type !== "block-end" || end.block.type !== "tool-call") {
      throw new Error("missing memory trajectory tool call");
    }
    const args = JSON.parse(end.block.arguments) as Record<string, unknown>;
    assert.equal(end.block.name, LIFEOS_TRACE_TOOL);
    assert.equal(args.toolName, "memory_write");
    assert.equal(args.toolCallId, "memory-node:wnr_memorywrite1");
    assert.doesNotMatch(JSON.stringify(args), /Memory正文绝不能进入Trajectory/u);

    const tool = createLifeosTraceTool(chat, state);
    assert.deepEqual(
      await tool.execute(args, {
        agent: { id: "dsh-memory-trajectory" },
        signal: new AbortController().signal,
      } as never),
      {
        toolName: "memory_write",
        outcome: "success",
        output: "本次输入已写入并可查询",
        outputTruncated: false,
        durationMs: 20,
      },
    );
    assert.deepEqual(tool.presentCall?.(args), {
      card: "generic",
      title: "Memory · 写入",
      kind: "edit",
      description: "Chat Workflow · 可审计节点",
    });
    assert.deepEqual(
      tool.presentResult?.(args, {
        content: [{ type: "text", text: "本次输入已写入并可查询" }],
      } as never),
      {
        card: "generic",
        title: "Memory · 写入结果",
        content: [{ type: "text", text: "本次输入已写入并可查询" }],
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
