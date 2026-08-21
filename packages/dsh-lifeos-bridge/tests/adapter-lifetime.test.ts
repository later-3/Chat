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
import { TRACE_SCHEMA_VERSION, traceEventSchema, type TraceEventInput } from "@chat/contracts";
import { LifeosLlmAdapter, stableCommandId } from "../src/adapter.ts";
import { ChatProductApiError, type ChatProductClient } from "../src/chat-client.ts";
import {
  dshBridgeSendPreviewSchema,
  promptSelectionRequestSchema,
  workflowSelectionSchema,
  type ChatRun,
} from "../src/contracts.ts";
import { AtomicBridgeStateStore } from "../src/state-store.ts";
import { DshSendReviewCoordinator } from "../src/dsh-send-review.ts";
import { promptTurnPreviewFixture } from "./prompt-turn-preview-fixture.ts";

async function waitForReview(
  coordinator: DshSendReviewCoordinator,
  dshSessionId: string,
): Promise<NonNullable<ReturnType<DshSendReviewCoordinator["current"]>>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const review = coordinator.current(dshSessionId);
    if (review !== null) return review;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("DSH send review did not open");
}

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
    submitFirstMessageFromDispatch: async () => {
      submittedResolve();
      return {
        session: { sessionId: "psn_lifetime1" },
        message: { messageId: "msg_lifetimeuser1", sessionId: "psn_lifetime1" },
        run: waitingRun,
      };
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

test("enabled DSH send review blocks every Chat write until approve and reject writes nothing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-send-review-adapter-"));
  let firstMessageCalls = 0;
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    for (const sessionId of ["dsh-review-approve", "dsh-review-reject"]) {
      await state.setDshSendReviewEnabled(
        sessionId,
        stableCommandId("create-session", sessionId),
        true,
      );
    }
    const coordinator = new DshSendReviewCoordinator(
      state,
      async (dshSessionId, text, adapterRequest) =>
        dshBridgeSendPreviewSchema.parse({
          schemaVersion: "chat-dsh-bridge-send-preview.v2",
          boundary: "dsh_to_lifeos_bridge",
          status: "pre_send_projection",
          workspace: null,
          workflowSelection: null,
          promptSelection: { schemaVersion: "prompt-turn-selection-input.v1", regions: [] },
          promptConfiguration: null,
          promptTurnPreview: promptTurnPreviewFixture(text),
          dshToBridge: {
            adapterRequest,
            userInput: { text, sha256: "a".repeat(64) },
            contextInjections: {
              schemaVersion: "chat-dsh-context-injections.v1",
              dshSessionId,
              status: "ready",
              revision: "b".repeat(64),
              chatForwarding: "not_forwarded",
              items: [],
              totalItems: 0,
              omittedItems: 0,
              totalContentCharacters: 0,
            },
          },
          bridgeToChat: {
            policy: "non_direct_workspace_instructions",
            payload: { text },
            payloadJson: JSON.stringify({ text }, null, 2),
            payloadSha256: "c".repeat(64),
          },
        }),
    );
    const chat = {
      submitFirstMessageFromDispatch: async () => {
        firstMessageCalls += 1;
        return {
          session: { sessionId: "psn_dshreview1" },
          message: { messageId: "msg_dshreviewuser1", sessionId: "psn_dshreview1" },
          run: {
            productRunId: "run_dshreview1",
            status: "succeeded",
            finalMessageId: "msg_dshreviewassistant1",
          } as ChatRun,
        };
      },
      getMessage: async () => ({
        messageId: "msg_dshreviewassistant1",
        role: "assistant",
        content: { format: "markdown", text: "已发送" },
      }),
    } as unknown as ChatProductClient;
    const adapter = new LifeosLlmAdapter(chat, state, undefined, undefined, coordinator);
    const input = (sessionId: string): GenerateOptions => ({
      provider: "lifeos",
      model: "workflow",
      sessionId: sessionId as never,
      messages: [
        createUserMessage({
          source: { kind: "user" },
          content: [{ type: "text", text: "审核真实发送" }],
        }),
      ],
    });

    const approvedNext = adapter.stream(input("dsh-review-approve"))[Symbol.asyncIterator]().next();
    const approvedReview = await waitForReview(coordinator, "dsh-review-approve");
    assert.equal(approvedReview.preview.dshToBridge.adapterRequest.status, "captured");
    if (approvedReview.preview.dshToBridge.adapterRequest.status !== "captured") {
      throw new Error("expected captured DSH request");
    }
    assert.match(approvedReview.preview.dshToBridge.adapterRequest.requestJson, /"messages"/u);
    assert.match(approvedReview.preview.dshToBridge.adapterRequest.requestJson, /审核真实发送/u);
    assert.equal(firstMessageCalls, 0);
    coordinator.decide("dsh-review-approve", approvedReview.reviewId, "approve");
    await approvedNext;
    assert.equal(firstMessageCalls, 1);

    const rejectedNext = adapter.stream(input("dsh-review-reject"))[Symbol.asyncIterator]().next();
    const rejectedReview = await waitForReview(coordinator, "dsh-review-reject");
    coordinator.decide("dsh-review-reject", rejectedReview.reviewId, "reject");
    await assert.rejects(
      rejectedNext,
      (error) => error instanceof LlmError && error.code === "LIFEOS_DSH_SEND_REJECTED",
    );
    assert.equal(firstMessageCalls, 1);
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
      submitFirstMessageFromDispatch: async () => {
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
  const messageCommands: string[] = [];
  let attempts = 0;
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const chat = {
      submitFirstMessageFromDispatch: async (command: { commandId: string }) => {
        messageCommands.push(command.commandId);
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
        return {
          session: { sessionId: "psn_retryturn1" },
          message: { messageId: "msg_retryturnuser1", sessionId: "psn_retryturn1" },
          run: {
            productRunId: "run_retryturn1",
            status: "succeeded",
            finalMessageId: "msg_retryturn1",
          } as ChatRun,
        };
      },
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
    assert.equal(messageCommands.length, 2);
    assert.equal(messageCommands[0], messageCommands[1]);
    const delta = chunks.find((chunk) => chunk.type === "text-delta");
    assert.equal(delta?.type === "text-delta" ? delta.text : undefined, "恢复成功");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("DSH与Bridge Trace独立于审核开关且只记录边界摘要", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-trace-boundary-"));
  const dshEvents: TraceEventInput[] = [];
  const bridgeEvents: TraceEventInput[] = [];
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const chat = {
      submitFirstMessageFromDispatch: async () => ({
        session: { sessionId: "psn_traceadapter1" },
        message: { messageId: "msg_traceadapteruser1", sessionId: "psn_traceadapter1" },
        run: {
          productRunId: "run_traceadapter1",
          status: "succeeded",
          finalMessageId: "msg_traceadapterassistant1",
        } as ChatRun,
      }),
      getMessage: async () => ({
        messageId: "msg_traceadapterassistant1",
        role: "assistant",
        content: { format: "markdown", text: "边界追踪完成" },
      }),
    } as unknown as ChatProductClient;
    const adapter = new LifeosLlmAdapter(
      chat,
      state,
      undefined,
      undefined,
      undefined,
      undefined,
      (event) => dshEvents.push(event),
      (event) => bridgeEvents.push(event),
    );
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream({
      provider: "lifeos",
      model: "workflow",
      sessionId: "dsh-trace-boundary" as never,
      messages: [
        createUserMessage({
          source: { kind: "user" },
          content: [{ type: "text", text: "这段正文不能写入Trace" }],
        }),
      ],
    })) {
      chunks.push(chunk);
    }

    assert.ok(chunks.some((chunk) => chunk.type === "finish"));
    assert.equal(dshEvents.length, 1);
    assert.equal(dshEvents[0]?.eventName, "dsh.adapter_request.captured");
    assert.equal(bridgeEvents.length, 1);
    assert.equal(bridgeEvents[0]?.eventName, "bridge.dispatch.prepared");
    [...dshEvents, ...bridgeEvents].forEach((event, index) =>
      traceEventSchema.parse({
        schemaVersion: TRACE_SCHEMA_VERSION,
        eventId: `evt_boundary${String(index + 1)}`,
        timestamp: "2026-08-21T00:00:00.000Z",
        ...event,
      }),
    );
    assert.doesNotMatch(
      JSON.stringify([...dshEvents, ...bridgeEvents]),
      /这段正文不能写入Trace|边界追踪完成/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown submit outcome never reintroduces DSH Workspace instructions outside Prompt selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-retry-instructions-"));
  const submittedInstructions: unknown[] = [];
  let submitAttempts = 0;
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const chat = {
      submitFirstMessageFromDispatch: async (command: {
        payload: { context?: { workspaceInstructions?: unknown } };
      }) => {
        submittedInstructions.push(command.payload.context?.workspaceInstructions);
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
          session: { sessionId: "psn_retryinstructions1" },
          message: {
            messageId: "msg_retryinstructionsuser1",
            sessionId: "psn_retryinstructions1",
          },
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

    assert.deepEqual(submittedInstructions, [undefined, undefined]);
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
      submitFirstMessageFromDispatch: async (command: {
        payload: { promptSelection?: unknown };
      }) => {
        submittedSelections.push(command.payload.promptSelection);
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
          session: { sessionId: "psn_retryprompt1" },
          message: { messageId: "msg_retrypromptuser1", sessionId: "psn_retryprompt1" },
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
