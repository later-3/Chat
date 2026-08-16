import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createUserMessage,
  LlmError,
  resolveRetryPolicy,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { LifeosLlmAdapter } from "../src/adapter.ts";
import { ChatProductApiError, type ChatProductClient } from "../src/chat-client.ts";
import type { ChatRun } from "../src/contracts.ts";
import { AtomicBridgeStateStore } from "../src/state-store.ts";

test("plugin lifetime abort stops a waiting_human stream before another poll", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-lifetime-"));
  const lifetime = new AbortController();
  let submittedResolve!: () => void;
  const submitted = new Promise<void>((resolve) => {
    submittedResolve = resolve;
  });
  let runPolls = 0;
  const waitingRun = {
    productRunId: "run_lifetime1",
    status: "waiting_human",
  } as ChatRun;
  const chat = {
    createSession: async () => ({ sessionId: "psn_lifetime1" }),
    submitMessage: async () => {
      submittedResolve();
      return { message: {}, run: waitingRun };
    },
    getRun: async () => {
      runPolls += 1;
      return waitingRun;
    },
  } as unknown as ChatProductClient;
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const adapter = new LifeosLlmAdapter(chat, state, lifetime.signal);
    const input: GenerateOptions = {
      provider: "lifeos",
      model: "workflow",
      sessionId: "dsh-lifetime" as never,
      messages: [
        createUserMessage({
          source: { kind: "user" },
          content: [{ type: "text", text: "等待审批" }],
        }),
      ],
    };
    const first = adapter.stream(input)[Symbol.asyncIterator]().next();
    await submitted;
    lifetime.abort(new DOMException("plugin unloaded", "AbortError"));
    await assert.rejects(first, (error) => error instanceof LlmError && error.code === "ABORTED");
    await new Promise<void>((resolve) => setTimeout(resolve, 800));
    assert.equal(runPolls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retryable Chat transport failure maps to the rc.6 retry policy code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-retry-code-"));
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const chat = {
      createSession: async () => {
        throw new ChatProductApiError(
          503,
          "chat_api_unreachable",
          true,
          "retry_same_command",
          "Chat API is unreachable",
        );
      },
    } as unknown as ChatProductClient;
    const adapter = new LifeosLlmAdapter(chat, state);
    const first = adapter
      .stream({
        provider: "lifeos",
        model: "workflow",
        sessionId: "dsh-retry" as never,
        messages: [
          createUserMessage({
            source: { kind: "user" },
            content: [{ type: "text", text: "安全重试" }],
          }),
        ],
      })
      [Symbol.asyncIterator]()
      .next();
    await assert.rejects(first, (error) => error instanceof LlmError && error.code === "TRANSPORT");
    const policy = resolveRetryPolicy(undefined, "lifeos-test");
    assert.equal(policy.mode, "normal");
    if (policy.mode !== "normal") throw new Error("unexpected rc.6 retry policy");
    assert.ok(policy.retryableCodes.includes("TRANSPORT"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rc.6 retry of the same turn reuses command identity and returns the committed message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-retry-turn-"));
  const createCommands: string[] = [];
  let attempts = 0;
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const chat = {
      createSession: async (commandId: string) => {
        createCommands.push(commandId);
        attempts += 1;
        if (attempts === 1) {
          throw new ChatProductApiError(
            503,
            "chat_api_unreachable",
            true,
            "retry_same_command",
            "Chat API is unreachable",
          );
        }
        return { sessionId: "psn_retryturn1" };
      },
      submitMessage: async () => ({
        message: {},
        run: {
          productRunId: "run_retryturn1",
          status: "succeeded",
          finalMessageId: "msg_retryturn1",
        } as ChatRun,
      }),
      getMessage: async () => ({
        messageId: "msg_retryturn1",
        role: "assistant",
        content: { format: "markdown", text: "恢复成功" },
      }),
    } as unknown as ChatProductClient;
    const adapter = new LifeosLlmAdapter(chat, state);
    const input: GenerateOptions = {
      provider: "lifeos",
      model: "workflow",
      sessionId: "dsh-retry-turn" as never,
      messages: [
        createUserMessage({
          source: { kind: "user" },
          content: [{ type: "text", text: "同一轮恢复" }],
        }),
      ],
    };
    const first = adapter.stream(input)[Symbol.asyncIterator]().next();
    await assert.rejects(first, (error) => error instanceof LlmError && error.code === "TRANSPORT");

    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream(input)) chunks.push(chunk);
    assert.equal(createCommands.length, 2);
    assert.equal(createCommands[0], createCommands[1]);
    const delta = chunks.find((chunk) => chunk.type === "text-delta");
    assert.equal(delta?.type === "text-delta" ? delta.text : undefined, "恢复成功");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
