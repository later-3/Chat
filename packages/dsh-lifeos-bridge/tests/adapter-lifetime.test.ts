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
import { LifeosLlmAdapter, stableCommandId } from "../src/adapter.ts";
import { ChatProductApiError, type ChatProductClient } from "../src/chat-client.ts";
import {
  promptSelectionRequestSchema,
  workflowSelectionSchema,
  type ChatRun,
} from "../src/contracts.ts";
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
      return { message: { messageId: "msg_lifetimeuser1" }, run: waitingRun };
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
        message: { messageId: "msg_retryturnuser1" },
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

test("unknown submit outcome retries with the originally frozen Workspace instructions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-retry-instructions-"));
  const submittedInstructions: unknown[] = [];
  let submitAttempts = 0;
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const chat = {
      createSession: async () => ({ sessionId: "psn_retryinstructions1" }),
      submitMessage: async (
        _sessionId: string,
        _commandId: string,
        _text: string,
        _signal: AbortSignal | undefined,
        _workflowSelection: unknown,
        workspaceInstructions: unknown,
      ) => {
        submittedInstructions.push(workspaceInstructions);
        submitAttempts += 1;
        if (submitAttempts === 1) {
          throw new ChatProductApiError(
            503,
            "chat_api_unreachable",
            true,
            "retry_same_command",
            "response lost after submit",
          );
        }
        return {
          message: { messageId: "msg_retryinstructionsuser1" },
          run: {
            productRunId: "run_retryinstructions1",
            status: "succeeded",
            finalMessageId: "msg_retryinstructionsassistant1",
          } as ChatRun,
        };
      },
      getMessage: async () => ({
        messageId: "msg_retryinstructionsassistant1",
        role: "assistant",
        content: { format: "markdown", text: "已按原指令恢复" },
      }),
    } as unknown as ChatProductClient;
    const adapter = new LifeosLlmAdapter(chat, state);
    const directUser = createUserMessage({
      source: { kind: "user" },
      content: [{ type: "text", text: "执行同一请求" }],
    });
    const input = (instructions: string): GenerateOptions => ({
      provider: "lifeos",
      model: "workflow",
      sessionId: "dsh-retry-instructions" as never,
      messages: [
        createUserMessage({
          source: { kind: "agent-instructions", form: "instructions" } as never,
          content: [{ type: "text", text: instructions }],
        }),
        directUser,
      ],
    });

    const first = adapter.stream(input("ORIGINAL_AGENTS_CANARY"))[Symbol.asyncIterator]().next();
    await assert.rejects(first, (error) => error instanceof LlmError && error.code === "TRANSPORT");
    const replayChunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream(input("CHANGED_AGENTS_MUST_NOT_REPLACE"))) {
      replayChunks.push(chunk);
    }
    assert.ok(replayChunks.some((chunk) => chunk.type === "finish"));

    assert.deepEqual(submittedInstructions, [
      {
        schemaVersion: "workspace-instructions-input.v1",
        items: [{ content: "ORIGINAL_AGENTS_CANARY" }],
      },
      {
        schemaVersion: "workspace-instructions-input.v1",
        items: [{ content: "ORIGINAL_AGENTS_CANARY" }],
      },
    ]);
    const binding = await state.readSession("dsh-retry-instructions");
    const request =
      binding?.currentRequestKey === undefined
        ? undefined
        : binding.requests[binding.currentRequestKey];
    assert.equal(request?.workspaceInstructions, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown Direct submit outcome retries with the request-frozen Prompt selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-retry-prompt-"));
  const submittedSelections: unknown[] = [];
  let submitAttempts = 0;
  const firstSelection = promptSelectionRequestSchema.shape.promptSelection.parse({
    schemaVersion: "prompt-turn-selection-input.v1" as const,
    workspaceRootId: "root_chat",
    regions: [
      {
        regionKey: "rules",
        mode: "append" as const,
        selected: [{ promptFragmentRevisionId: "pfr_customrulesv1", sha256: "a".repeat(64) }],
      },
    ],
  });
  const secondSelection = promptSelectionRequestSchema.shape.promptSelection.parse({
    ...firstSelection,
    regions: [
      {
        regionKey: "rules",
        mode: "replace" as const,
        selected: [{ promptFragmentRevisionId: "pfr_customrulesv2", sha256: "b".repeat(64) }],
      },
    ],
  });
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const createSessionCommandId = stableCommandId("create-session", "dsh-retry-prompt");
    await state.selectWorkflow(
      "dsh-retry-prompt",
      createSessionCommandId,
      workflowSelectionSchema.parse({
        workflowDefinitionRevisionId: "wfr_systemdirectagentv1",
        definitionSha256: "c".repeat(64),
        title: "执行 Agent",
        blueprintKey: "direct",
      }),
    );
    await state.selectPrompt("dsh-retry-prompt", createSessionCommandId, firstSelection);
    const chat = {
      createSession: async () => ({ sessionId: "psn_retryprompt1" }),
      submitMessage: async (
        _sessionId: string,
        _commandId: string,
        _text: string,
        _signal: AbortSignal | undefined,
        _workflowSelection: unknown,
        _workspaceInstructions: unknown,
        promptSelection: unknown,
      ) => {
        submittedSelections.push(promptSelection);
        submitAttempts += 1;
        if (submitAttempts === 1) {
          throw new ChatProductApiError(
            503,
            "chat_api_unreachable",
            true,
            "retry_same_command",
            "response lost after submit",
          );
        }
        return {
          message: { messageId: "msg_retrypromptuser1" },
          run: {
            productRunId: "run_retryprompt1",
            status: "succeeded",
            finalMessageId: "msg_retrypromptassistant1",
          } as ChatRun,
        };
      },
      getMessage: async () => ({
        messageId: "msg_retrypromptassistant1",
        role: "assistant",
        content: { format: "markdown", text: "已按冻结选择恢复" },
      }),
    } as unknown as ChatProductClient;
    const adapter = new LifeosLlmAdapter(chat, state, undefined, {
      resolve: () => ({ rootId: "root_chat", title: "Chat" }),
    });
    const directUser = createUserMessage({
      source: { kind: "user" },
      content: [{ type: "text", text: "执行同一请求" }],
    });
    const input: GenerateOptions = {
      provider: "lifeos",
      model: "workflow",
      sessionId: "dsh-retry-prompt" as never,
      messages: [directUser],
    };

    await assert.rejects(
      adapter.stream(input)[Symbol.asyncIterator]().next(),
      (error) => error instanceof LlmError && error.code === "TRANSPORT",
    );
    await state.selectPrompt("dsh-retry-prompt", createSessionCommandId, secondSelection);
    const replayChunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream(input)) replayChunks.push(chunk);
    assert.ok(replayChunks.some((chunk) => chunk.type === "finish"));
    assert.deepEqual(submittedSelections, [firstSelection, firstSelection]);

    const binding = await state.readSession("dsh-retry-prompt");
    const request =
      binding?.currentRequestKey === undefined
        ? undefined
        : binding.requests[binding.currentRequestKey];
    assert.deepEqual(request?.promptSelection, firstSelection);
    assert.deepEqual(binding?.promptSelection, secondSelection);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
